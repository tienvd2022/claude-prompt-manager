'use strict';

// Trình duyệt Chromium riêng cho mỗi phiên Claude, để anh xem trực tiếp Claude đang test gì trên web.
// Claude nối vào qua CDP (Playwright MCP --cdp-endpoint) ở một cổng proxy do server giữ. Chromium chỉ được bật
// khi có kết nối đầu tiên (Claude dùng trình duyệt hoặc anh mở xem), nên phiên không dùng thì không tốn RAM.
// Cổng proxy lưu ở option @cpm_browser của phiên tmux, restart server vẫn mở lại đúng cổng đó.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const tmux = require('./tmux');

const ENABLED = process.env.CPM_BROWSER !== '0';
const DIR = path.join(__dirname, '..', 'data', 'browser');
const MCP_PACKAGE = process.env.CPM_PLAYWRIGHT_MCP || '@playwright/mcp@latest';
const START_TIMEOUT_MS = 20000;
const SWEEP_MS = 30000;
const VIEW_TICK_MS = 1000;
// Không ai dùng (không có dữ liệu qua proxy, không ai xem) quá chừng này thì tắt Chromium cho đỡ RAM; cần lại thì tự bật.
const IDLE_MS = Number(process.env.CPM_BROWSER_IDLE_MIN || 15) * 60 * 1000;
const MAX_BUFFERED = 2 * 1024 * 1024; // client mạng chậm thì bỏ bớt khung hình thay vì dồn lại

// Lời dặn thêm vào system prompt của Claude.
const PROMPT = 'This session has its own Chromium browser that the user watches live in the web UI. '
  + 'For anything you do in a browser (opening pages, testing UI, screenshots), use the cpm-browser MCP tools. '
  + 'If you write Playwright scripts, connect with chromium.connectOverCDP(process.env.CPM_CDP_URL) and reuse browser.contexts()[0] '
  + 'instead of launching a new browser, so the user can watch it.';

// Đường dẫn Chromium trong thư mục cài của Playwright (npx playwright install ...). Headless shell nhẹ hơn nên ưu tiên.
const CHROME_PATHS = [
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-linux/headless_shell',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];
const SYSTEM_CHROME = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

const browsers = new Map(); // tên phiên -> { name, port, server, chrome: { proc, port } | null, starting, viewers: Set }

function findChrome() {
  if (process.env.CPM_CHROME) return process.env.CPM_CHROME;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')];
  const candidates = [];
  for (const root of roots.filter(Boolean)) {
    let dirs;
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const prefix of ['chromium_headless_shell-', 'chromium-']) {
      const versions = dirs.filter((d) => d.startsWith(prefix)).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
      for (const d of versions) for (const rel of CHROME_PATHS) candidates.push(path.join(root, d, rel));
    }
  }
  return [...candidates, ...SYSTEM_CHROME].find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

const profileDir = (name) => path.join(DIR, name);
const mcpFile = (name) => path.join(DIR, `${name}.mcp.json`);

// Chromium còn sót từ lần chạy server trước (cùng thư mục profile) thì tắt đi, không thì profile bị khóa.
function killStale(profile) {
  let pid;
  try {
    pid = Number(fs.readFileSync(path.join(profile, 'cpm.pid'), 'utf8'));
  } catch {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, stdout) => {
      if (!err && String(stdout).includes(profile)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // đã tắt
        }
      }
      setTimeout(resolve, 200);
    });
  });
}

async function startChrome(b) {
  const exe = findChrome();
  if (!exe) throw new Error('Server chưa có Chromium. Cài bằng: npx playwright install chromium-headless-shell (Linux cần thêm thư viện: npx playwright install-deps chromium)');
  const profile = profileDir(b.name);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  await killStale(profile);
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    '--hide-scrollbars',
    '--mute-audio',
  ];
  if (!/headless/i.test(path.basename(exe))) args.unshift('--headless=new');
  // Ubuntu 24.04 chặn user namespace cho user thường nên sandbox của Chromium không chạy được nếu không có root.
  if (process.platform === 'linux' && process.env.CPM_CHROME_SANDBOX !== '1') args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push('about:blank');

  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  fs.writeFileSync(path.join(profile, 'cpm.pid'), String(proc.pid));
  let exited = false;
  proc.on('exit', () => {
    exited = true;
    if (b.chrome?.proc === proc) b.chrome = null;
  });
  proc.on('error', () => {
    exited = true;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Chromium tắt ngay khi mở: ${stderr.trim().split('\n').slice(-3).join(' ') || 'không rõ lỗi'}`);
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port) return { proc, port };
    } catch {
      // chưa ghi xong file cổng
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('Chromium không lên kịp');
}

function ensureChrome(b) {
  if (b.chrome) return Promise.resolve(b.chrome);
  if (!b.starting) {
    b.starting = startChrome(b)
      .then((chrome) => {
        b.chrome = chrome;
        b.used = Date.now();
        return chrome;
      })
      .finally(() => {
        b.starting = null;
      });
  }
  return b.starting;
}

// Proxy TCP: kết nối tới cổng của phiên thì bật Chromium (nếu chưa) rồi nối thẳng vào cổng DevTools của nó.
// Chromium dựng URL WebSocket theo header Host, nên Playwright vẫn đi qua cổng proxy này.
function listen(b, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.pause();
      sock.on('error', () => {});
      ensureChrome(b).then((chrome) => {
        if (sock.destroyed) return;
        const up = net.connect(chrome.port, '127.0.0.1', () => {
          sock.pipe(up);
          up.pipe(sock);
          sock.resume();
        });
        const touch = () => {
          b.used = Date.now();
        };
        sock.on('data', touch);
        up.on('data', touch);
        up.on('error', () => sock.destroy());
        up.on('close', () => sock.destroy());
        sock.on('close', () => up.destroy());
      }, (err) => {
        console.error(`[browser ${b.name}] ${err.message}`);
        sock.destroy();
      });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      b.server = server;
      b.port = server.address().port;
      resolve(b);
    });
  });
}

function entry(name) {
  return { name, port: 0, server: null, chrome: null, starting: null, viewers: new Set(), used: Date.now() };
}

// Gọi khi tạo phiên Claude mới: giữ một cổng, ghi cấu hình MCP. Trả về những gì cần thêm vào lệnh claude.
async function prepare(name) {
  if (!ENABLED) return null;
  // Máy chưa có Chromium thì không gắn MCP, khỏi tốn RAM cho một tiến trình không dùng được.
  if (!findChrome()) {
    console.warn('[browser] không thấy Chromium, phiên mới không có trình duyệt riêng (npx playwright install chromium-headless-shell)');
    return null;
  }
  drop(name);
  // Tên phiên được dùng lại sau khi phiên cũ kết thúc: phiên mới bắt đầu với profile trống.
  fs.rmSync(profileDir(name), { recursive: true, force: true });
  fs.rmSync(path.join(DIR, `${name}.out`), { recursive: true, force: true });
  const b = await listen(entry(name), 0);
  browsers.set(name, b);
  const endpoint = `http://127.0.0.1:${b.port}`;
  const config = { mcpServers: { 'cpm-browser': { command: 'npx', args: ['-y', MCP_PACKAGE, '--cdp-endpoint', endpoint, '--output-dir', path.join(DIR, `${name}.out`)] } } };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(mcpFile(name), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { port: b.port, mcpConfig: mcpFile(name), prompt: PROMPT, env: { CPM_CDP_URL: endpoint } };
}

function stopChrome(b) {
  const proc = b.chrome?.proc;
  b.chrome = null;
  proc?.kill('SIGKILL');
  for (const ws of b.viewers) ws.close(4001, 'browser-stopped');
}

function drop(name) {
  const b = browsers.get(name);
  if (!b) return;
  browsers.delete(name);
  b.server?.close();
  stopChrome(b);
  fs.rmSync(mcpFile(name), { force: true });
}

function stop(name) {
  const b = browsers.get(name);
  if (b) stopChrome(b);
}

function has(name) {
  return browsers.has(name);
}

// Mở lại proxy cho các phiên còn chạy sau khi restart server; dọn trình duyệt của phiên đã kết thúc.
async function sweep() {
  let list;
  try {
    list = await tmux.list();
  } catch {
    return;
  }
  const alive = new Set(list.map((s) => s.name));
  for (const [name, b] of browsers) {
    if (!alive.has(name)) drop(name);
    else if (b.chrome && !b.viewers.size && Date.now() - b.used > IDLE_MS) stopChrome(b);
  }
  for (const s of list) {
    if (!s.browser || browsers.has(s.name)) continue;
    try {
      browsers.set(s.name, await listen(entry(s.name), Number(s.browser)));
    } catch (err) {
      console.error(`[browser ${s.name}] không mở lại được cổng ${s.browser}: ${err.message}`);
    }
  }
}

function start() {
  if (!ENABLED) return;
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
}

function shutdown() {
  for (const b of browsers.values()) b.chrome?.proc.kill('SIGKILL');
}

// ---------- Xem trực tiếp: chụp màn hình liên tục bằng Page.startScreencast, chuyển chuột/phím ngược lại ----------

class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once('open', () => resolve(new Cdp(ws)));
      ws.once('error', reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else this.handlers.get(msg.method)?.(msg.params);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Mất kết nối tới trang'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Mất kết nối tới trang'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  close() {
    this.ws.close();
  }
}

async function pages(chrome) {
  const res = await fetch(`http://127.0.0.1:${chrome.port}/json/list`);
  return (await res.json()).filter((t) => t.type === 'page');
}

const num = (v, min, max, def = 0) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : def);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const MOUSE_EVENTS = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const KEY_EVENTS = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);
const BUTTONS = new Set(['none', 'left', 'middle', 'right']);

async function view(ws, name) {
  const b = browsers.get(name);
  const send = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  if (!b) return ws.close(4004, 'no-browser');
  b.viewers.add(ws);

  let page = null; // { id, cdp }
  let follow = true; // tự theo trang mới nhất (thường là trang Claude vừa mở)
  let want = null;
  let size = { w: 1280, h: 800 };
  let closed = false;
  let busy = false;

  const cast = () => page?.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: size.w, maxHeight: size.h }).catch(() => {});

  async function switchTo(t) {
    const old = page;
    page = null;
    old?.cdp.close();
    if (!t) return send({ type: 'frame', data: null });
    const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
    if (closed) return cdp.close();
    page = { id: t.id, cdp };
    cdp.on('Page.screencastFrame', (p) => {
      if (ws.bufferedAmount < MAX_BUFFERED) send({ type: 'frame', data: p.data, meta: p.metadata });
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    await cdp.send('Page.enable');
    await cast();
  }

  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      const list = await pages(await ensureChrome(b));
      const next = (!follow && list.find((t) => t.id === want)) || list[0];
      if (!follow && next?.id !== want) follow = true;
      if (next?.id !== page?.id || (page && page.cdp.ws.readyState !== WebSocket.OPEN)) await switchTo(next);
      send({ type: 'pages', list: list.map((t) => ({ id: t.id, title: t.title, url: t.url })), current: page?.id || null, follow });
    } catch (err) {
      send({ type: 'error', message: err.message });
    } finally {
      busy = false;
    }
  }

  const modifiers = (m) => num(m.modifiers, 0, 15) | 0;
  const actions = {
    mouse: (m, cdp) => MOUSE_EVENTS.has(m.event) && cdp.send('Input.dispatchMouseEvent', {
      type: m.event, x: num(m.x, 0, 1e5), y: num(m.y, 0, 1e5), modifiers: modifiers(m),
      button: BUTTONS.has(m.button) ? m.button : 'left', buttons: num(m.buttons, 0, 31) | 0, clickCount: num(m.clickCount, 0, 3, 1) | 0,
    }),
    wheel: (m, cdp) => cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: num(m.x, 0, 1e5), y: num(m.y, 0, 1e5), deltaX: num(m.dx, -1e4, 1e4), deltaY: num(m.dy, -1e4, 1e4), modifiers: modifiers(m),
    }),
    key: (m, cdp) => KEY_EVENTS.has(m.event) && cdp.send('Input.dispatchKeyEvent', {
      type: m.event, key: str(m.key, 40), code: str(m.code, 40), text: str(m.text, 8), unmodifiedText: str(m.text, 8),
      windowsVirtualKeyCode: num(m.keyCode, 0, 255) | 0, modifiers: modifiers(m),
    }),
    text: (m, cdp) => typeof m.text === 'string' && cdp.send('Input.insertText', { text: m.text.slice(0, 10000) }),
    navigate: (m, cdp) => {
      let url = str(m.url, 4000)?.trim();
      if (!url) return;
      if (!/^([a-z][a-z0-9+.-]*:\/\/|(about|data|file|chrome):)/i.test(url)) url = `${/^(localhost|127\.|\[::1\])/.test(url) ? 'http' : 'https'}://${url}`;
      return cdp.send('Page.navigate', { url });
    },
    history: async (m, cdp) => {
      const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory');
      const target = entries[currentIndex + (m.delta < 0 ? -1 : 1)];
      if (target) await cdp.send('Page.navigateToHistoryEntry', { entryId: target.id });
    },
    reload: (m, cdp) => cdp.send('Page.reload'),
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'size') {
      size = { w: num(msg.w, 200, 2560, 1280) | 0, h: num(msg.h, 200, 2560, 800) | 0 };
      return void cast();
    }
    if (msg.type === 'page') {
      follow = !msg.id;
      want = msg.id || null;
      return void tick();
    }
    if (msg.type === 'newpage') {
      if (!b.chrome) return;
      follow = true;
      return void fetch(`http://127.0.0.1:${b.chrome.port}/json/new?about:blank`, { method: 'PUT' }).then(tick, () => {});
    }
    const action = actions[msg.type];
    if (action && page) Promise.resolve(action(msg, page.cdp)).catch((err) => send({ type: 'error', message: err.message }));
  });

  const timer = setInterval(tick, VIEW_TICK_MS);
  ws.on('close', () => {
    closed = true;
    clearInterval(timer);
    b.viewers.delete(ws);
    page?.cdp.close();
  });
  tick();
}

module.exports = { ENABLED, prepare, drop, stop, has, start, shutdown, view, findChrome };

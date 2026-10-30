'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const tmux = require('./tmux');

const PORT = Number(process.env.PORT || 4777);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const COOKIE_NAME = 'cpm_sid';
const MAX_BODY = 16 * 1024;

const authConfig = auth.loadAuthConfig();
const sessions = new auth.SessionStore();
const limiter = new auth.LoginLimiter();
const socketsBySession = new Map(); // id phiên đăng nhập -> Set<WebSocket>

const ROOT = path.join(__dirname, '..');
const STATIC = {
  '/login': ['public/login.html', 'text/html; charset=utf-8'],
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/static/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/static/login.js': ['public/login.js', 'text/javascript; charset=utf-8'],
  '/static/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/static/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
const PUBLIC_PATHS = new Set(['/login', '/static/style.css', '/static/login.js', '/static/favicon.svg']);

function clientIp(req) {
  if (TRUST_PROXY) {
    // Phần tử cuối của X-Forwarded-For là IP do nginx tự thêm, client không giả được.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentSession(req) {
  return sessions.check(parseCookies(req)[COOKIE_NAME]);
}

// Chặn trang web lạ gửi request/mở WebSocket bằng cookie của anh.
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setSecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendStatic(res, rel, type) {
  fs.readFile(path.join(ROOT, rel), (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body quá lớn'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON không hợp lệ'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sessionCookie(value, maxAgeSec) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    COOKIE_SECURE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const wait = limiter.retryAfter(ip);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return sendJson(res, 429, { error: `Sai quá nhiều lần. Thử lại sau ${Math.ceil(wait / 60)} phút.` });
  }
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const userOk = auth.safeEqualStrings(username, authConfig.username);
  const passOk = await auth.verifyPassword(password, authConfig.passwordHash);
  if (!userOk || !passOk) {
    limiter.fail(ip);
    console.warn(`[login] thất bại từ ${ip}`);
    await sleep(500 + Math.random() * 500);
    return sendJson(res, 401, { error: 'Sai tài khoản hoặc mật khẩu' });
  }
  limiter.success(ip);
  const s = sessions.create();
  console.log(`[login] thành công từ ${ip}`);
  res.setHeader('Set-Cookie', sessionCookie(s.token, s.maxAgeSec));
  sendJson(res, 200, { ok: true });
}

function handleLogout(req, res, sid) {
  sessions.destroy(sid);
  for (const ws of socketsBySession.get(sid) || []) ws.close(4001, 'logout');
  socketsBySession.delete(sid);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  sendJson(res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, 200, { sessions: await tmux.list() });
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const created = await tmux.create({ name: body.name, cwd: body.cwd, command: body.command || 'claude' });
      return sendJson(res, 201, created);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const name = decodeURIComponent(m[1]);
    try {
      await tmux.kill(name);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.stderr?.trim() || err.message });
    }
  }
  sendJson(res, 404, { error: 'Không tìm thấy' });
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/');

    if (req.method !== 'GET' && req.method !== 'HEAD' && !originOk(req)) {
      return sendJson(res, 403, { error: 'Origin không hợp lệ' });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);

    const sid = currentSession(req);

    if (url.pathname === '/login' && sid) return redirect(res, '/');
    if (!sid && !PUBLIC_PATHS.has(url.pathname)) {
      return isApi ? sendJson(res, 401, { error: 'Chưa đăng nhập' }) : redirect(res, '/login');
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res, sid);
    if (isApi) return await handleApi(req, res, url);

    const file = STATIC[url.pathname];
    if (file && (req.method === 'GET' || req.method === 'HEAD')) return sendStatic(res, ...file);

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Lỗi server' });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  const reject = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!originOk(req)) return reject(403, 'Forbidden');
    const sid = currentSession(req);
    if (!sid) return reject(401, 'Unauthorized');
    const name = url.searchParams.get('session');
    if (!(await tmux.exists(name))) return reject(404, 'Not Found');
    const cols = clamp(Number(url.searchParams.get('cols')) || 80, 20, 500);
    const rows = clamp(Number(url.searchParams.get('rows')) || 24, 5, 200);
    wss.handleUpgrade(req, socket, head, (ws) => onTerminal(ws, sid, name, cols, rows));
  } catch (err) {
    console.error('[ws upgrade]', err);
    reject(500, 'Internal Server Error');
  }
});

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function onTerminal(ws, sid, name, cols, rows) {
  if (!socketsBySession.has(sid)) socketsBySession.set(sid, new Set());
  socketsBySession.get(sid).add(ws);

  // Gửi phần lịch sử trước, rồi đẩy nó lên vùng cuộn để tmux vẽ lại màn hình hiện tại.
  const past = await tmux.history(name);
  if (past && ws.readyState === ws.OPEN) ws.send(past.replace(/\r?\n/g, '\r\n') + '\r\n'.repeat(rows + 1));

  const term = tmux.attach(name, cols, rows);
  let alive = true;

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    alive = false;
    if (ws.readyState === ws.OPEN) ws.close(4000, 'session-ended');
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!alive) return;
    if (msg.type === 'input' && typeof msg.data === 'string') term.write(msg.data);
    else if (msg.type === 'resize') term.resize(clamp(Number(msg.cols) || cols, 20, 500), clamp(Number(msg.rows) || rows, 5, 200));
  });

  // Ping giữ kết nối qua nginx; đăng xuất thì cắt ngay.
  let pong = true;
  ws.on('pong', () => { pong = true; });
  const timer = setInterval(() => {
    if (!sessions.valid(sid) || !pong) return ws.terminate();
    pong = false;
    ws.ping();
  }, 25000);

  ws.on('close', () => {
    clearInterval(timer);
    socketsBySession.get(sid)?.delete(ws);
    // Chỉ ngắt client khỏi tmux, phiên claude vẫn chạy tiếp.
    if (alive) term.kill();
  });
}

server.listen(PORT, HOST, () => {
  console.log(`claude-prompt-manager chạy tại http://${HOST}:${PORT} (tmux socket: ${tmux.SOCKET})`);
});

function shutdown() {
  for (const ws of wss.clients) ws.close(1001, 'server-restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Đọc .env ở thư mục gốc (nếu có) trước khi các module khác đọc process.env.
// Biến đã có sẵn trong môi trường (systemd, dòng lệnh) được ưu tiên hơn .env.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const { WebSocketServer } = require('ws');
const auth = require('./auth');
const browser = require('./browser');
const files = require('./files');
const git = require('./git');
const preview = require('./preview');
const commands = require('./commands');
const gitAccounts = require('./gitaccounts');
const projects = require('./projects');
const queue = require('./queue');
const tmux = require('./tmux');
const { unwrap } = require('./unwrap');

const PORT = Number(process.env.PORT || 4777);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const COOKIE_NAME = 'cpm_sid';
const MAX_BODY = 16 * 1024;
const QUEUE_BODY = 256 * 1024; // một prompt trong hàng đợi (tối đa 100 KB chữ, tính cả escape JSON)
const QUEUE_LIST_BODY = 8 * 1024 * 1024; // cả hàng đợi khi sửa/đổi thứ tự

const authConfig = auth.loadAuthConfig();
const sessions = new auth.SessionStore();
const limiter = new auth.LoginLimiter();
const socketsBySession = new Map(); // id phiên đăng nhập -> Set<WebSocket>

const ROOT = path.join(__dirname, '..');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC = {
  '/login': ['public/login.html', 'text/html; charset=utf-8'],
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
// Mọi file .js/.css/.svg trong public/ được phục vụ ở /static/<tên>.
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) {
  if (TYPES[path.extname(f)]) STATIC[`/static/${f}`] = [`public/${f}`, TYPES[path.extname(f)]];
}
const PUBLIC_PATHS = new Set(['/login', '/static/style.css', '/static/login.js', '/static/favicon.svg']);
// Script dùng trong trang preview (chạy ở origin sandbox, không có cookie): công khai, không chứa gì riêng tư.
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'preview-lib'))) {
  if (!TYPES[path.extname(f)]) continue;
  STATIC[`/preview-lib/${f}`] = [`public/preview-lib/${f}`, TYPES[path.extname(f)]];
  PUBLIC_PATHS.add(`/preview-lib/${f}`);
}

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

function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
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

// ---------- API ----------

const FS_ERRORS = { ENOENT: [404, 'Không tìm thấy'], EACCES: [403, 'Không có quyền'], EPERM: [403, 'Không có quyền'], EEXIST: [409, 'Đã tồn tại'], ENOTDIR: [400, 'Không phải thư mục'], EISDIR: [400, 'Là thư mục'], ENOTEMPTY: [409, 'Thư mục không trống'] };

function apiError(res, err) {
  if (err.status) return sendJson(res, err.status, { error: err.message });
  if (FS_ERRORS[err.code]) return sendJson(res, FS_ERRORS[err.code][0], { error: FS_ERRORS[err.code][1] });
  throw err;
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), handler });
}

async function projectsWithSessions() {
  const [list, all] = await Promise.all([projects.list(), tmux.list()]);
  for (const p of list) p.sessions = all.filter((s) => s.project === p.name).length;
  // Thư mục mở thêm (ngoài thư mục dự án) chỉ hiện khi còn phiên đang chạy; muốn vào lại thì mở bằng 📂.
  return list.filter((p) => !p.linked || p.sessions);
}

route('GET', '/api/projects', async (req, res) => sendJson(res, 200, { projects: await projectsWithSessions(), root: projects.PROJECTS_DIR }));
route('POST', '/api/projects', async (req, res) => {
  const body = await readJson(req);
  if (body.repo) {
    // Tạo repo mới trên GitHub qua tài khoản (alias SSH) đã chọn rồi clone về.
    projects.checkNewName(body.name);
    const url = await gitAccounts.createRepo({ ...body.repo, name: body.name });
    return sendJson(res, 202, { job: git.clone(body.name, url), url });
  }
  if (body.gitUrl) return sendJson(res, 202, { job: git.clone(body.name, body.gitUrl) });
  return sendJson(res, 201, projects.create(body.name));
});

route('GET', '/api/browse', async (req, res, url) => sendJson(res, 200, await projects.browse(url.searchParams.get('path'), { hidden: url.searchParams.get('hidden') === '1' })));
route('POST', '/api/projects/open', async (req, res) => sendJson(res, 200, projects.open((await readJson(req)).path)));
route('GET', '/api/projects/linked', async (req, res) => {
  const [list, all] = await Promise.all([projects.list(), tmux.list()]);
  const linked = list.filter((p) => p.linked);
  for (const p of linked) p.sessions = all.filter((s) => s.project === p.name).length;
  sendJson(res, 200, { projects: linked });
});
route('DELETE', '/api/projects/:p/link', async (req, res, p) => {
  if ((await tmux.list()).some((s) => s.project === p)) throw projects.httpError(409, 'Dự án còn phiên đang chạy, kết thúc phiên trước');
  projects.unlink(p);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/sessions', async (req, res) => sendJson(res, 200, { sessions: await tmux.list() }));
route('DELETE', '/api/sessions/:name', async (req, res, name) => {
  if (!tmux.validName(name)) return sendJson(res, 400, { error: 'Tên phiên không hợp lệ' });
  await tmux.kill(name).catch((err) => {
    throw projects.httpError(400, err.stderr?.trim() || err.message);
  });
  queue.drop(name);
  browser.drop(name);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/projects/:p/sessions', async (req, res, p) => {
  projects.projectDir(p);
  const list = (await tmux.list()).filter((s) => s.project === p);
  sendJson(res, 200, { sessions: list.map((s) => ({ ...s, queued: queue.get(s.name).length })) });
});

async function sessionOr404(name) {
  if (!(await tmux.exists(name))) throw projects.httpError(404, 'Không có phiên này');
}
route('GET', '/api/claude-aliases', async (req, res) => sendJson(res, 200, { aliases: tmux.aliases() }));
route('PATCH', '/api/sessions/:name', async (req, res, name) => {
  await sessionOr404(name);
  try {
    await tmux.setTitle(name, (await readJson(req)).title);
  } catch (err) {
    throw projects.httpError(400, err.stderr?.trim() || err.message);
  }
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/sessions/:name/text', async (req, res, name, url) => {
  await sessionOr404(name);
  // ?ansi=1: giữ màu và đúng từng dòng như trên terminal, để hiện giống terminal (không nối dòng).
  if (url.searchParams.get('ansi') === '1') return sendJson(res, 200, { text: await tmux.history(name, 10000, { plain: true, colors: true }) });
  const text = await tmux.history(name, 10000, { plain: true });
  // Phiên Claude: nối lại các dòng Claude tự ngắt theo độ rộng màn hình lúc in.
  const kind = (await tmux.list()).find((s) => s.name === name)?.kind;
  sendJson(res, 200, { text: kind === 'shell' ? text : unwrap(text) });
});
route('DELETE', '/api/sessions/:name/browser', async (req, res, name) => {
  await sessionOr404(name);
  browser.stop(name);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/sessions/:name/queue', async (req, res, name) => {
  await sessionOr404(name);
  sendJson(res, 200, { items: queue.get(name) });
});
route('POST', '/api/sessions/:name/queue', async (req, res, name) => {
  await sessionOr404(name);
  sendJson(res, 201, { items: queue.add(name, (await readJson(req, QUEUE_BODY)).text) });
});
route('PUT', '/api/sessions/:name/queue', async (req, res, name) => {
  await sessionOr404(name);
  sendJson(res, 200, { items: queue.update(name, (await readJson(req, QUEUE_LIST_BODY)).items) });
});
route('POST', '/api/sessions/:name/queue/next', async (req, res, name) => {
  await sessionOr404(name);
  const sent = await queue.sendNext(name);
  sendJson(res, 200, { sent: !!sent, items: queue.get(name) });
});
route('POST', '/api/projects/:p/sessions', async (req, res, p) => {
  const body = await readJson(req);
  const cwd = projects.projectDir(p);
  try {
    sendJson(res, 201, await tmux.create({ project: p, cwd, command: body.command || 'claude', alias: body.alias, bypass: body.bypass === true, args: body.args, prepare: browser.prepare, prompt: preview.PROMPT }));
  } catch (err) {
    throw projects.httpError(400, err.stderr?.trim() || err.message);
  }
});

route('GET', '/api/projects/:p/files', async (req, res, p, url) => sendJson(res, 200, await files.listDir(p, url.searchParams.get('path'))));
route('GET', '/api/projects/:p/download', async (req, res, p, url) => files.download(res, p, url.searchParams.get('path')));
// Link tải dùng một lần cho app mobile: phần native tải file không có cookie đăng nhập của WebView.
const DOWNLOAD_TICKET_MS = 60 * 1000;
const downloadTickets = new Map(); // token -> { project, path, expires }
route('POST', '/api/projects/:p/download-ticket', async (req, res, p) => {
  const body = await readJson(req);
  projects.projectDir(p);
  const now = Date.now();
  for (const [t, v] of downloadTickets) if (v.expires < now) downloadTickets.delete(t);
  const token = crypto.randomBytes(32).toString('base64url');
  downloadTickets.set(token, { project: p, path: typeof body.path === 'string' ? body.path : '', expires: now + DOWNLOAD_TICKET_MS });
  sendJson(res, 201, { url: `/api/download/${token}` });
});

async function handleTicketDownload(res, token) {
  const ticket = downloadTickets.get(token);
  downloadTickets.delete(token);
  if (!ticket || ticket.expires < Date.now()) return sendJson(res, 404, { error: 'Link tải đã hết hạn' });
  try {
    await files.download(res, ticket.project, ticket.path);
  } catch (err) {
    apiError(res, err);
  }
}

route('POST', '/api/projects/:p/upload', async (req, res, p, url) => {
  const q = url.searchParams;
  sendJson(res, 201, await files.upload(req, p, q.get('path'), q.get('name'), q.get('overwrite') === '1'));
});
route('POST', '/api/projects/:p/paste', async (req, res, p) => sendJson(res, 201, await files.savePaste(req, p)));
route('POST', '/api/projects/:p/mkdir', async (req, res, p) => {
  const body = await readJson(req);
  await files.mkdir(p, body.path, body.name);
  sendJson(res, 201, { ok: true });
});
route('POST', '/api/projects/:p/rename', async (req, res, p) => {
  const body = await readJson(req);
  await files.rename(p, body.path, body.name);
  sendJson(res, 200, { ok: true });
});
route('DELETE', '/api/projects/:p/files', async (req, res, p, url) => {
  await files.remove(p, url.searchParams.get('path'));
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/projects/:p/image', async (req, res, p, url) => files.image(res, p, url.searchParams.get('path')));
route('GET', '/api/projects/:p/text', async (req, res, p, url) => sendJson(res, 200, await files.readText(p, url.searchParams.get('path'))));
route('PUT', '/api/projects/:p/text', async (req, res, p) => {
  const body = await readJson(req, files.MAX_TEXT * 2 + 4096);
  sendJson(res, 200, await files.writeText(p, body.path, body.text, body.mtime));
});

route('GET', '/api/projects/:p/commands', async (req, res, p, url) => {
  const alias = url.searchParams.get('alias') || '';
  const known = tmux.aliases().find((a) => a.name === alias);
  sendJson(res, 200, { commands: commands.list(files.resolve(p, '').root, known?.name, known?.configDir) });
});
route('POST', '/api/projects/:p/preview/ticket', async (req, res, p, url, sid) => sendJson(res, 200, { base: `/preview/${preview.ticket(p, sid)}/` }));
route('GET', '/api/projects/:p/preview/list', async (req, res, p) => sendJson(res, 200, preview.list(p)));
route('GET', '/api/projects/:p/preview/stat', async (req, res, p, url) => sendJson(res, 200, preview.stat(p, url.searchParams.get('path'))));
route('POST', '/api/projects/:p/preview/pdf', async (req, res, p, url, sid) => sendJson(res, 200, await preview.pdf(p, sid, (await readJson(req)).path)));
route('POST', '/api/projects/:p/preview/shot', async (req, res, p, url, sid) => {
  const png = await preview.shot(p, sid, await readJson(req));
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
  res.end(png);
});

route('GET', '/api/projects/:p/git/status', async (req, res, p) => sendJson(res, 200, await git.status(p)));
route('GET', '/api/projects/:p/git/log', async (req, res, p) => sendJson(res, 200, { commits: await git.log(p) }));
route('GET', '/api/projects/:p/git/show', async (req, res, p, url) => sendJson(res, 200, { text: await git.show(p, url.searchParams.get('hash')) }));
route('GET', '/api/projects/:p/git/diff', async (req, res, p, url) => {
  sendJson(res, 200, { text: await git.diff(p, url.searchParams.get('path'), url.searchParams.get('untracked') === '1') });
});
route('GET', '/api/projects/:p/git/branches', async (req, res, p) => sendJson(res, 200, await git.branches(p)));
route('POST', '/api/projects/:p/git/checkout', async (req, res, p) => sendJson(res, 200, { output: await git.checkout(p, await readJson(req)) }));
route('GET', '/api/projects/:p/git/commit-files', async (req, res, p, url) => sendJson(res, 200, await git.commitFiles(p, url.searchParams.get('hash'))));
route('GET', '/api/projects/:p/git/commit-diff', async (req, res, p, url) => {
  const q = url.searchParams;
  sendJson(res, 200, { text: await git.commitDiff(p, q.get('hash'), q.get('path'), q.get('from') || null) });
});
route('GET', '/api/projects/:p/git/file', async (req, res, p, url) => {
  sendJson(res, 200, { text: await git.fileAt(p, url.searchParams.get('rev'), url.searchParams.get('path')) });
});
route('GET', '/api/projects/:p/git/image', async (req, res, p, url) => {
  const file = url.searchParams.get('path');
  if (!files.imageType(file || '')) throw projects.httpError(415, 'Không phải file ảnh');
  files.sendImage(res, file, await git.rawAt(p, url.searchParams.get('rev'), file));
});
route('POST', '/api/projects/:p/git/init', async (req, res, p) => sendJson(res, 200, { output: await git.init(p) }));
route('POST', '/api/projects/:p/git/commit', async (req, res, p) => {
  const body = await readJson(req);
  sendJson(res, 200, { output: await git.commitAll(p, body.message) });
});
route('POST', '/api/projects/:p/git/remote', async (req, res, p) => sendJson(res, 200, await git.setRemote(p, (await readJson(req)).url)));
// Tự đồng bộ pull bị xung đột: mở một phiên Claude riêng để xử lý, khóa dự án tới khi merge được commit
// (git.status tự mở khóa khi hết MERGE_HEAD). Web tự push sau đó, Claude không push.
route('POST', '/api/projects/:p/git/resolve', async (req, res, p) => {
  const st = await git.status(p);
  if (!st.merging) throw projects.httpError(400, 'Không có merge nào đang dở');
  const files = await git.conflictFiles(p);
  let created;
  try {
    created = await tmux.create({ project: p, cwd: projects.projectDir(p), command: 'claude', prepare: browser.prepare, prompt: preview.PROMPT });
    await tmux.setTitle(created.name, 'Xử lý xung đột');
  } catch (err) {
    throw projects.httpError(400, err.stderr?.trim() || err.message);
  }
  queue.add(created.name, conflictPrompt(st, files));
  sendJson(res, 200, { session: created.name, lock: git.lockProject(p, 'conflict', { session: created.name }) });
});
route('DELETE', '/api/projects/:p/git/lock', async (req, res, p) => {
  // Bỏ khóa thì Claude chưa nhận prompt xử lý xung đột cũng không nhận nữa.
  const lock = git.unlockProject(p);
  if (lock?.session) queue.drop(lock.session);
  sendJson(res, 200, { ok: true });
});

function conflictPrompt(st, files) {
  return [
    `Tự đồng bộ vừa git pull (merge ${st.upstream || 'nhánh remote'} vào ${st.branch}) và bị xung đột${files.length ? ' ở các file:' : '.'}`,
    ...files.map((f) => `- ${f}`),
    '',
    'Hãy xử lý xung đột này ngay: đọc thay đổi của cả hai phía (git diff, git log --merge), giữ đúng ý của cả hai bên, xóa hết dấu <<<<<<< ======= >>>>>>>, chạy test/build nếu dự án có.',
    'Xong thì git add các file đó và git commit --no-edit để hoàn tất merge.',
    'Không push (web tự push sau khi merge xong), không đổi nhánh. Chỉ git merge --abort nếu thật sự không xử lý được, khi đó dừng lại và giải thích lý do.',
  ].join('\n');
}
route('POST', '/api/projects/:p/git/:op', async (req, res, p, op) => sendJson(res, 202, { job: await git.remoteOp(p, op) }));
route('GET', '/api/jobs/:id', async (req, res, id) => sendJson(res, 200, { job: git.getJob(id) }));

route('GET', '/api/git/config', async (req, res) => sendJson(res, 200, await git.getConfig()));
route('POST', '/api/git/config', async (req, res) => sendJson(res, 200, await git.setConfig(await readJson(req))));
route('GET', '/api/git/accounts', async (req, res) => sendJson(res, 200, { accounts: gitAccounts.list() }));
route('POST', '/api/git/accounts', async (req, res) => sendJson(res, 201, await gitAccounts.add(await readJson(req))));
route('PATCH', '/api/git/accounts/:alias', async (req, res, alias) => sendJson(res, 200, await gitAccounts.update(alias, await readJson(req))));
route('DELETE', '/api/git/accounts/:alias', async (req, res, alias) => sendJson(res, 200, gitAccounts.remove(alias)));
route('GET', '/api/git/accounts/:alias/check', async (req, res, alias) => sendJson(res, 200, await gitAccounts.check(alias)));
route('POST', '/api/git/accounts/:alias/key', async (req, res, alias) => sendJson(res, 201, await gitAccounts.createKey(alias)));
route('POST', '/api/git/tokens', async (req, res) => sendJson(res, 200, await gitAccounts.saveToken(await readJson(req))));

async function handleApi(req, res, url, sid) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    let params;
    try {
      params = m.slice(1).map(decodeURIComponent);
    } catch {
      return sendJson(res, 400, { error: 'URL không hợp lệ' });
    }
    try {
      return await r.handler(req, res, ...params, url, sid);
    } catch (err) {
      return apiError(res, err);
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

    const ticket = url.pathname.match(/^\/api\/download\/([\w-]+)$/);
    if (ticket && req.method === 'GET') return await handleTicketDownload(res, ticket[1]);

    const pv = url.pathname.match(/^\/preview\/([\w-]{20,})\/(.*)$/);
    if (pv && (req.method === 'GET' || req.method === 'HEAD')) {
      let rel;
      try {
        rel = decodeURIComponent(pv[2]);
      } catch {
        return sendJson(res, 400, { error: 'URL không hợp lệ' });
      }
      return await preview.serve(req, res, pv[1], rel, (s) => sessions.valid(s));
    }

    const sid = currentSession(req);

    if (url.pathname === '/login' && sid) return redirect(res, '/');
    if (!sid && !PUBLIC_PATHS.has(url.pathname)) {
      return isApi ? sendJson(res, 401, { error: 'Chưa đăng nhập' }) : redirect(res, '/login');
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res, sid);
    if (isApi) return await handleApi(req, res, url, sid);

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
    if (url.pathname !== '/ws' && url.pathname !== '/ws/browser') return reject(404, 'Not Found');
    if (!originOk(req)) return reject(403, 'Forbidden');
    const sid = currentSession(req);
    if (!sid) return reject(401, 'Unauthorized');
    const name = url.searchParams.get('session');
    if (!(await tmux.exists(name))) return reject(404, 'Not Found');
    if (url.pathname === '/ws/browser') return wss.handleUpgrade(req, socket, head, (ws) => onBrowser(ws, sid, name));
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

// Xem trình duyệt của phiên; ping giữ kết nối và cắt khi đăng xuất như terminal.
function onBrowser(ws, sid, name) {
  let pong = true;
  ws.on('pong', () => { pong = true; });
  const timer = setInterval(() => {
    if (!sessions.valid(sid) || !pong) return ws.terminate();
    pong = false;
    ws.ping();
  }, 25000);
  ws.on('close', () => clearInterval(timer));
  browser.view(ws, name);
}

projects.ensureRoot();
queue.start();
browser.start();
preview.setBase(HOST, PORT);
server.listen(PORT, HOST, () => {
  console.log(`claude-prompt-manager chạy tại http://${HOST}:${PORT} (tmux socket: ${tmux.SOCKET}, dự án: ${projects.PROJECTS_DIR})`);
});

function shutdown() {
  browser.shutdown();
  for (const ws of wss.clients) ws.close(1001, 'server-restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

'use strict';

// Khung Preview: hiện file HTML/SVG của dự án (Claude viết design, slide, mockup) ngay trong app, tự tải lại khi file đổi.
// File được phục vụ ở /preview/<token>/<đường dẫn> với CSP sandbox: trang chạy ở origin riêng (opaque),
// script trong trang không dùng được cookie đăng nhập để gọi /api, không đụng được terminal hay git.
// Token thay cho cookie (trang sandbox không gửi cookie), chỉ đọc được file của đúng một dự án, hết hạn khi đăng xuất.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { httpError } = require('./projects');
const files = require('./files');
const { findChrome } = require('./browser');

const DIR = '.cpm/preview'; // nơi Claude được dặn ghi file preview
const TICKET_MS = 12 * 3600 * 1000;
const MAX_HTML = 20 * 1024 * 1024;
const PAGE_RE = /\.(html?|svg)$/i;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf',
};
// Script chèn vào mọi trang HTML: chọn phần tử để góp ý, báo slide đang xem cho app.
const INJECT = '<script src="/preview-lib/inspect.js"></script>';
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock; frame-ancestors 'self'";

const tickets = new Map(); // token -> { project, sid, expires }

function ticket(project, sid) {
  files.resolve(project, ''); // dự án phải có thật
  const now = Date.now();
  for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
  for (const [t, v] of tickets) {
    if (v.project === project && v.sid === sid) {
      v.expires = now + TICKET_MS;
      return t;
    }
  }
  const token = crypto.randomBytes(32).toString('base64url');
  tickets.set(token, { project, sid, expires: now + TICKET_MS });
  return token;
}

// valid(sid): phiên đăng nhập còn hiệu lực không (đăng xuất là link preview chết luôn).
async function serve(req, res, token, rel, valid) {
  const t = tickets.get(token);
  if (!t || t.expires < Date.now() || !valid(t.sid)) {
    tickets.delete(token);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Link preview đã hết hạn, mở lại khung Preview trong app.');
  }
  t.expires = Date.now() + TICKET_MS;
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', SANDBOX);
  // Trang sandbox có origin "null": module script, fetch file cùng thư mục là request CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');
  let full;
  try {
    ({ full } = files.resolve(t.project, rel));
    if (fs.statSync(full).isDirectory()) ({ full } = files.resolve(t.project, path.posix.join(rel, 'index.html')));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không tìm thấy file');
  }
  const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
  const st = fs.statSync(full);
  if (/^text\/html/.test(type) && st.size <= MAX_HTML) {
    let html = await fs.promises.readFile(full, 'utf8');
    // Chèn sau <head> (hoặc đầu trang) để chạy trước script của trang.
    const m = html.match(/<head[^>]*>/i);
    html = m ? html.replace(m[0], `${m[0]}${INJECT}`) : INJECT + html;
    res.writeHead(200, { 'Content-Type': type });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

// Thời điểm sửa mới nhất của file và các file đi kèm cùng thư mục (css, js, ảnh), để biết khi nào tải lại.
function stat(project, rel) {
  const { full } = files.resolve(project, rel);
  let mtime = fs.statSync(full).mtimeMs;
  const dir = path.dirname(full);
  let names = [];
  try {
    names = fs.readdirSync(dir).slice(0, 500);
  } catch {
    // không đọc được thư mục thì chỉ tính file chính
  }
  for (const n of names) {
    if (PAGE_RE.test(n) && n !== path.basename(full)) continue; // trang khác trong cùng thư mục không liên quan
    const s = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
    if (s?.isFile() && s.mtimeMs > mtime) mtime = s.mtimeMs;
  }
  return { mtime };
}

// Các file trong .cpm/preview (Claude tạo), mới nhất trước.
function list(project) {
  const { root } = files.resolve(project, '');
  const dir = path.join(root, DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { dir: DIR, files: [] };
  }
  files.excludeCpm(root);
  const out = [];
  for (const n of names) {
    if (!PAGE_RE.test(n)) continue;
    const s = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
    if (s?.isFile()) out.push({ path: `${DIR}/${n}`, mtime: s.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { dir: DIR, files: out.slice(0, 50) };
}

// ---------- Chromium headless: xuất PDF, chụp ảnh trang ----------

function runChrome(args) {
  const exe = findChrome();
  if (!exe) throw httpError(501, 'Server chưa có Chromium. Cài bằng: npx playwright install chromium-headless-shell');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-preview-'));
  const all = [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    // Đợi script/CDN (Tailwind, React…) chạy xong rồi mới in/chụp.
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=8000',
    ...(process.platform === 'linux' && process.env.CPM_CHROME_SANDBOX !== '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...args,
  ];
  if (!/headless/i.test(path.basename(exe))) all.unshift('--headless=new');
  return new Promise((resolve, reject) => {
    execFile(exe, all, { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      fs.rmSync(profile, { recursive: true, force: true });
      if (err) reject(httpError(500, `Chromium lỗi: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
}

const pageUrl = (base, token, rel, hash) => `${base}/preview/${token}/${rel.split('/').map(encodeURIComponent).join('/')}${hash ? `#${hash}` : ''}`;

// In trang ra PDF, lưu cạnh file gốc (deck.html -> deck.pdf). Slide dùng slides.js tự xếp mỗi slide một trang.
async function pdf(project, sid, rel) {
  const { rel: clean, full } = files.resolve(project, rel);
  if (!/\.html?$/i.test(clean)) throw httpError(400, 'Chỉ xuất PDF được từ file HTML');
  const out = full.replace(/\.html?$/i, '.pdf');
  await runChrome(['--no-pdf-header-footer', '--print-to-pdf-no-header', `--print-to-pdf=${out}`, pageUrl(base(), ticket(project, sid), clean)]);
  if (!fs.existsSync(out)) throw httpError(500, 'Chromium không tạo được file PDF');
  return { path: clean.replace(/\.html?$/i, '.pdf') };
}

// Chụp ảnh trang ở đúng khổ đang xem, để vẽ/khoanh lên rồi gửi cho Claude.
async function shot(project, sid, { path: rel, width, height, hash } = {}) {
  const { rel: clean } = files.resolve(project, rel);
  const w = Math.max(200, Math.min(2400, Math.round(Number(width) || 1280)));
  const h = Math.max(200, Math.min(2400, Math.round(Number(height) || 800)));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpm-shot-')), 'shot.png');
  try {
    await runChrome([`--window-size=${w},${h}`, `--screenshot=${out}`, pageUrl(base(), ticket(project, sid), clean, /^\d{1,4}$/.test(String(hash)) ? hash : '')]);
    return await fs.promises.readFile(out);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

let baseUrl = 'http://127.0.0.1';
const base = () => baseUrl;
function setBase(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  baseUrl = `http://${h}:${port}`;
}

// Lời dặn thêm vào system prompt của mọi phiên Claude.
const PROMPT = 'The user has a live Preview pane in the web UI next to this terminal. '
  + `When asked for anything visual (UI design, mockup, prototype, landing page, poster, diagram, slide deck), write it as a self-contained HTML file in ${DIR}/ `
  + `of the project (e.g. ${DIR}/landing.html); the pane opens it automatically and reloads every time the file (or a css/js/image file next to it) changes. `
  + 'Libraries may be loaded from CDNs (e.g. <script src="https://cdn.tailwindcss.com"></script>, React + Babel standalone from unpkg). '
  + 'For slides, add <script src="/preview-lib/slides.js"></script> and put each slide in a top-level <section> of <body>: '
  + 'each slide is a 1280x720 canvas, and the pane adds navigation, fullscreen and PDF export. '
  + 'Feedback from the pane arrives as prompts that quote a CSS selector and the element text, or as an attached image with the user\'s drawing.';

module.exports = { DIR, PROMPT, ticket, serve, stat, list, pdf, shot, setBase, base };

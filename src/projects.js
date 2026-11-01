'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Mọi dự án nằm trong một thư mục, mỗi dự án là một thư mục con.
const PROJECTS_DIR = path.resolve(expandHome(process.env.PROJECTS_DIR || '~/projects'));
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Thư mục nằm ngoài PROJECTS_DIR (hoặc thư mục con) anh mở bằng "Mở thư mục": lưu { tên: đường dẫn tuyệt đối }.
const LINKS_FILE = path.join(__dirname, '..', 'data', 'projects.json');
const BROWSE_MAX = 2000;

function loadLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveLinks(links) {
  fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${LINKS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, LINKS_FILE);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function ensureRoot() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true, mode: 0o700 });
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function checkNewName(name) {
  if (!validName(name)) throw httpError(400, 'Tên dự án chỉ gồm chữ, số, ".", "-", "_" (tối đa 64 ký tự)');
  if (fs.existsSync(path.join(PROJECTS_DIR, name)) || loadLinks()[name]) throw httpError(409, `Dự án "${name}" đã tồn tại`);
}

function projectDir(name) {
  if (!validName(name)) throw httpError(400, 'Tên dự án không hợp lệ');
  const dir = loadLinks()[name] || path.join(PROJECTS_DIR, name);
  const st = fs.statSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw httpError(404, `Không có dự án "${name}"`);
  return dir;
}

function readBranch(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}

async function list() {
  ensureRoot();
  const entries = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !validName(e.name)) continue;
    const dir = path.join(PROJECTS_DIR, e.name);
    const st = await fs.promises.stat(dir);
    const git = fs.existsSync(path.join(dir, '.git'));
    out.push({ name: e.name, mtime: st.mtimeMs, git, branch: git ? readBranch(dir) : null });
  }
  for (const [name, dir] of Object.entries(loadLinks())) {
    if (out.some((p) => p.name === name)) continue;
    const st = await fs.promises.stat(dir).catch(() => null);
    const git = !!st && fs.existsSync(path.join(dir, '.git'));
    out.push({ name, path: dir, linked: true, missing: !st, mtime: st?.mtimeMs || 0, git, branch: git ? readBranch(dir) : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Tên dự án cho thư mục mở thêm: tên thư mục, trùng thì ghép tên thư mục cha, rồi thêm số.
function linkName(dir, taken) {
  const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56);
  const base = slug(path.basename(dir)) || 'thu-muc';
  const parent = slug(path.basename(path.dirname(dir)));
  for (const name of [base, parent && `${parent}-${base}`.slice(0, 60)].filter(Boolean)) if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

// Mở một thư mục bất kỳ làm dự án. Thư mục con trực tiếp của PROJECTS_DIR thì dùng luôn tên của nó.
function open(input) {
  if (typeof input !== 'string' || !input.trim()) throw httpError(400, 'Thiếu đường dẫn');
  const dir = fs.realpathSync(path.resolve(expandHome(input.trim())));
  if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Không phải thư mục');
  const root = fs.realpathSync(PROJECTS_DIR);
  if (path.dirname(dir) === root && validName(path.basename(dir))) return { name: path.basename(dir) };
  const links = loadLinks();
  const found = Object.keys(links).find((n) => links[n] === dir);
  if (found) return { name: found };
  const name = linkName(dir, (n) => !!links[n] || fs.existsSync(path.join(PROJECTS_DIR, n)));
  links[name] = dir;
  saveLinks(links);
  return { name };
}

// Bỏ thư mục mở thêm khỏi danh sách gần đây (không xóa gì trên đĩa).
function unlink(name) {
  const links = loadLinks();
  if (!links[name]) throw httpError(404, `"${name}" không phải thư mục mở thêm`);
  delete links[name];
  saveLinks(links);
}

// Liệt kê thư mục con để chọn thư mục mở làm dự án.
async function browse(input, { hidden = false } = {}) {
  const dir = path.resolve(expandHome(typeof input === 'string' && input.trim() ? input.trim() : PROJECTS_DIR));
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!hidden && e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.promises.stat(full).catch(() => null))?.isDirectory());
    if (!isDir) continue;
    dirs.push({ name: e.name, git: fs.existsSync(path.join(full, '.git')) });
    if (dirs.length >= BROWSE_MAX) break;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), root: PROJECTS_DIR, git: fs.existsSync(path.join(dir, '.git')), dirs };
}

function create(name) {
  ensureRoot();
  checkNewName(name);
  fs.mkdirSync(path.join(PROJECTS_DIR, name), { mode: 0o755 });
  return { name };
}

// Đổi tên thư mục dự án trong PROJECTS_DIR. Thư mục mở thêm (ở ngoài) thì không đổi tên trên đĩa.
function rename(name, newName) {
  if (!validName(name)) throw httpError(400, 'Tên dự án không hợp lệ');
  if (loadLinks()[name]) throw httpError(400, 'Thư mục mở thêm (ngoài thư mục dự án) không đổi tên được ở đây');
  const dir = projectDir(name);
  if (newName === name) return { name };
  // Chỉ khác hoa/thường: kiểm tra trùng trừ chính nó (hệ file không phân biệt hoa thường).
  if (newName.toLowerCase() === name.toLowerCase()) {
    if (!validName(newName)) throw httpError(400, 'Tên dự án chỉ gồm chữ, số, ".", "-", "_" (tối đa 64 ký tự)');
  } else {
    checkNewName(newName);
  }
  fs.renameSync(dir, path.join(PROJECTS_DIR, newName));
  return { name: newName };
}

module.exports = { PROJECTS_DIR, httpError, ensureRoot, validName, checkNewName, projectDir, list, create, open, unlink, rename, browse };

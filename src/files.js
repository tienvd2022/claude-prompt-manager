'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpError, projectDir, PROJECTS_DIR, ensureRoot, checkNewName } = require('./projects');

const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const MAX_ENTRIES = 5000;
const HIDDEN = new Set(['.git']);

function inside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

function realpathOr404(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    throw httpError(404, 'Không tìm thấy file hoặc thư mục');
  }
}

function checkEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw httpError(400, 'Tên file không hợp lệ');
  }
  return name;
}

// Đổi đường dẫn tương đối trong dự án thành đường dẫn thật, không cho thoát ra ngoài dự án
// (kể cả qua symlink). follow=false thì không đi theo symlink ở phần tử cuối (dùng khi xóa/đổi tên).
function resolve(project, rel, { follow = true, mustExist = true } = {}) {
  const root = fs.realpathSync(projectDir(project));
  if (typeof rel !== 'string') rel = '';
  if (rel.includes('\0')) throw httpError(400, 'Đường dẫn không hợp lệ');
  const clean = path.posix.normalize('/' + rel.replace(/\\/g, '/')).slice(1).replace(/\/+$/, '');
  if (!clean) return { root, full: root, rel: '' };

  const parent = realpathOr404(path.join(root, path.dirname(clean)));
  if (!inside(root, parent)) throw httpError(400, 'Đường dẫn ra ngoài dự án');
  let full = path.join(parent, path.basename(clean));
  const exists = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!exists && mustExist) throw httpError(404, 'Không tìm thấy file hoặc thư mục');
  if (exists && follow) {
    full = realpathOr404(full);
    if (!inside(root, full)) throw httpError(400, 'Đường dẫn ra ngoài dự án');
  }
  return { root, full, rel: path.relative(root, full).split(path.sep).join('/') };
}

async function listDir(project, rel) {
  const { full, rel: clean } = resolve(project, rel);
  const st = await fs.promises.stat(full);
  if (!st.isDirectory()) throw httpError(400, 'Không phải thư mục');
  const dirents = await fs.promises.readdir(full, { withFileTypes: true });
  const entries = [];
  let truncated = false;
  for (const d of dirents) {
    if (HIDDEN.has(d.name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const p = path.join(full, d.name);
    let type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
    let size = 0;
    let mtime = 0;
    try {
      const s = await fs.promises.stat(p); // đi theo symlink để biết là file hay thư mục
      if (d.isSymbolicLink()) type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
      size = s.size;
      mtime = s.mtimeMs;
    } catch {
      type = 'link'; // symlink hỏng
    }
    entries.push({ name: d.name, type, size, mtime, link: d.isSymbolicLink() });
  }
  entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return { path: clean, entries, truncated };
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Nén thư mục thành zip ngay khi gửi (zipfile của python3 ghi thẳng ra stdout, không cần file tạm).
// Bỏ các thư mục tên nằm trong skip; symlink trỏ ra ngoài thư mục đang tải thì bỏ qua.
const ZIP_PY = `
import os, sys, zipfile
root, base, skip = sys.argv[1], sys.argv[2], set(filter(None, sys.argv[3].split(',')))
real_root = os.path.realpath(root)
def inside(p):
    r = os.path.realpath(p)
    return r == real_root or r.startswith(real_root + os.sep)
with zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in skip and not os.path.islink(os.path.join(d, x)))
        rel = os.path.relpath(d, root)
        arc = base if rel == '.' else base + '/' + rel.replace(os.sep, '/')
        if not files and not dirs:
            z.writestr(arc + '/', '')
        for f in sorted(files):
            p = os.path.join(d, f)
            if f in skip or not os.path.isfile(p) or not inside(p):
                continue
            try:
                z.write(p, arc + '/' + f)
            except OSError as e:
                print(e, file=sys.stderr)
`;
// Thư mục rác hay rất nặng, bỏ đi khi tải dự án (tùy chọn). .cpm là ảnh dán/preview nội bộ của app.
const JUNK = ['node_modules', '.venv', '__pycache__', '.DS_Store', '.cpm'];

// File thì tải thẳng; thư mục thì nén zip (mặc định) hoặc tar.gz ngay khi gửi.
// opts: { format: 'zip'|'tar', skipJunk, git } — git=false thì bỏ thư mục .git.
async function download(res, project, rel, opts = {}) {
  const { full, rel: clean } = resolve(project, rel);
  const st = await fs.promises.stat(full);
  const name = clean ? path.basename(full) : project;
  if (st.isFile()) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': contentDisposition(name),
    });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (!st.isDirectory()) throw httpError(400, 'Không tải được loại file này');
  const skip = [...(opts.skipJunk ? JUNK : []), ...(opts.git === false ? ['.git'] : [])];
  const tar = opts.format === 'tar';
  const child = tar
    ? spawn('tar', ['-czf', '-', ...skip.map((x) => `--exclude=${x}`), '-C', path.dirname(full), '--', path.basename(full)], { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn('python3', ['-I', '-c', ZIP_PY, full, name, skip.join(',')], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => res.destroy());
  res.writeHead(200, {
    'Content-Type': tar ? 'application/gzip' : 'application/zip',
    'Content-Disposition': contentDisposition(`${name}.${tar ? 'tar.gz' : 'zip'}`),
  });
  child.stdout.pipe(res);
  res.on('close', () => child.kill());
}

// Đọc tùy chọn tải thư mục từ query/body: format=zip|tar, skip=1 (bỏ rác), git=0 (bỏ .git).
function downloadOpts(get) {
  return { format: get('format') === 'tar' ? 'tar' : 'zip', skipJunk: get('skip') === '1', git: get('git') !== '0' };
}

// Kiểu ảnh xem được ngay trên web (SVG hiển thị qua <img> nên script trong đó không chạy).
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};
const MAX_TEXT = 2 * 1024 * 1024;

const imageType = (name) => IMAGE_TYPES[path.extname(name).toLowerCase()] || null;

function sendImage(res, name, body) {
  res.writeHead(200, {
    'Content-Type': imageType(name) || 'application/octet-stream',
    'Content-Length': body.length,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function image(res, project, rel) {
  const { full } = resolve(project, rel);
  if (!imageType(full)) throw httpError(415, 'Không phải file ảnh');
  const st = await fs.promises.stat(full);
  if (!st.isFile()) throw httpError(400, 'Không phải file');
  sendImage(res, full, await fs.promises.readFile(full));
}

// Đọc file dạng chữ để xem/sửa trên web. mtime dùng để phát hiện file bị sửa chỗ khác trong lúc đang sửa.
async function readText(project, rel) {
  const { full, rel: clean } = resolve(project, rel);
  const st = await fs.promises.stat(full);
  if (!st.isFile()) throw httpError(400, 'Không phải file');
  if (st.size > MAX_TEXT) return { path: clean, size: st.size, mtime: st.mtimeMs, tooLarge: true };
  const buf = await fs.promises.readFile(full);
  if (buf.subarray(0, 8000).includes(0)) return { path: clean, size: st.size, mtime: st.mtimeMs, binary: true };
  return { path: clean, size: st.size, mtime: st.mtimeMs, text: buf.toString('utf8') };
}

async function writeText(project, rel, text, mtime) {
  if (typeof text !== 'string') throw httpError(400, 'Thiếu nội dung');
  const { full } = resolve(project, rel);
  const st = await fs.promises.stat(full);
  if (!st.isFile()) throw httpError(400, 'Không phải file');
  if (typeof mtime === 'number' && Math.abs(st.mtimeMs - mtime) > 1) throw httpError(409, 'File vừa bị sửa ở chỗ khác, mở lại để xem bản mới');
  const tmp = path.join(path.dirname(full), `.${path.basename(full).slice(0, 200)}.cpm-edit-${crypto.randomBytes(4).toString('hex')}`);
  await fs.promises.writeFile(tmp, text, { mode: st.mode });
  await fs.promises.rename(tmp, full);
  const after = await fs.promises.stat(full);
  return { size: after.size, mtime: after.mtimeMs };
}

// Ghi body thô của request vào file tmp (tạo mới), lỗi hay bị ngắt thì xóa file tmp.
function receiveTo(req, tmp) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) return Promise.reject(httpError(413, `File quá lớn (tối đa ${MAX_UPLOAD / 1024 / 1024} MB)`));
  return new Promise((resolvePromise, reject) => {
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        fail(httpError(413, `File quá lớn (tối đa ${MAX_UPLOAD / 1024 / 1024} MB)`));
        req.destroy();
      }
    });
    req.on('close', () => {
      if (!req.complete) fail(httpError(400, 'Upload bị ngắt'));
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (!failed) resolvePromise();
    });
    req.pipe(out);
  });
}

// Tạo dần các thư mục con của dirRel (như mkdir -p), mỗi bước đều kiểm tra không ra ngoài dự án.
function mkdirs(project, dirRel) {
  const parts = String(dirRel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  for (let i = 1; i <= parts.length; i++) {
    checkEntryName(parts[i - 1]);
    const { full } = resolve(project, parts.slice(0, i).join('/'), { mustExist: false });
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st) fs.mkdirSync(full, { mode: 0o755 });
    else if (!st.isDirectory()) throw httpError(409, `"${parts.slice(0, i).join('/')}" không phải thư mục`);
  }
}

// Nhận body thô và ghi vào file tạm, xong mới đổi tên, để file dở dang không đè file cũ.
// makeDirs: tạo thư mục còn thiếu (dùng khi upload cả thư mục).
async function upload(req, project, dirRel, name, overwrite, makeDirs = false) {
  checkEntryName(name);
  if (makeDirs) mkdirs(project, dirRel);
  const { full: dir } = resolve(project, dirRel);
  if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Không phải thư mục');
  const target = path.join(dir, name);
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isDirectory()) throw httpError(409, `"${name}" là thư mục đã có`);
  if (existing && !overwrite) throw httpError(409, `"${name}" đã có`);

  const tmp = path.join(dir, `.${name.slice(0, 200)}.cpm-upload-${crypto.randomBytes(4).toString('hex')}`);
  await receiveTo(req, tmp);
  await fs.promises.rename(tmp, target);
  return { name, size: fs.statSync(target).size };
}

// Ảnh dán vào ô prompt: lưu trong .cpm/paste của dự án để Claude đọc được mà không cần quyền
// ngoài thư mục dự án; .cpm/ được thêm vào .git/info/exclude để không lẫn vào commit.
const PASTE_DIR = '.cpm/paste';
const PASTE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' };
const PASTE_KEEP_MS = 7 * 24 * 3600 * 1000;

function excludeCpm(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(exclude))) return;
  const cur = fs.readFileSync(exclude, { encoding: 'utf8', flag: 'a+' });
  if (!/^\/?\.cpm\/?$/m.test(cur)) fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.cpm/\n`);
}

async function savePaste(req, project) {
  const ext = PASTE_TYPES[String(req.headers['content-type']).split(';')[0].trim()];
  if (!ext) throw httpError(415, 'Chỉ dán được ảnh PNG, JPEG, GIF, WebP, HEIC');
  const root = fs.realpathSync(projectDir(project));
  await fs.promises.mkdir(path.join(root, PASTE_DIR), { recursive: true });
  const { full: dir } = resolve(project, PASTE_DIR);

  excludeCpm(root);

  // Dọn ảnh cũ để thư mục không phình mãi.
  const now = Date.now();
  for (const f of await fs.promises.readdir(dir)) {
    const st = fs.lstatSync(path.join(dir, f), { throwIfNoEntry: false });
    if (st?.isFile() && now - st.mtimeMs > PASTE_KEEP_MS) fs.rmSync(path.join(dir, f), { force: true });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  await upload(req, project, PASTE_DIR, name, false);
  return { path: `${PASTE_DIR}/${name}` };
}

// Tạo dự án từ file .zip: nhận về file tạm, giải nén bằng zipfile của python3 (tự bỏ đường dẫn tuyệt đối
// và "..", không tạo symlink), zip chỉ có một thư mục gốc thì lấy luôn thư mục đó làm dự án.
const MAX_UNZIP = Number(process.env.MAX_UNZIP_MB || 4096) * 1024 * 1024;
const UNZIP_PY = `
import sys, zipfile
src, dest, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    z = zipfile.ZipFile(src)
except zipfile.BadZipFile:
    sys.exit("File không phải zip hợp lệ")
with z:
    infos = [i for i in z.infolist() if not i.filename.startswith('__MACOSX/') and not i.filename.endswith('.DS_Store')]
    if sum(i.file_size for i in infos) > limit:
        sys.exit("Giải nén ra quá lớn")
    for i in infos:
        z.extract(i, dest)
`;

function runUnzip(zip, dest) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', ['-I', '-c', UNZIP_PY, zip, dest, String(MAX_UNZIP)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => reject(httpError(500, 'Server chưa có python3 để giải nén')));
    child.on('close', (code) => {
      if (code === 0) return resolvePromise();
      const last = err.trim().split('\n').pop() || 'Giải nén lỗi';
      reject(httpError(400, last.replace(/^\w+Error: /, '')));
    });
  });
}

async function importZip(req, name) {
  ensureRoot();
  checkNewName(name);
  const tag = crypto.randomBytes(4).toString('hex');
  const zip = path.join(PROJECTS_DIR, `.${name}.cpm-zip-${tag}`);
  const tmpDir = path.join(PROJECTS_DIR, `.${name}.cpm-import-${tag}`);
  try {
    await receiveTo(req, zip);
    await fs.promises.mkdir(tmpDir, { mode: 0o755 });
    await runUnzip(zip, tmpDir);
    const top = (await fs.promises.readdir(tmpDir, { withFileTypes: true })).filter((d) => d.name !== '__MACOSX' && d.name !== '.DS_Store');
    const src = top.length === 1 && top[0].isDirectory() ? path.join(tmpDir, top[0].name) : tmpDir;
    checkNewName(name); // có thể vừa có người tạo trùng tên trong lúc upload
    await fs.promises.rename(src, path.join(PROJECTS_DIR, name));
    return { name };
  } finally {
    fs.rm(zip, { force: true }, () => {});
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

async function mkdir(project, dirRel, name) {
  checkEntryName(name);
  const { full: dir } = resolve(project, dirRel);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw httpError(409, `"${name}" đã có`);
  await fs.promises.mkdir(target);
}

async function rename(project, rel, newName) {
  checkEntryName(newName);
  const { full, rel: clean } = resolve(project, rel, { follow: false });
  if (!clean) throw httpError(400, 'Không đổi tên thư mục gốc của dự án ở đây');
  const target = path.join(path.dirname(full), newName);
  if (fs.existsSync(target)) throw httpError(409, `"${newName}" đã có`);
  await fs.promises.rename(full, target);
}

async function remove(project, rel) {
  const { full, rel: clean } = resolve(project, rel, { follow: false });
  if (!clean) throw httpError(400, 'Không xóa thư mục gốc của dự án ở đây');
  await fs.promises.rm(full, { recursive: true });
}

module.exports = { resolve, excludeCpm, receiveTo, importZip, MAX_UPLOAD, MAX_TEXT, imageType, sendImage, image, readText, writeText, listDir, download, downloadOpts, upload, savePaste, mkdir, rename, remove };

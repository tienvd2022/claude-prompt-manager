'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { PROJECTS_DIR, httpError, ensureRoot, checkNewName, projectDir } = require('./projects');

// Không bao giờ hỏi mật khẩu (web không trả lời được), host SSH mới thì tự tin lần đầu.
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15',
};
const BASE_ARGS = ['-c', 'color.ui=false', '-c', 'core.quotepath=false'];
const MAX_OUTPUT = 400 * 1024;
const JOB_OUTPUT = 100 * 1024;
const JOB_TIMEOUT = 15 * 60 * 1000;
const URL_RE = /^(?:(?:ssh|https?|git):\/\/[^\s'"`]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s'"`]+)$/;
const HASH_RE = /^[0-9a-f]{4,40}$/;

function git(cwd, args, { timeout = 30000, ok = [0], raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { cwd, env: ENV, timeout, maxBuffer: 32 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' };
    execFile('git', [...BASE_ARGS, ...args], opts, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (!ok.includes(code)) {
        return reject(httpError(400, String(stderr || err?.message || 'git lỗi').trim()));
      }
      resolve(raw ? stdout : String(stdout));
    });
  });
}

function truncate(text) {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + '\n\n… (đã cắt bớt, quá dài)' : text;
}

function repoDir(project) {
  const dir = projectDir(project);
  if (!fs.existsSync(path.join(dir, '.git'))) throw httpError(400, 'Dự án này chưa phải repo git');
  return dir;
}

// Lấy phần sau trường thứ n (đường dẫn có thể chứa dấu cách).
function afterFields(line, n) {
  let i = -1;
  for (let k = 0; k < n; k++) i = line.indexOf(' ', i + 1);
  return line.slice(i + 1);
}

async function status(project) {
  const dir = projectDir(project);
  if (!fs.existsSync(path.join(dir, '.git'))) return { repo: false };
  const out = await git(dir, ['status', '--porcelain=v2', '--branch', '-z']);
  const info = { repo: true, branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], remote: null };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) info.head = line.slice(13) === '(initial)' ? null : line.slice(13);
    else if (line.startsWith('# branch.head ')) info.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])];
    } else if (line[0] === '1') info.changes.push({ xy: line.slice(2, 4), path: afterFields(line, 8) });
    else if (line[0] === '2') info.changes.push({ xy: line.slice(2, 4), path: afterFields(line, 9), from: parts[++i] });
    else if (line[0] === 'u') info.changes.push({ xy: line.slice(2, 4), path: afterFields(line, 10), conflict: true });
    else if (line[0] === '?') info.changes.push({ xy: '??', path: line.slice(2), untracked: true });
  }
  if (info.changes.length > 1000) {
    info.total = info.changes.length;
    info.changes = info.changes.slice(0, 1000);
  }
  info.remote = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim() || null;
  info.merging = fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));
  // Claude xử lý xong (merge đã commit hoặc đã hủy) thì tự mở khóa.
  if (locks.get(project)?.kind === 'conflict' && !info.merging && !info.changes.some((c) => c.conflict)) locks.delete(project);
  info.lock = locks.get(project) || null;
  return info;
}

async function log(project, limit = 100) {
  const dir = repoDir(project);
  const fmt = ['%H', '%h', '%an', '%at', '%s', '%D'].join('%x1f') + '%x1e';
  let out;
  try {
    out = await git(dir, ['log', `-n${limit}`, `--format=${fmt}`]);
  } catch (err) {
    if (/does not have any commits|bad default revision/.test(err.message)) return [];
    throw err;
  }
  return out
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, short, author, at, subject, refs] = rec.split('\x1f');
      return { hash, short, author, time: Number(at) * 1000, subject, refs };
    });
}

async function show(project, hash) {
  checkHash(hash);
  return truncate(await git(repoDir(project), ['show', '--stat', '--patch', '--format=fuller', hash, '--']));
}

function checkFile(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw httpError(400, 'Thiếu đường dẫn file');
  if (path.isAbsolute(file) || path.normalize(file).startsWith('..')) throw httpError(400, 'Đường dẫn ra ngoài dự án');
  return file;
}

function checkHash(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw httpError(400, 'Mã commit không hợp lệ');
  return hash;
}

async function diff(project, file, untracked) {
  const dir = repoDir(project);
  checkFile(file);
  if (untracked && file.endsWith('/')) return 'Thư mục mới, chưa được git theo dõi.';
  if (untracked) return truncate(await git(dir, ['diff', '--no-index', '--', '/dev/null', file], { ok: [0, 1] }));
  const hasHead = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  return truncate(await git(dir, hasHead ? ['diff', 'HEAD', '--', file] : ['diff', '--cached', '--', file]));
}

// Commit gốc thì so với cây rỗng; commit merge thì so với cha đầu tiên.
async function commitBase(dir, hash) {
  const [, parent] = (await git(dir, ['rev-list', '--parents', '-n1', hash, '--'])).trim().split(' ');
  return parent || (await git(dir, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
}

async function commitFiles(project, hash) {
  const dir = repoDir(project);
  checkHash(hash);
  const base = await commitBase(dir, hash);
  const parts = (await git(dir, ['diff', '--name-status', '-z', '-M', base, hash, '--'])).split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    const code = parts[i][0];
    if (!code) continue;
    if (code === 'R' || code === 'C') files.push({ status: code, from: parts[++i], path: parts[++i] });
    else files.push({ status: code, path: parts[++i] });
  }
  return { base, files };
}

async function commitDiff(project, hash, file, from) {
  const dir = repoDir(project);
  checkHash(hash);
  checkFile(file);
  const paths = from ? [checkFile(from), file] : [file];
  const base = await commitBase(dir, hash);
  return truncate(await git(dir, ['diff', '-M', base, hash, '--', ...paths]));
}

// Nội dung một file tại commit (rev) hoặc trong thư mục làm việc (rev rỗng, đọc ở files.js).
async function fileAt(project, rev, file) {
  const dir = repoDir(project);
  checkHash(rev);
  checkFile(file);
  return textOrBinary(await git(dir, ['show', `${rev}:${file}`]));
}

// Bản thô (ảnh) của file tại commit.
async function rawAt(project, rev, file) {
  const dir = repoDir(project);
  checkHash(rev);
  checkFile(file);
  return git(dir, ['show', `${rev}:${file}`], { raw: true });
}

function textOrBinary(text) {
  if (text.slice(0, 8000).includes('\0')) return '(file nhị phân, không hiển thị được)';
  return truncate(text);
}

// ---------- Nhánh ----------

async function branches(project) {
  const dir = repoDir(project);
  const out = await git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes']);
  const local = [];
  const remote = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, upstream, head] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11);
      local.push({ name, upstream: upstream || null });
      if (head === '*') current = name;
    } else if (!ref.endsWith('/HEAD')) remote.push(ref.slice(13));
  }
  const tracked = new Set(local.map((b) => b.upstream));
  return { current, local, remote: remote.filter((r) => !tracked.has(r)) };
}

async function checkBranchName(dir, name) {
  if (typeof name !== 'string' || !name.trim() || name.startsWith('-') || name.length > 200) throw httpError(400, 'Tên nhánh không hợp lệ');
  await git(dir, ['check-ref-format', '--branch', name]).catch(() => {
    throw httpError(400, 'Tên nhánh không hợp lệ');
  });
  return name;
}

// Chuyển sang nhánh có sẵn, nhánh remote (tạo nhánh local theo dõi nó) hoặc tạo nhánh mới từ HEAD.
async function checkout(project, { branch, create }) {
  checkUnlocked(project);
  const dir = repoDir(project);
  const name = await checkBranchName(dir, typeof branch === 'string' ? branch.trim() : branch);
  if (create) return git(dir, ['switch', '-c', name]);
  const exists = (ref) => git(dir, ['show-ref', '--verify', '-q', ref]).then(() => true, () => false);
  if (await exists(`refs/heads/${name}`)) return git(dir, ['switch', name]);
  if (await exists(`refs/remotes/${name}`)) {
    const localName = name.slice(name.indexOf('/') + 1);
    if (await exists(`refs/heads/${localName}`)) return git(dir, ['switch', localName]);
    return git(dir, ['switch', '--track', name]);
  }
  throw httpError(404, 'Không tìm thấy nhánh');
}

async function commitAll(project, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) throw httpError(400, 'Cần nội dung commit');
  checkUnlocked(project);
  const dir = repoDir(project);
  await git(dir, ['add', '-A']);
  return git(dir, ['commit', '-m', message.trim()]);
}

async function init(project) {
  const dir = projectDir(project);
  if (fs.existsSync(path.join(dir, '.git'))) throw httpError(409, 'Đã là repo git');
  return git(dir, ['init', '-b', 'main']);
}

// ---------- Việc chạy lâu (clone/fetch/pull/push): chạy nền, web hỏi kết quả ----------

const jobs = new Map();

function pruneJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.ended && job.ended < cutoff) jobs.delete(id);
}

function busy(project) {
  for (const job of jobs.values()) if (job.project === project && job.status === 'running') return true;
  return false;
}

// ---------- Khóa dự án khi tự đồng bộ đang pull hoặc Claude đang xử lý xung đột merge ----------
// project -> { kind: 'pull' | 'conflict', session?, since }. Chỉ nằm trong bộ nhớ: restart server thì mất khóa,
// nhưng status vẫn báo merging nên web vẫn biết còn xung đột.

const locks = new Map();

function lockProject(project, kind, extra = {}) {
  const lock = { kind, since: Date.now(), ...extra };
  locks.set(project, lock);
  return lock;
}

function unlockProject(project) {
  const lock = locks.get(project);
  locks.delete(project);
  return lock || null;
}

function checkUnlocked(project) {
  const lock = locks.get(project);
  if (lock) throw httpError(423, lock.kind === 'pull' ? 'Dự án đang tự pull, chờ chút' : 'Dự án đang khóa: Claude đang xử lý xung đột merge');
}

function startJob(project, kind, cwd, args, onDone) {
  if (busy(project)) throw httpError(409, 'Dự án đang chạy một lệnh git khác');
  pruneJobs();
  const job = { id: crypto.randomBytes(8).toString('hex'), project, kind, status: 'running', output: '', started: Date.now(), ended: null };
  jobs.set(job.id, job);
  const child = spawn('git', [...BASE_ARGS, ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk) => {
    if (job.output.length < JOB_OUTPUT) job.output += chunk.toString('utf8');
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timer = setTimeout(() => {
    append('\n(quá thời gian, đã dừng)');
    child.kill('SIGTERM');
  }, JOB_TIMEOUT);
  const finish = (ok) => {
    clearTimeout(timer);
    if (job.ended) return;
    job.status = ok ? 'ok' : 'error';
    job.ended = Date.now();
    onDone?.(job);
  };
  child.on('error', (err) => {
    append(String(err.message));
    finish(false);
  });
  child.on('close', (code) => finish(code === 0));
  return publicJob(job);
}

function publicJob(job) {
  return { id: job.id, project: job.project, kind: job.kind, status: job.status, output: job.output, started: job.started, ended: job.ended };
}

function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw httpError(404, 'Không tìm thấy lệnh');
  return publicJob(job);
}

function clone(name, url) {
  ensureRoot();
  checkNewName(name);
  if (typeof url !== 'string' || !URL_RE.test(url.trim())) throw httpError(400, 'URL git không hợp lệ (dùng git@host:user/repo.git hoặc https://...)');
  return startJob(name, 'clone', PROJECTS_DIR, ['clone', '--progress', '--', url.trim(), name]);
}

async function remoteOp(project, op) {
  const dir = repoDir(project);
  if (op === 'fetch') checkLockedPull(project);
  else checkUnlocked(project);
  // Tự đồng bộ: pull kiểu merge (không chỉ fast-forward) để thấy được xung đột, khóa dự án tới khi pull xong.
  // Xung đột thì merge dừng lại, web giao cho Claude xử lý (resolve) và khóa tiếp.
  if (op === 'sync') {
    const job = startJob(project, op, dir, ['pull', '--no-rebase', '--no-edit', '--progress'], () => {
      if (locks.get(project)?.kind === 'pull') unlockProject(project);
    });
    lockProject(project, 'pull');
    return job;
  }
  if (op === 'fetch') return startJob(project, op, dir, ['fetch', '--all', '--prune', '--progress']);
  if (op === 'pull') return startJob(project, op, dir, ['pull', '--ff-only', '--progress']);
  if (op === 'push') {
    // Nhánh chưa có upstream thì đẩy lên origin và gắn upstream luôn.
    const hasUpstream = await git(dir, ['rev-parse', '--abbrev-ref', '@{u}']).then(() => true, () => false);
    return startJob(project, op, dir, hasUpstream ? ['push', '--progress'] : ['push', '--progress', '-u', 'origin', 'HEAD']);
  }
  throw httpError(400, 'Lệnh không hợp lệ');
}

// Fetch không đụng file làm việc: được chạy cả khi đang xử lý xung đột, chỉ chặn lúc đang pull.
function checkLockedPull(project) {
  if (locks.get(project)?.kind === 'pull') checkUnlocked(project);
}

// Danh sách file đang xung đột, để viết prompt cho Claude.
async function conflictFiles(project) {
  const out = await git(repoDir(project), ['diff', '--name-only', '--diff-filter=U', '-z']);
  return out.split('\0').filter(Boolean);
}

// Đổi (hoặc thêm) remote origin.
async function setRemote(project, url) {
  const dir = repoDir(project);
  if (typeof url !== 'string' || !URL_RE.test(url.trim())) throw httpError(400, 'URL git không hợp lệ (dùng git@host:user/repo.git hoặc https://...)');
  const has = await git(dir, ['remote', 'get-url', 'origin']).then(() => true, () => false);
  await git(dir, ['remote', has ? 'set-url' : 'add', 'origin', url.trim()]);
  return { remote: url.trim() };
}

// ---------- Cấu hình chung: tên/email commit, mặc định tự đồng bộ (SSH key theo tài khoản nằm ở gitaccounts.js) ----------

const SETTINGS_FILE = path.join(require('./paths').DATA_DIR, 'git-settings.json');

function loadSettings() {
  try {
    return { autoSync: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { autoSync: false };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

async function getConfig() {
  const home = os.homedir();
  const read = (key) => git(home, ['config', '--global', '--get', key]).then((s) => s.trim(), () => '');
  return { name: await read('user.name'), email: await read('user.email'), autoSync: loadSettings().autoSync === true };
}

async function setConfig({ name, email, autoSync }) {
  const ok = (v) => typeof v === 'string' && v.trim() && v.length <= 200 && !/[\r\n\0]/.test(v);
  if (!ok(name) || !ok(email)) throw httpError(400, 'Cần tên và email hợp lệ');
  const home = os.homedir();
  await git(home, ['config', '--global', 'user.name', name.trim()]);
  await git(home, ['config', '--global', 'user.email', email.trim()]);
  if (typeof autoSync === 'boolean') saveSettings({ ...loadSettings(), autoSync });
  return getConfig();
}

module.exports = { status, log, show, diff, commitFiles, commitDiff, fileAt, rawAt, branches, checkout, commitAll, init, clone, remoteOp, setRemote, getJob, getConfig, setConfig, lockProject, unlockProject, conflictFiles };

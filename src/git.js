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
const SSH_KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');

function git(cwd, args, { timeout = 30000, ok = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...BASE_ARGS, ...args], { cwd, env: ENV, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (!ok.includes(code)) {
        return reject(httpError(400, String(stderr || err?.message || 'git lỗi').trim()));
      }
      resolve(String(stdout));
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
  const info = { repo: true, branch: null, upstream: null, ahead: 0, behind: 0, changes: [], remote: null };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14);
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
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw httpError(400, 'Mã commit không hợp lệ');
  return truncate(await git(repoDir(project), ['show', '--stat', '--patch', '--format=fuller', hash, '--']));
}

async function diff(project, file, untracked) {
  const dir = repoDir(project);
  if (typeof file !== 'string' || !file || file.includes('\0')) throw httpError(400, 'Thiếu đường dẫn file');
  if (path.isAbsolute(file) || path.normalize(file).startsWith('..')) throw httpError(400, 'Đường dẫn ra ngoài dự án');
  if (untracked && file.endsWith('/')) return 'Thư mục mới, chưa được git theo dõi.';
  if (untracked) return truncate(await git(dir, ['diff', '--no-index', '--', '/dev/null', file], { ok: [0, 1] }));
  const hasHead = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  return truncate(await git(dir, hasHead ? ['diff', 'HEAD', '--', file] : ['diff', '--cached', '--', file]));
}

async function commitAll(project, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) throw httpError(400, 'Cần nội dung commit');
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

function startJob(project, kind, cwd, args) {
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
  if (op === 'fetch') return startJob(project, op, dir, ['fetch', '--all', '--prune', '--progress']);
  if (op === 'pull') return startJob(project, op, dir, ['pull', '--ff-only', '--progress']);
  if (op === 'push') {
    // Nhánh chưa có upstream thì đẩy lên origin và gắn upstream luôn.
    const hasUpstream = await git(dir, ['rev-parse', '--abbrev-ref', '@{u}']).then(() => true, () => false);
    return startJob(project, op, dir, hasUpstream ? ['push', '--progress'] : ['push', '--progress', '-u', 'origin', 'HEAD']);
  }
  throw httpError(400, 'Lệnh không hợp lệ');
}

// ---------- Cấu hình chung: tên/email commit và SSH key để clone/push ----------

async function getConfig() {
  const home = os.homedir();
  const read = (key) => git(home, ['config', '--global', '--get', key]).then((s) => s.trim(), () => '');
  let sshKey = null;
  try {
    sshKey = fs.readFileSync(`${SSH_KEY}.pub`, 'utf8').trim();
  } catch {
    // chưa có key
  }
  return { name: await read('user.name'), email: await read('user.email'), sshKey };
}

async function setConfig({ name, email }) {
  const ok = (v) => typeof v === 'string' && v.trim() && v.length <= 200 && !/[\r\n\0]/.test(v);
  if (!ok(name) || !ok(email)) throw httpError(400, 'Cần tên và email hợp lệ');
  const home = os.homedir();
  await git(home, ['config', '--global', 'user.name', name.trim()]);
  await git(home, ['config', '--global', 'user.email', email.trim()]);
  return getConfig();
}

function createSshKey() {
  if (fs.existsSync(SSH_KEY)) throw httpError(409, 'Đã có SSH key');
  fs.mkdirSync(path.dirname(SSH_KEY), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    execFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${os.userInfo().username}@claude-prompt-manager`, '-f', SSH_KEY], (err, _out, stderr) => {
      if (err) return reject(httpError(500, String(stderr || err.message).trim()));
      resolve(getConfig());
    });
  });
}

module.exports = { status, log, show, diff, commitAll, init, clone, remoteOp, getJob, getConfig, setConfig, createSshKey };

'use strict';

// Nhiều tài khoản git trên cùng server: mỗi tài khoản là một alias trong ~/.ssh/config (vd github.com-tienvd2022)
// trỏ tới một SSH key riêng. Clone/push bằng git@<alias>:user/repo.git là ra đúng tài khoản.
// Tạo repo trên GitHub thì SSH không làm được, cần token: lấy từ gh (GitHub CLI) hoặc token anh nhập vào app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const projects = require('./projects');

const { httpError } = projects;

const SSH_DIR = path.join(os.homedir(), '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');
const TOKENS_FILE = path.join(require('./paths').DATA_DIR, 'git-tokens.json');
const LABELS_FILE = path.join(require('./paths').DATA_DIR, 'git-labels.json'); // alias -> tên gợi nhớ anh đặt
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const GIT_HOST_RE = /github|gitlab|bitbucket|gitea|codeberg/i;
const DEFAULT_KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || err?.message || '') });
    });
  });
}

// ---------- Đọc ~/.ssh/config ----------

function parseConfig() {
  let text = '';
  try {
    text = fs.readFileSync(SSH_CONFIG, 'utf8');
  } catch {
    return [];
  }
  const blocks = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = { names: value.split(/\s+/), opts: {} };
      blocks.push(cur);
    } else if (key === 'match') {
      cur = null;
    } else if (cur && !(key in cur.opts)) {
      cur.opts[key] = value; // ssh lấy giá trị đầu tiên
    }
  }
  return blocks;
}

function readPub(file) {
  if (!file) return null;
  try {
    return fs.readFileSync(`${file}.pub`, 'utf8').trim();
  } catch {
    return null;
  }
}

function account(alias, opts, implicit = false) {
  const identityFile = opts.identityfile ? expandHome(opts.identityfile) : null;
  return {
    alias,
    hostname: opts.hostname || alias,
    user: opts.user || null,
    identityFile,
    keyExists: !!identityFile && fs.existsSync(identityFile),
    publicKey: readPub(identityFile),
    implicit,
    label: loadLabels()[alias] || '',
  };
}

// ---------- Tên gợi nhớ (chỉ lưu trong app, không ghi vào ~/.ssh/config) ----------

function loadLabels() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveLabels(labels) {
  fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${LABELS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2));
  fs.renameSync(tmp, LABELS_FILE);
}

function setLabel(alias, label) {
  const labels = loadLabels();
  if (label) labels[alias] = label;
  else delete labels[alias];
  saveLabels(labels);
}

function cleanLabel(label) {
  label = String(label ?? '').trim();
  if (label.length > 60 || /[\x00-\x1f]/.test(label)) throw httpError(400, 'Tên gợi nhớ tối đa 60 ký tự');
  return label;
}

// Chỉ lấy các host git (GitHub, GitLab…) hoặc host đăng nhập bằng user git; host server thường (vps…) bỏ qua.
function list() {
  const out = [];
  for (const b of parseConfig()) {
    for (const name of b.names) {
      if (/[*?!]/.test(name) || out.some((a) => a.alias === name)) continue;
      const host = b.opts.hostname || name;
      if (!GIT_HOST_RE.test(host) && b.opts.user !== 'git') continue;
      out.push(account(name, b.opts));
    }
  }
  // Không khai báo Host github.com thì ssh dùng key mặc định (~/.ssh/id_ed25519…).
  if (!out.some((a) => a.alias === 'github.com')) {
    const key = DEFAULT_KEYS.map((k) => path.join(SSH_DIR, k)).find((f) => fs.existsSync(f));
    out.unshift(account('github.com', { identityfile: key || path.join(SSH_DIR, 'id_ed25519') }, true));
  }
  return out;
}

function get(alias) {
  const a = list().find((x) => x.alias === alias);
  if (!a) throw httpError(404, `Không có tài khoản ${alias} trong ~/.ssh/config`);
  return a;
}

// Phần trước dấu ":" trong URL clone: git@alias, hoặc chỉ alias nếu config khai báo User khác git.
const sshTarget = (a) => (a.user && a.user !== 'git' ? a.alias : `git@${a.alias}`);

// ---------- Kiểm tra key đang là tài khoản nào ----------

async function check(alias) {
  const a = get(alias);
  const r = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', sshTarget(a)]);
  const text = `${r.out}\n${r.err}`;
  const m = text.match(/Hi ([A-Za-z0-9-]+)!/) || text.match(/Welcome to GitLab, @([\w.-]+)!/) || text.match(/logged in as ([\w.-]+)/);
  const provider = /github/i.test(a.hostname) ? 'github' : /gitlab/i.test(a.hostname) ? 'gitlab' : null;
  const login = m ? m[1] : null;
  const message = text.split('\n').map((s) => s.trim()).find(Boolean) || '';
  return { alias, login, provider, message, token: login && provider === 'github' ? (await token(login))?.source || null : null };
}

// ---------- Thêm tài khoản: tạo key riêng + khối Host ----------

function keygen(file, comment) {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) || fs.existsSync(`${file}.pub`)) throw httpError(409, `Đã có file key ${file}, không ghi đè`);
  return run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]).then((r) => {
    if (r.code) throw httpError(500, r.err.trim() || 'ssh-keygen lỗi');
  });
}

async function add({ alias, hostname, label } = {}) {
  alias = String(alias || '').trim();
  hostname = String(hostname || 'github.com').trim();
  label = cleanLabel(label);
  if (!ALIAS_RE.test(alias)) throw httpError(400, 'Alias chỉ gồm chữ, số, dấu . _ -');
  if (!HOST_RE.test(hostname)) throw httpError(400, 'Host không hợp lệ');
  if (parseConfig().some((b) => b.names.includes(alias))) throw httpError(409, `Đã có Host ${alias} trong ~/.ssh/config`);
  const file = path.join(SSH_DIR, `id_ed25519_${alias}`);
  // Alias từng xóa rồi thêm lại: key cũ vẫn còn thì dùng lại (đã add vào GitHub rồi), không tạo mới.
  if (!(fs.existsSync(file) && fs.existsSync(`${file}.pub`))) await keygen(file, `${alias}@${os.hostname()}`);
  const old = readConfig();
  const block = `Host ${alias}\n  HostName ${hostname}\n  User git\n  IdentityFile ~/.ssh/${path.basename(file)}\n  IdentitiesOnly yes\n`;
  writeConfig(`${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${block}`);
  setLabel(alias, label);
  return get(alias);
}

// ---------- Sửa / xóa alias trong ~/.ssh/config ----------

function readConfig() {
  try {
    return fs.readFileSync(SSH_CONFIG, 'utf8');
  } catch {
    return '';
  }
}

// Giữ bản sao config cũ trước mỗi lần sửa.
function writeConfig(text) {
  fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(SSH_CONFIG)) fs.copyFileSync(SSH_CONFIG, `${SSH_CONFIG}.cpm-backup`);
  const tmp = `${SSH_CONFIG}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, SSH_CONFIG);
}

const directive = (line) => line.trim().match(/^(\S+?)\s*(?:=\s*|\s+)(.*)$/);

// Vị trí khối Host có alias: [dòng Host, dòng sau khối). Dòng trống/chú thích ở cuối khối tính cho khối sau
// (thường là chú thích của Host kế tiếp).
function findBlock(lines, alias) {
  const start = lines.findIndex((l) => {
    const m = directive(l);
    return m && m[1].toLowerCase() === 'host' && m[2].split(/\s+/).includes(alias);
  });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*(host|match)\b/i.test(lines[end])) end++;
  while (end > start + 1 && (!lines[end - 1].trim() || lines[end - 1].trim().startsWith('#'))) end--;
  return { start, end, names: directive(lines[start])[2].split(/\s+/) };
}

function editableBlock(alias) {
  const lines = readConfig().split('\n');
  const b = findBlock(lines, alias);
  if (!b) throw httpError(404, get(alias).implicit
    ? 'github.com chưa có khối Host trong ~/.ssh/config (dùng key mặc định), chỉ đặt được tên gợi nhớ'
    : `Không thấy Host ${alias} trong ~/.ssh/config (có thể nằm ở file Include), sửa tay giúp em`);
  return { lines, b };
}

// Sửa tên gợi nhớ, đổi tên alias, đổi HostName. Đổi alias thì remote origin của các dự án đang dùng alias cũ
// cũng được đổi theo, không thì push/pull hỏng.
async function update(alias, { alias: next, hostname, label } = {}) {
  const cur = get(alias);
  next = next === undefined ? alias : String(next).trim();
  hostname = hostname === undefined ? cur.hostname : String(hostname).trim();
  if (!ALIAS_RE.test(next)) throw httpError(400, 'Alias chỉ gồm chữ, số, dấu . _ -');
  if (!HOST_RE.test(hostname)) throw httpError(400, 'Host không hợp lệ');
  let remotes = [];
  if (next !== alias || hostname !== cur.hostname) {
    const { lines, b } = editableBlock(alias);
    if (next !== alias && parseConfig().some((x) => x.names.includes(next))) throw httpError(409, `Đã có Host ${next} trong ~/.ssh/config`);
    const indent = (lines[b.start + 1]?.match(/^\s+/) || ['  '])[0];
    let hostLine = b.start + 1;
    for (; hostLine < b.end; hostLine++) if (directive(lines[hostLine])?.[1].toLowerCase() === 'hostname') break;
    if (hostLine < b.end) lines[hostLine] = `${lines[hostLine].match(/^\s*/)[0]}HostName ${hostname}`;
    else if (hostname !== next) lines.splice(b.start + 1, 0, `${indent}HostName ${hostname}`);
    lines[b.start] = `${lines[b.start].match(/^\s*/)[0]}Host ${b.names.map((n) => (n === alias ? next : n)).join(' ')}`;
    writeConfig(lines.join('\n'));
    if (next !== alias) remotes = await renameRemotes(alias, next);
  }
  const labels = loadLabels();
  if (next !== alias) {
    delete labels[alias];
    saveLabels(labels);
  }
  setLabel(next, label === undefined ? cur.label : cleanLabel(label));
  return { ...get(next), remotes };
}

// Đổi remote origin git@<cũ>:a/b.git -> git@<mới>:a/b.git ở mọi dự án, trả về tên các dự án đã đổi.
async function renameRemotes(from, to) {
  const done = [];
  const re = new RegExp(`^((?:ssh://)?(?:[^@/\\s]+@)?)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([:/])`);
  for (const p of await projects.list().catch(() => [])) {
    if (!p.git || p.missing) continue;
    const dir = p.path || path.join(projects.PROJECTS_DIR, p.name);
    const r = await run('git', ['-C', dir, 'remote', 'get-url', 'origin'], 10000);
    const url = r.out.trim();
    if (r.code || !re.test(url)) continue;
    const s = await run('git', ['-C', dir, 'remote', 'set-url', 'origin', url.replace(re, `$1${to}$2`)], 10000);
    if (!s.code) done.push(p.name);
  }
  return done;
}

// Xóa alias khỏi ~/.ssh/config. File key giữ lại (xóa key là mất hẳn); thêm lại alias cùng tên thì dùng lại key đó.
function remove(alias) {
  const { lines, b } = editableBlock(alias);
  if (b.names.length > 1) {
    lines[b.start] = `${lines[b.start].match(/^\s*/)[0]}Host ${b.names.filter((n) => n !== alias).join(' ')}`;
  } else {
    let start = b.start;
    while (start > 0 && !lines[start - 1].trim()) start--; // bỏ luôn dòng trống phía trên khối
    lines.splice(start, b.end - start);
  }
  writeConfig(lines.join('\n'));
  setLabel(alias, '');
  return { alias };
}

// Tài khoản có trong config nhưng file key chưa có (hoặc github.com mặc định chưa có key): tạo key.
async function createKey(alias) {
  const a = get(alias);
  if (a.keyExists) throw httpError(409, 'Tài khoản này đã có key');
  await keygen(a.identityFile, `${alias}@${os.hostname()}`);
  return get(alias);
}

// ---------- Token GitHub (để tạo repo) ----------

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function token(login) {
  const saved = loadTokens()[login.toLowerCase()];
  if (saved) return { value: saved, source: 'saved' };
  for (const gh of GH_PATHS) {
    const r = await run(gh, ['auth', 'token', '-h', 'github.com', '-u', login], 10000);
    if (r.code === 0 && r.out.trim()) return { value: r.out.trim(), source: 'gh' };
    if (r.code !== -1 && !/ENOENT/.test(r.err)) break; // có gh nhưng chưa đăng nhập tài khoản này
  }
  return null;
}

function github(method, url, tok, body) {
  return fetch(`https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'claude-prompt-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
}

async function saveToken({ login, token: tok } = {}) {
  login = String(login || '').trim();
  tok = String(tok || '').trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw httpError(400, 'Tên tài khoản không hợp lệ');
  const tokens = loadTokens();
  if (!tok) delete tokens[login.toLowerCase()];
  else {
    if (!/^[A-Za-z0-9_]{20,255}$/.test(tok)) throw httpError(400, 'Token không hợp lệ');
    const res = await github('GET', '/user', tok);
    if (!res.ok) throw httpError(400, 'GitHub không nhận token này');
    const me = await res.json();
    if (String(me.login).toLowerCase() !== login.toLowerCase()) throw httpError(400, `Token này của ${me.login}, không phải ${login}`);
    tokens[login.toLowerCase()] = tok;
  }
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${TOKENS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
  return { login, token: (await token(login))?.source || null };
}

// Tạo repo trên GitHub (có sẵn README để clone về được ngay), trả về URL SSH qua đúng alias.
async function createRepo({ alias, owner, name, private: priv = true } = {}) {
  const info = await check(alias);
  if (info.provider !== 'github') throw httpError(400, 'Tạo repo mới hiện chỉ hỗ trợ GitHub');
  if (!info.login) throw httpError(400, `Key của ${alias} chưa vào được GitHub: ${info.message}`);
  const tok = await token(info.login);
  if (!tok) throw httpError(400, `Chưa có token cho ${info.login}: chạy "gh auth login" trên server, hoặc nhập token trong ⚙ Cài đặt Git`);
  owner = String(owner || info.login).trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw httpError(400, 'Chủ repo không hợp lệ');
  const url = owner.toLowerCase() === info.login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
  const res = await github('POST', url, tok.value, { name, private: priv !== false, auto_init: true });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err.errors?.map((e) => e.message).filter(Boolean).join(', ');
    throw httpError(400, `GitHub: ${detail || err.message || res.status}`);
  }
  const repo = await res.json();
  return `${sshTarget(get(alias))}:${repo.full_name}.git`;
}

module.exports = { list, check, add, update, remove, createKey, saveToken, createRepo };

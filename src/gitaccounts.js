'use strict';

// Nhiều tài khoản git trên cùng server: mỗi tài khoản là một alias trong ~/.ssh/config (vd github.com-tienvd2022)
// trỏ tới một SSH key riêng. Clone/push bằng git@<alias>:user/repo.git là ra đúng tài khoản.
// Tạo repo trên GitHub thì SSH không làm được, cần token: lấy từ gh (GitHub CLI) hoặc token anh nhập vào app.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { httpError } = require('./projects');

const SSH_DIR = path.join(os.homedir(), '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');
const TOKENS_FILE = path.join(__dirname, '..', 'data', 'git-tokens.json');
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
  };
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

async function add({ alias, hostname } = {}) {
  alias = String(alias || '').trim();
  hostname = String(hostname || 'github.com').trim();
  if (!ALIAS_RE.test(alias)) throw httpError(400, 'Alias chỉ gồm chữ, số, dấu . _ -');
  if (!HOST_RE.test(hostname)) throw httpError(400, 'Host không hợp lệ');
  if (parseConfig().some((b) => b.names.includes(alias))) throw httpError(409, `Đã có Host ${alias} trong ~/.ssh/config`);
  const file = path.join(SSH_DIR, `id_ed25519_${alias}`);
  await keygen(file, `${alias}@${os.hostname()}`);
  // Giữ bản sao config cũ trước khi sửa.
  if (fs.existsSync(SSH_CONFIG)) fs.copyFileSync(SSH_CONFIG, `${SSH_CONFIG}.cpm-backup`);
  const old = fs.existsSync(SSH_CONFIG) ? fs.readFileSync(SSH_CONFIG, 'utf8') : '';
  const block = `Host ${alias}\n  HostName ${hostname}\n  User git\n  IdentityFile ~/.ssh/${path.basename(file)}\n  IdentitiesOnly yes\n`;
  fs.appendFileSync(SSH_CONFIG, `${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${block}`, { mode: 0o600 });
  return get(alias);
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

module.exports = { list, check, add, createKey, saveToken, createRepo };

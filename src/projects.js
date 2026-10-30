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
  if (fs.existsSync(path.join(PROJECTS_DIR, name))) throw httpError(409, `Dự án "${name}" đã tồn tại`);
}

function projectDir(name) {
  if (!validName(name)) throw httpError(400, 'Tên dự án không hợp lệ');
  const dir = path.join(PROJECTS_DIR, name);
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
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function create(name) {
  ensureRoot();
  checkNewName(name);
  fs.mkdirSync(path.join(PROJECTS_DIR, name), { mode: 0o755 });
  return { name };
}

module.exports = { PROJECTS_DIR, httpError, ensureRoot, validName, checkNewName, projectDir, list, create };

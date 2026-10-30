'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// Dùng socket tmux riêng để không lẫn với tmux anh tự mở khi SSH.
// Muốn vào phiên từ SSH: tmux -L cpm attach -t <tên>
const SOCKET = process.env.CPM_TMUX_SOCKET || 'cpm';
const CONF = path.join(__dirname, '..', 'tmux.conf');
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COMMANDS = {
  claude: 'claude',
  shell: null,
};

function cleanEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-L', SOCKET, '-f', CONF, ...args], { env: cleanEnv(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

function isNoServer(err) {
  return /no server running|error connecting|no sessions/i.test(err.stderr || err.message);
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function resolveDir(dir) {
  let d = typeof dir === 'string' && dir.trim() ? dir.trim() : '~';
  if (d === '~' || d.startsWith('~/')) d = path.join(os.homedir(), d.slice(1));
  d = path.resolve(os.homedir(), d);
  const st = fs.statSync(d, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`Thư mục không tồn tại: ${d}`);
  return d;
}

async function list() {
  const fmt = ['#{session_name}', '#{session_created}', '#{session_activity}', '#{session_attached}', '#{pane_current_path}', '#{pane_current_command}'].join('\t');
  let out;
  try {
    out = await tmux(['list-sessions', '-F', fmt]);
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, created, activity, attached, cwd, command] = line.split('\t');
      return {
        name,
        created: Number(created) * 1000,
        activity: Number(activity) * 1000,
        attached: Number(attached),
        cwd,
        command,
      };
    })
    .sort((a, b) => a.created - b.created);
}

async function exists(name) {
  if (!validName(name)) return false;
  try {
    await tmux(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function create({ name, cwd, command }) {
  if (!validName(name)) throw new Error('Tên phiên chỉ gồm chữ, số, "-" và "_", tối đa 32 ký tự');
  if (!(command in COMMANDS)) throw new Error('Lệnh không hợp lệ');
  const dir = resolveDir(cwd);
  if (await exists(name)) throw new Error(`Phiên "${name}" đã tồn tại`);
  await tmux(['new-session', '-d', '-s', name, '-c', dir, '-x', '160', '-y', '45']);
  // Mở shell trước rồi mới gõ lệnh, để .bashrc (PATH tới claude) được nạp
  // và khi thoát claude thì phiên vẫn còn shell để dùng tiếp.
  if (COMMANDS[command]) await tmux(['send-keys', '-t', `=${name}:`, COMMANDS[command], 'Enter']);
  return { name, cwd: dir };
}

async function kill(name) {
  if (!validName(name)) throw new Error('Tên phiên không hợp lệ');
  await tmux(['kill-session', '-t', `=${name}`]);
}

// Lấy phần lịch sử đã cuộn khỏi màn hình, để trình duyệt kéo lên xem được.
async function history(name, lines = 3000) {
  try {
    const out = await tmux(['capture-pane', '-p', '-e', '-J', '-S', `-${lines}`, '-E', '-1', '-t', `=${name}:`]);
    return out.replace(/\n+$/, '');
  } catch {
    return '';
  }
}

function attach(name, cols, rows) {
  return pty.spawn('tmux', ['-L', SOCKET, '-f', CONF, 'attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: os.homedir(),
    env: cleanEnv(),
  });
}

module.exports = { SOCKET, validName, list, exists, create, kill, history, attach };

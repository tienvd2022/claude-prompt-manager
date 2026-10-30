'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

// Dùng socket tmux riêng để không lẫn với tmux anh tự mở khi SSH.
// Muốn vào phiên từ SSH: tmux -L cpm attach -t <tên>
const SOCKET = process.env.CPM_TMUX_SOCKET || 'cpm';
const CONF = path.join(__dirname, '..', 'tmux.conf');
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;
const COMMANDS = {
  claude: 'claude --permission-mode auto',
  // Chỉ mở khi bấm giữ nút Claude: bỏ qua mọi bước hỏi quyền.
  'claude-bypass': 'claude --dangerously-skip-permissions',
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

async function list() {
  const fmt = ['#{session_name}', '#{session_created}', '#{session_activity}', '#{session_attached}', '#{pane_current_path}', '#{pane_current_command}', '#{@cpm_project}', '#{@cpm_kind}'].join('\t');
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
      const [name, created, activity, attached, cwd, command, project, kind] = line.split('\t');
      return {
        name,
        project: project || null,
        kind: kind || null,
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

// Tên phiên tự đặt theo dự án: <dự án>-1, <dự án>-2...
async function nextName(project) {
  const slug = project.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const taken = new Set((await list()).map((s) => s.name));
  for (let i = 1; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
}

async function create({ project, cwd, command }) {
  if (!Object.hasOwn(COMMANDS, command)) throw new Error('Lệnh không hợp lệ');
  const name = await nextName(project);
  // Gắn tên dự án và loại phiên vào chính session tmux, để restart web vẫn biết phiên thuộc dự án nào.
  await tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '160', '-y', '45', ';', 'set-option', '@cpm_project', project, ';', 'set-option', '@cpm_kind', command]);
  // Mở shell trước rồi mới gõ lệnh, để .bashrc (PATH tới claude) được nạp
  // và khi thoát claude thì phiên vẫn còn shell để dùng tiếp.
  if (COMMANDS[command]) await tmux(['send-keys', '-t', `=${name}:`, COMMANDS[command], 'Enter']);
  return { name, project, kind: command, cwd };
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

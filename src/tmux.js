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
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;
// Hook của Claude ghi trạng thái (busy/idle/waiting/ended) vào option @cpm_state của phiên tmux,
// để hàng đợi prompt biết lúc nào Claude xong việc. --settings chỉ cộng thêm, không đè cấu hình của anh.
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const HOOKS = `--settings ${shq(path.join(__dirname, 'claude-hooks.json'))}`;
const COMMANDS = ['claude', 'claude-bypass', 'shell'];
// Tắt màn hình phụ (fullscreen) của Claude để nội dung trôi vào lịch sử tmux/xterm: cuộn lên xem lại
// và xem/copy dạng chữ được. Ở chế độ fullscreen, tmux không giữ được dòng nào đã trôi qua.
// Đặt qua môi trường của phiên (không viết VAR=1 trước lệnh) để alias của shell vẫn được mở rộng.
const CLAUDE_ENV = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1';

// Các alias Claude đã khai báo sẵn trong shell của server (vd claude-fami), liệt kê trong data/claude-aliases.json:
//   { "aliases": [{ "name": "claude", "description": "Tài khoản cá nhân" }, "claude-fami"] }
// Mỗi mục là tên alias hoặc { name, description }. Đọc lại mỗi lần để sửa file không cần restart.
const ALIASES_FILE = path.join(__dirname, '..', 'data', 'claude-aliases.json');
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_ALIASES = [{ name: 'claude', description: '' }];

function aliases() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      fs.mkdirSync(path.dirname(ALIASES_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(ALIASES_FILE, `${JSON.stringify({ aliases: DEFAULT_ALIASES }, null, 2)}\n`, { mode: 0o600 });
    } else console.error(`[aliases] ${ALIASES_FILE}: ${err.message}`);
    return DEFAULT_ALIASES;
  }
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(data) ? data : data?.aliases || []) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name !== 'string' || !ALIAS_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const description = typeof item?.description === 'string' ? item.description.slice(0, 200) : '';
    list.push({ name, description });
  }
  return list.length ? list : DEFAULT_ALIASES;
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'login', '-bash', '-zsh']);

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
  const fmt = ['#{session_name}', '#{session_created}', '#{session_activity}', '#{session_attached}', '#{pane_current_path}', '#{pane_current_command}', '#{@cpm_project}', '#{@cpm_kind}', '#{@cpm_state}', '#{@cpm_title}', '#{@cpm_alias}'].join('\t');
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
      const [name, created, activity, attached, cwd, command, project, kind, state, title, alias] = line.split('\t');
      return {
        name,
        project: project || null,
        kind: kind || null,
        title: title || null,
        alias: alias || null,
        created: Number(created) * 1000,
        activity: Number(activity) * 1000,
        attached: Number(attached),
        cwd,
        command,
        // Claude đã thoát về shell thì coi như hết phiên Claude, dù hook SessionEnd không kịp chạy.
        state: SHELLS.has(command) ? (state ? 'ended' : null) : state || null,
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

// command: 'claude' | 'shell' ('claude-bypass' = claude + bypass, giữ cho tương thích).
async function create({ project, cwd, command, alias, bypass }) {
  if (!COMMANDS.includes(command)) throw new Error('Lệnh không hợp lệ');
  if (command === 'claude-bypass') bypass = true;
  const isClaude = command !== 'shell';
  const names = aliases().map((a) => a.name);
  alias = isClaude ? alias || names[0] : '';
  if (isClaude && !names.includes(alias)) throw new Error(`Alias "${alias}" không có trong ${ALIASES_FILE}`);
  const kind = isClaude ? (bypass ? 'claude-bypass' : 'claude') : 'shell';
  const name = await nextName(project);
  // Gắn tên dự án, loại phiên, alias vào chính session tmux, để restart web vẫn biết phiên thuộc dự án nào.
  await tmux([
    'new-session', '-d', '-s', name, '-c', cwd, '-x', '160', '-y', '45', ...(isClaude ? ['-e', CLAUDE_ENV] : []),
    ';', 'set-option', '@cpm_project', project, ';', 'set-option', '@cpm_kind', kind, ';', 'set-option', '@cpm_alias', alias,
  ]);
  // Mở shell trước rồi mới gõ lệnh, để .bashrc/.zshrc (PATH tới claude, alias) được nạp
  // và khi thoát claude thì phiên vẫn còn shell để dùng tiếp.
  if (isClaude) {
    // bypass: Claude tự chạy mọi lệnh mà không hỏi; mặc định là auto mode.
    const mode = bypass ? '--dangerously-skip-permissions' : '--permission-mode auto';
    await tmux(['send-keys', '-t', `=${name}:`, `${alias} ${mode} ${HOOKS}`, 'Enter']);
  }
  return { name, project, kind, alias, cwd };
}

// Tên hiển thị do anh đặt (lưu ở @cpm_title); tên tmux giữ nguyên vì tab, hàng đợi dựa vào nó. Rỗng = về tên mặc định.
async function setTitle(name, title) {
  if (typeof title !== 'string' || title.length > 60) throw new Error('Tên không hợp lệ');
  title = title.trim();
  await tmux(title ? ['set-option', '-t', `=${name}:`, '@cpm_title', title] : ['set-option', '-u', '-t', `=${name}:`, '@cpm_title']);
}

async function kill(name) {
  if (!validName(name)) throw new Error('Tên phiên không hợp lệ');
  await tmux(['kill-session', '-t', `=${name}`]);
}

// Lấy phần lịch sử đã cuộn khỏi màn hình, để trình duyệt kéo lên xem được.
// plain=true: lấy cả màn hình hiện tại, không kèm mã màu (để xem/copy dạng chữ).
async function history(name, lines = 3000, { plain = false } = {}) {
  try {
    const out = await tmux(['capture-pane', '-p', ...(plain ? [] : ['-e', '-E', '-1']), '-J', '-S', `-${lines}`, '-t', `=${name}:`]);
    return out.replace(/\n+$/, '');
  } catch {
    return '';
  }
}

function setState(name, state) {
  return tmux(['set-option', '-t', `=${name}:`, '@cpm_state', state]);
}

// Gõ một prompt vào phiên: dán theo kiểu bracketed paste (-p) giữ nguyên xuống dòng (-r), rồi Enter.
async function sendText(name, text) {
  const buf = `cpm-${name}`;
  await tmux(['set-buffer', '-b', buf, '--', text]);
  await tmux(['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', `=${name}:`]);
  await new Promise((r) => setTimeout(r, 150));
  await tmux(['send-keys', '-t', `=${name}:`, 'Enter']);
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

module.exports = { SOCKET, validName, aliases, list, exists, create, setTitle, kill, history, setState, sendText, attach };

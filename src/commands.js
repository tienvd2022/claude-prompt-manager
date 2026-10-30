'use strict';

// Danh sách lệnh "/" cho ô prompt: lệnh có sẵn của Claude Code, skill và command của tài khoản (thư mục cấu hình
// theo alias), của plugin đang bật, và của dự án (.claude/skills, .claude/commands).

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILTIN = [
  ['add-dir', 'Thêm thư mục làm việc'],
  ['agents', 'Quản lý subagent'],
  ['clear', 'Xóa hội thoại, bắt đầu lại'],
  ['compact', 'Tóm tắt hội thoại cho đỡ tốn context'],
  ['config', 'Mở cài đặt'],
  ['context', 'Xem context đang dùng'],
  ['cost', 'Chi phí, token của phiên'],
  ['doctor', 'Kiểm tra cài đặt Claude Code'],
  ['exit', 'Thoát Claude'],
  ['export', 'Xuất hội thoại'],
  ['help', 'Trợ giúp'],
  ['hooks', 'Quản lý hook'],
  ['init', 'Tạo CLAUDE.md cho dự án'],
  ['login', 'Đăng nhập'],
  ['logout', 'Đăng xuất'],
  ['mcp', 'Quản lý MCP server'],
  ['memory', 'Sửa file memory'],
  ['model', 'Đổi model'],
  ['permissions', 'Quyền công cụ'],
  ['plugin', 'Quản lý plugin'],
  ['resume', 'Mở lại hội thoại cũ'],
  ['review', 'Review code'],
  ['rewind', 'Quay lại điểm trước trong hội thoại'],
  ['status', 'Trạng thái phiên, tài khoản'],
  ['usage', 'Hạn mức sử dụng'],
].map(([name, description]) => ({ name, description, source: 'Claude Code' }));

const MAX_FILE = 64 * 1024;

// Phần đầu file giữa hai dòng "---": chỉ lấy vài khóa đơn giản (name, description, user-invocable…).
function frontmatter(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_FILE);
    const n = fs.readSync(fd, buf, 0, MAX_FILE, 0);
    fs.closeSync(fd);
    text = buf.subarray(0, n).toString('utf8');
  } catch {
    return {};
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) {
    // Command không có frontmatter: lấy dòng chữ đầu tiên làm mô tả.
    const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    if (line) out.description = line;
    return out;
  }
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      // Khối nhiều dòng (description: >-): gom các dòng thụt vào phía sau.
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      value = parts.filter(Boolean).join(' ');
    } else value = value.replace(/^(['"])(.*)\1$/, '$2');
    out[kv[1]] = value;
  }
  return out;
}

const short = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

// skills/<tên>/SKILL.md (tìm sâu vài cấp: skill đồng bộ từ claude.ai nằm trong skills/synced/<id>/<tên>).
function skills(dir, prefix, source, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    const file = path.join(sub, 'SKILL.md');
    if (fs.existsSync(file)) {
      const fm = frontmatter(file);
      if (fm['user-invocable'] === 'false') continue;
      out.push({ name: `${prefix}${fm.name || e.name}`, description: short(fm.description), source });
    } else if (depth < 2) {
      skills(sub, e.name === 'synced' && depth === 0 ? prefix || 'anthropic-skills:' : prefix, source, out, depth + 1);
    }
  }
}

// commands/<tên>.md, thư mục con thành "con:tên".
function commands(dir, prefix, source, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 2) commands(full, `${prefix}${e.name}:`, source, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.md')) {
      const fm = frontmatter(full);
      out.push({ name: `${prefix}${e.name.slice(0, -3)}`, description: short(fm.description), hint: fm['argument-hint'] || '', source });
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Plugin đã cài và đang bật (settings.json enabledPlugins), lệnh có dạng plugin:tên.
function plugins(configDir, out) {
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'))?.plugins || {};
  const enabled = readJson(path.join(configDir, 'settings.json'))?.enabledPlugins || {};
  for (const [key, list] of Object.entries(installed)) {
    if (enabled[key] === false || !Array.isArray(list) || !list[0]?.installPath) continue;
    const name = key.split('@')[0];
    const dir = list[0].installPath;
    skills(path.join(dir, 'skills'), `${name}:`, `plugin ${name}`, out);
    commands(path.join(dir, 'commands'), `${name}:`, `plugin ${name}`, out);
  }
}

// Thư mục cấu hình của alias: "configDir" trong claude-aliases.json, không có thì đoán theo tên
// (claude-fami -> ~/.claude-fami nếu có), còn lại là ~/.claude.
function configDirOf(alias, configDir) {
  const home = os.homedir();
  if (configDir) return configDir.replace(/^~(?=\/|$)/, home);
  if (alias && alias !== 'claude') {
    const guess = path.join(home, `.${alias}`);
    if (fs.existsSync(path.join(guess, 'settings.json')) || fs.existsSync(path.join(guess, 'projects'))) return guess;
  }
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

function list(projectRoot, alias, configDir) {
  const cfg = configDirOf(alias, configDir);
  const out = [];
  skills(path.join(projectRoot, '.claude', 'skills'), '', 'dự án', out);
  commands(path.join(projectRoot, '.claude', 'commands'), '', 'dự án', out);
  skills(path.join(cfg, 'skills'), '', 'skill', out);
  commands(path.join(cfg, 'commands'), '', 'command', out);
  plugins(cfg, out);
  out.push(...BUILTIN);
  // Trùng tên thì giữ mục đầu (dự án ưu tiên hơn tài khoản, như Claude Code).
  const seen = new Set();
  return out.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

module.exports = { list };

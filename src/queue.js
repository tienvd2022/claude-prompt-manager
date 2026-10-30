'use strict';

// Hàng đợi prompt của từng phiên Claude, nằm trên server để vẫn chạy khi anh tắt trình duyệt.
// Khi hook Stop báo Claude rảnh (@cpm_state = idle) thì gõ prompt tiếp theo vào phiên.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tmux = require('./tmux');
const { httpError } = require('./projects');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'queues.json');
const MAX_ITEMS = 50;
const MAX_TEXT = 100 * 1024;
const TICK_MS = 1500;

let queues = load(); // tên phiên -> [{ id, text }]
let ticking = false;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function save() {
  for (const name of Object.keys(queues)) if (!queues[name].length) delete queues[name];
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queues), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function checkText(text) {
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Prompt trống');
  if (text.length > MAX_TEXT) throw httpError(413, 'Prompt quá dài');
  return text;
}

function get(name) {
  return queues[name] || [];
}

function add(name, text) {
  const list = get(name);
  if (list.length >= MAX_ITEMS) throw httpError(400, `Hàng đợi tối đa ${MAX_ITEMS} prompt`);
  list.push({ id: crypto.randomBytes(6).toString('hex'), text: checkText(text) });
  queues[name] = list;
  save();
  setImmediate(tick);
  return list;
}

// Sửa/xóa/đổi thứ tự: chỉ giữ những prompt còn trong hàng đợi, để prompt vừa được gửi
// trong lúc anh đang sửa không bị thêm lại.
function update(name, items) {
  if (!Array.isArray(items)) throw httpError(400, 'Dữ liệu không hợp lệ');
  const current = new Set(get(name).map((i) => i.id));
  queues[name] = items.filter((i) => current.has(i?.id)).map((i) => ({ id: i.id, text: checkText(i.text) }));
  save();
  return get(name);
}

function drop(name) {
  if (!queues[name]) return;
  delete queues[name];
  save();
}

// Gửi prompt đầu hàng ngay, không chờ trạng thái (dùng khi hàng đợi bị kẹt, ví dụ sau khi bấm Esc).
async function sendNext(name) {
  const item = get(name).shift();
  if (!item) return null;
  save();
  // Đánh dấu "sent" để vòng kiểm tra sau không gửi tiếp trước khi hook UserPromptSubmit kịp chạy.
  await tmux.setState(name, 'sent');
  await tmux.sendText(name, item.text);
  return item;
}

async function tick() {
  if (ticking) return;
  const names = Object.keys(queues).filter((n) => queues[n].length);
  if (!names.length) return;
  ticking = true;
  try {
    const sessions = await tmux.list();
    for (const name of names) {
      const s = sessions.find((x) => x.name === name);
      if (!s) drop(name);
      else if (s.state === 'idle') await sendNext(name);
    }
  } catch (err) {
    console.error('[queue]', err.stderr?.trim() || err.message);
  } finally {
    ticking = false;
  }
}

function start() {
  setInterval(tick, TICK_MS).unref();
}

module.exports = { get, add, update, drop, sendNext, start };

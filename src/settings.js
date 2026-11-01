'use strict';

// Cài đặt chung của giao diện web (phím tắt...), lưu ở data/settings.json để sửa tay bằng editor,
// dùng chung giữa các trình duyệt/thiết bị. Server không hiểu nội dung, chỉ giữ một object JSON.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { httpError } = require('./projects');

const FILE = path.join(DATA_DIR, 'settings.json');
const MAX_BYTES = 64 * 1024;

function get() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {}; // chưa có file hoặc file hỏng: dùng mặc định
  }
}

function set(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, 'settings.json phải là một object JSON');
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) throw httpError(413, 'settings.json quá lớn');
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return data;
}

module.exports = { get, set };

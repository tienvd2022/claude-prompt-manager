'use strict';

const path = require('path');

// Thư mục dữ liệu (mật khẩu, phiên, token git...). Mặc định ./data; bản đóng gói .app đặt CPM_DATA_DIR
// sang ~/Library/Application Support để cập nhật app không mất dữ liệu.
const DATA_DIR = path.resolve(process.env.CPM_DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = { DATA_DIR };

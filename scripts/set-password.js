'use strict';

// Đặt tài khoản đăng nhập web: npm run set-password
// Mật khẩu được nhập ẩn và chỉ lưu dạng hash (scrypt) trong data/auth.json.

const readline = require('readline');
const { saveAuthConfig, AUTH_FILE } = require('../src/auth');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const username = (await ask('Tên đăng nhập [admin]: ')).trim() || 'admin';
  const password = await ask('Mật khẩu (tối thiểu 12 ký tự): ', { hidden: true });
  if (password.length < 12) {
    console.error('Mật khẩu quá ngắn.');
    process.exit(1);
  }
  const again = await ask('Nhập lại mật khẩu: ', { hidden: true });
  if (password !== again) {
    console.error('Hai lần nhập không khớp.');
    process.exit(1);
  }
  saveAuthConfig(username, password);
  console.log(`Đã lưu vào ${AUTH_FILE}. Các phiên đăng nhập cũ đã bị đăng xuất.`);
  console.log('Khởi động lại service để áp dụng: systemctl --user restart claude-prompt-manager');
})();

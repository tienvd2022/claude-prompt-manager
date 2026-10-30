#!/usr/bin/env bash
# Cài hoặc cập nhật trên server, chạy bằng user thường (không phải root):
#   bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=claude-prompt-manager.service
cd "$APP_DIR"

if [ "$(id -u)" = 0 ]; then
  echo "Đừng chạy bằng root. Chạy bằng user sẽ dùng Claude." >&2
  exit 1
fi
command -v tmux >/dev/null || { echo "Thiếu tmux" >&2; exit 1; }
command -v node >/dev/null || { echo "Thiếu node" >&2; exit 1; }

if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q yes; then
  echo "Cần root bật linger 1 lần để service tự chạy khi chưa đăng nhập:" >&2
  echo "  sudo loginctl enable-linger $USER" >&2
  exit 1
fi

npm ci --omit=dev

if [ ! -f data/auth.json ]; then
  echo "== Tạo tài khoản đăng nhập web"
  npm run --silent set-password
fi

mkdir -p ~/.config/systemd/user
sed "s#__APP_DIR__#$APP_DIR#" deploy/$UNIT > ~/.config/systemd/user/$UNIT
systemctl --user daemon-reload
systemctl --user enable $UNIT >/dev/null
systemctl --user restart $UNIT
sleep 1
systemctl --user --no-pager status $UNIT | head -5
echo "OK: http://127.0.0.1:${PORT:-4777} (trỏ reverse proxy của CloudPanel vào đây)"

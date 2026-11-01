#!/bin/bash
# Script điều khiển server của CPM-server.app (app thanh menu gọi: start | start-bg | stop | status | url | autostart | autostart-on | autostart-off).
# start-bg: không hiện hộp thoại (dùng khi tự chạy lúc mở máy).

RES="$(cd "$(dirname "$0")" && pwd)"
SUPPORT="$HOME/Library/Application Support/Claude Prompt Manager"
CONFIG="$SUPPORT/config.env"
LOG="$SUPPORT/server.log"
PIDFILE="$SUPPORT/server.pid"
AGENT_LABEL="vn.nhanhnhau.claude-prompt-manager"
AGENT="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
CMD="${1:-start}"
BACKGROUND=0; [ "$CMD" = "start-bg" ] && BACKGROUND=1

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$SUPPORT"

say() { [ "$BACKGROUND" = 1 ] || osascript -e "display dialog \"$1\" with title \"Claude Prompt Manager\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1; }

if [ ! -f "$CONFIG" ]; then
  cat > "$CONFIG" <<'EOF'
# Cấu hình Claude Prompt Manager. Sửa xong thì mở app, chọn "Dừng server", rồi mở lại.
# Thư mục chứa các dự án:
PROJECTS_DIR=~/projects
# Thư mục dữ liệu (mật khẩu, danh sách dự án, phiên...). Bỏ trống = dùng thư mục riêng của app. Muốn dùng chung với bản chạy từ source thì trỏ tới thư mục data của source.
# CPM_DATA_DIR=
# Cổng. Địa chỉ 127.0.0.1 = chỉ máy này truy cập được.
# Muốn điện thoại cùng Wi-Fi vào được thì đổi thành 0.0.0.0 (chỉ nên dùng trong mạng tin cậy: đăng nhập đi qua HTTP không mã hóa).
PORT=4777
HOST=127.0.0.1
COOKIE_SECURE=0
EOF
fi
set -a; . "$CONFIG"; set +a
PORT="${PORT:-4777}"
export CPM_DATA_DIR="${CPM_DATA_DIR:-$SUPPORT/data}"
URL="http://localhost:$PORT"

is_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; }
stop_server() {
  if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; fi
}

start_server() {
  command -v tmux >/dev/null || { say "Máy chưa có tmux. Mở Terminal gõ: brew install tmux (chưa có brew thì cài từ brew.sh), rồi mở lại app."; exit 1; }
  # Đăng nhập lần đầu: hỏi mật khẩu
  if [ ! -f "$CPM_DATA_DIR/auth.json" ]; then
    [ "$BACKGROUND" = 1 ] && exit 1
    while true; do
      pw=$(osascript -e 'text returned of (display dialog "Đặt mật khẩu đăng nhập (tối thiểu 12 ký tự). Tên đăng nhập là admin." with title "Claude Prompt Manager" default answer "" with hidden answer buttons {"Hủy","Đặt"} default button 2)' 2>/dev/null) || exit 0
      [ "${#pw}" -ge 12 ] && break
      say "Mật khẩu phải từ 12 ký tự trở lên."
    done
    CPM_PW="$pw" "$RES/node" -e "require('$RES/app/src/auth').saveAuthConfig('admin', process.env.CPM_PW)" || { say "Không lưu được mật khẩu."; exit 1; }
  fi
  cd "$RES/app" || exit 1
  nohup "$RES/node" src/server.js >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 30); do is_up && return 0; sleep 0.5; done
  say "Server không lên được. Xem log: $LOG"
  exit 1
}

autostart_on() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$AGENT" <<EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$AGENT_LABEL</string>
<key>ProgramArguments</key><array><string>$RES/../MacOS/CPM-server</string><string>--background</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF2
  launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null
}
autostart_off() { launchctl bootout "gui/$(id -u)" "$AGENT" 2>/dev/null; rm -f "$AGENT"; }

# Lệnh do app thanh menu (CPM-server) gọi
case "$CMD" in
  start)      is_up || start_server ;;
  start-bg)   is_up || start_server ;;
  stop)       stop_server ;;
  status)     is_up && echo up || echo down ;;
  url)        echo "$URL" ;;
  autostart)  [ -f "$AGENT" ] && echo on || echo off ;;
  autostart-on)  autostart_on ;;
  autostart-off) autostart_off ;;
esac

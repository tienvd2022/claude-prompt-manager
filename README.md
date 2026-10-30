# Claude Prompt Manager

Web UI nhỏ để làm việc với Claude Code trên server, kể cả từ điện thoại.

Luồng dùng: đăng nhập → chọn dự án → mở nhiều tab (mỗi tab là một phiên Claude hoặc terminal) → prompt.

- **Dự án**: mọi dự án nằm trong một thư mục (`~/projects`, đổi bằng `PROJECTS_DIR`), mỗi dự án là một thư mục con. Tạo thư mục trống hoặc clone từ git.
- **Mở thư mục bất kỳ**: nút 📂 ở trang Dự án để duyệt thư mục trên server và mở một thư mục con (vd chỗ có `.git`) hoặc thư mục nằm ngoài thư mục dự án. Thư mục này chỉ hiện trong danh sách dự án khi còn phiên đang chạy; kết thúc hết phiên thì ẩn, vào lại bằng 📂 → "🕘 Gần đây" (✕ để bỏ thư mục khỏi danh sách gần đây, không xóa trên đĩa).
- **Phiên**: mỗi tab là một session tmux (socket riêng `-L cpm`) chạy trong thư mục dự án. Đóng tab hay đóng web thì Claude vẫn chạy.
- **File**: duyệt thư mục, bấm file để xem (chữ, ảnh, SVG) và ✎ Sửa file chữ ngay trên web; ấn giữ (hoặc ⋯) để tải file/thư mục (.tar.gz), đổi tên, xóa, chèn `@đường-dẫn` vào prompt. Upload bằng nút hoặc kéo thả.
- **Git**: đổi/tạo nhánh; xem thay đổi hiện tại (diff hoặc xem file), commit tất cả; lịch sử commit → file đổi trong commit → diff hoặc xem file tại commit đó; fetch / pull (`--ff-only`) / push. **Tự đồng bộ** (bật riêng từng dự án, nhớ trên trình duyệt): vào dự án thì pull nếu fast-forward được, thấy commit mới (kể cả Claude commit) thì push ngay; nhánh đã tách hoặc chưa có trên remote thì không tự làm gì. Clone/push qua SSH dùng key của server.
- Thanh phím (Esc, Tab, ↑↓, ^C, Ctrl giữ, lịch sử prompt…; nút ⋯ để ẩn/sắp xếp) và ô gõ prompt cho điện thoại: nhập bằng giọng nói, đính kèm/dán ảnh.
- **Hàng đợi prompt**: bấm ⏳ để xếp prompt, server tự gửi prompt tiếp theo khi Claude xong lượt (kể cả khi đã tắt web). Trạng thái lấy từ hook của Claude Code (`src/claude-hooks.json`, nạp qua `--settings`), nên chỉ có ở phiên Claude mở từ bản này trở đi. Bấm Esc ngắt Claude thì hàng đợi không tự chạy tiếp: mở 📋 và bấm "Gửi tiếp ngay".
- Claude được mở với `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` để nội dung trôi vào lịch sử: vuốt lên xem lại được. Nút 📄 mở nội dung phiên dạng chữ để chọn/copy trên điện thoại; ở phiên Claude, các dòng Claude tự ngắt theo độ rộng màn hình lúc in được nối lại thành đoạn liền (lệnh và kết quả công cụ giữ nguyên).
- **Trình duyệt riêng từng phiên** (nút 🌐 trên thanh phím): mỗi phiên Claude có một Chromium headless riêng, Claude test web qua Playwright MCP (`cpm-browser`, gắn sẵn bằng `--mcp-config`) hoặc script Playwright `chromium.connectOverCDP(process.env.CPM_CDP_URL)`. Bấm 🌐 để xem trực tiếp trình duyệt đó, bấm/gõ/cuộn/đổi URL/đổi tab được, ⏻ Tắt để đóng hẳn. Chromium chỉ bật khi có người dùng và tự tắt sau `CPM_BROWSER_IDLE_MIN` phút (mặc định 15) không ai dùng; dùng lại thì tự bật. RAM: Chromium ~300MB khi đang chạy; tiến trình Playwright MCP ~170MB chạy suốt theo mỗi phiên Claude. Cần Chromium trên máy: `npx playwright install chromium-headless-shell` (Linux thiếu thư viện hệ thống thì root chạy `npx playwright install-deps chromium`); chưa có thì phiên mới không gắn MCP. Tắt cả tính năng: `CPM_BROWSER=0`. Chỉ có ở phiên Claude mở từ bản này trở đi.
- **Đổi tên phiên** bằng nút ✎ trong menu phiên (chỉ đổi tên hiển thị, tên tmux giữ nguyên).
- **Nhiều tài khoản Claude**: khai báo các alias đã có sẵn trong shell của server (vd `claude-fami='CLAUDE_CONFIG_DIR=~/.claude-fami claude'`) vào `data/claude-aliases.json`, kèm mô tả để biết alias nào là tài khoản nào:
  ```json
  { "default": "claude-fami", "aliases": [
    { "name": "claude", "description": "Tài khoản cá nhân" },
    { "name": "claude-fami", "description": "Tài khoản Fami" }
  ] }
  ```
  Bấm nút Claude thường thì mở alias `default` (không ghi thì lấy alias đầu tiên); nhấn giữ nút Claude để chọn alias khác, bật/tắt bypass permissions và thêm tham số cho lệnh claude (vd `--resume <id>`, `--continue`, `--model opus`). Phiên chạy alias khác `claude` có thêm `(alias)` sau tên. Sửa file không cần restart.
- Chạy dưới user thường, không cần root. Lệnh Claude chạy có đúng quyền của user đó.
- **App mobile** (Android/iOS, React Native) ở [mobile/](mobile/README.md): nhập địa chỉ server rồi dùng y như bản web. Feature mới làm cho web thì app có luôn sau khi deploy server.

## Bảo mật

- Một tài khoản admin, mật khẩu lưu dạng hash scrypt trong `data/auth.json` (quyền 600).
- Rate limit: 5 lần sai/IP thì khóa IP 15 phút; 30 lần sai/giờ trên toàn hệ thống thì khóa đăng nhập 15 phút.
- Cookie `HttpOnly; Secure; SameSite=Strict`, hạn 7 ngày. Kiểm tra `Origin` cho mọi request ghi và WebSocket.
- WebSocket terminal kiểm tra đăng nhập riêng; đăng xuất là cắt ngay mọi kết nối.
- Chỉ nghe `127.0.0.1`, ra ngoài qua nginx (HTTPS). CSP chặn script lạ.
- Service bị giới hạn `MemoryMax=1500M`, `CPUWeight=20` để không ảnh hưởng các website khác.

## Cài trên server

Hướng dẫn đầy đủ từng bước, kèm xử lý sự cố: [docs/guide/DEPLOY.md](docs/guide/DEPLOY.md). Tóm tắt:

```bash
# 1 lần, bằng root: cho service của user chạy cả khi chưa đăng nhập
loginctl enable-linger tientieu

# bằng user tientieu
git clone <repo> ~/claude-prompt-manager
cd ~/claude-prompt-manager
bash deploy/install.sh        # hỏi tạo tài khoản web lần đầu
```

Cập nhật: `git pull && bash deploy/install.sh`. Các phiên Claude đang chạy không bị tắt.

### Trỏ domain (CloudPanel)

Sites → Add Site → **Create a Reverse Proxy** → domain, Reverse Proxy URL `http://127.0.0.1:4777` → bật SSL Let's Encrypt.
Template của CloudPanel đã có header WebSocket, không cần sửa thêm.

Upload file lớn qua nginx: nginx mặc định giới hạn body (CloudPanel thường để vài chục MB). Nếu cần upload file lớn hơn thì tăng `client_max_body_size` trong vhost của site này. App tự giới hạn ở `MAX_UPLOAD_MB` (mặc định 512).

Nếu domain đi qua Cloudflare (proxy cam), IP thấy được là IP Cloudflare nên rate limit theo IP gần như thành rate limit chung — vẫn an toàn, chỉ là dễ bị khóa chung hơn.

### Git qua SSH

1. Trên web: ⚙ (màn Dự án) → **Tạo SSH key** → Copy public key.
2. Thêm key vào GitHub → Settings → SSH keys (hoặc Deploy keys của từng repo nếu muốn giới hạn).
3. Điền tên/email hiện trong commit rồi Lưu.

Host lạ được tự chấp nhận lần đầu (`StrictHostKeyChecking=accept-new`). Git không bao giờ hỏi mật khẩu trên web: repo HTTPS riêng tư sẽ báo lỗi, hãy dùng URL SSH.

## Dùng hằng ngày

| Việc | Cách |
|---|---|
| Đổi mật khẩu web | `npm run set-password` rồi `systemctl --user restart claude-prompt-manager` |
| Xem log | `journalctl --user -u claude-prompt-manager -f` |
| Vào phiên từ SSH | `tmux -L cpm ls`, `tmux -L cpm attach -t <tên>` (thoát: `Ctrl+b d`) |
| Domain, giới hạn upload, thư mục dự án | ghi `ALLOWED_ORIGINS=...`, `MAX_UPLOAD_MB=...`, `PROJECTS_DIR=...` vào `~/.config/claude-prompt-manager.env` (hoặc `.env` trong thư mục app) rồi restart |
| Đổi cổng/giới hạn RAM | sửa `deploy/claude-prompt-manager.service` rồi chạy lại `install.sh` |

## Chạy trên máy cá nhân (Mac/Linux)

Cần Node ≥ 20.12, tmux (`brew install tmux`), Claude Code, công cụ build cho `node-pty` (Mac: Xcode Command Line Tools).

```bash
npm ci
npm run set-password
cp .env.example .env      # sửa PROJECTS_DIR, bật COOKIE_SECURE=0
npm start                 # mở http://localhost:4777
```

Cấu hình nằm trong `.env` (xem `.env.example` cho đủ các biến). Biến đặt từ ngoài, ví dụ `PORT=4800 npm start`, được ưu tiên hơn `.env`.

Lưu ý khi chạy trên máy cá nhân: cài đặt Git trong ⚙ ghi vào `git config --global` thật của máy; nút Xóa trong file manager là xóa hẳn, không vào Thùng rác.

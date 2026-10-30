# Claude Prompt Manager

Web UI nhỏ để mở, xem và prompt các phiên Claude Code chạy trên server, kể cả từ điện thoại.

- Mỗi phiên là một session tmux (socket riêng `-L cpm`). Đóng tab hay đóng web thì Claude vẫn chạy.
- Có tab, danh sách phiên, tạo/kết thúc phiên, thanh phím (Esc, Tab, ↑↓, ^C) và ô gõ prompt cho điện thoại.
- Chạy dưới user thường, không cần root. Lệnh Claude chạy có đúng quyền của user đó.

## Bảo mật

- Một tài khoản admin, mật khẩu lưu dạng hash scrypt trong `data/auth.json` (quyền 600).
- Rate limit: 5 lần sai/IP thì khóa IP 15 phút; 30 lần sai/giờ trên toàn hệ thống thì khóa đăng nhập 15 phút.
- Cookie `HttpOnly; Secure; SameSite=Strict`, hạn 7 ngày. Kiểm tra `Origin` cho mọi request ghi và WebSocket.
- WebSocket terminal kiểm tra đăng nhập riêng; đăng xuất là cắt ngay mọi kết nối.
- Chỉ nghe `127.0.0.1`, ra ngoài qua nginx (HTTPS). CSP chặn script lạ.
- Service bị giới hạn `MemoryMax=1500M`, `CPUWeight=20` để không ảnh hưởng các website khác.

## Cài trên server

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

Nếu domain đi qua Cloudflare (proxy cam), IP thấy được là IP Cloudflare nên rate limit theo IP gần như thành rate limit chung — vẫn an toàn, chỉ là dễ bị khóa chung hơn.

## Dùng hằng ngày

| Việc | Cách |
|---|---|
| Đổi mật khẩu web | `npm run set-password` rồi `systemctl --user restart claude-prompt-manager` |
| Xem log | `journalctl --user -u claude-prompt-manager -f` |
| Vào phiên từ SSH | `tmux -L cpm ls`, `tmux -L cpm attach -t <tên>` (thoát: `Ctrl+b d`) |
| Đổi cổng/giới hạn RAM | sửa `deploy/claude-prompt-manager.service` rồi chạy lại `install.sh` |

Chạy thử ở máy cá nhân (không HTTPS): `COOKIE_SECURE=0 npm start`.

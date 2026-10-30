# Hướng dẫn deploy

Deploy lên VPS Ubuntu (CloudPanel), app chạy bằng user thường `tientieu`, không đụng các website khác.

Sơ đồ: `trình duyệt → https://domain (nginx CloudPanel) → 127.0.0.1:4777 (app) → tmux -L cpm (các phiên Claude)`.

| Ai làm | Bước |
|---|---|
| Máy Mac | 1. Đưa code lên git |
| root | 2. Bật linger cho `tientieu` (1 lần) |
| tientieu | 3. Lấy code về server · 4. Chạy `install.sh` · 5. Kiểm tra |
| CloudPanel | 6. Tạo site Reverse Proxy + SSL |
| tientieu | 7. Khai báo domain cho app |
| Trên web | 8. SSH key + tên/email git · 9. Đăng nhập Claude |

## 0. Yêu cầu

Server hiện đã có đủ (kiểm tra ngày 2026-10-30): Ubuntu 24.04, Node 20, tmux 3.4, git 2.43, gcc/make/python3 (để build `node-pty`), Claude Code ở `~/.local/bin/claude` của `tientieu`.

Kiểm tra lại nếu cần:

```bash
node -v && tmux -V && git --version && which gcc make python3
bash -lc 'claude --version'
```

## 1. Đưa code lên git (trên Mac)

Tạo một repo **private** trên GitHub (ví dụ `claude-prompt-manager`), rồi:

```bash
cd ~/DATA/Projects/Others/claude-prompt-manager
git remote add origin git@github.com:<tài-khoản>/claude-prompt-manager.git
git push -u origin main
```

## 2. Bật linger (root, chỉ 1 lần)

Để service của `tientieu` tự chạy khi server khởi động, kể cả khi không ai SSH vào:

```bash
loginctl enable-linger tientieu
loginctl show-user tientieu --property=Linger   # phải ra Linger=yes
```

Đây là việc duy nhất cần root. Không cần sửa nginx bằng tay, không restart service nào khác.

## 3. Lấy code về server (user tientieu)

Server cần quyền đọc repo private. Cách gọn nhất là dùng chính SSH key mà app sẽ dùng cho git:

```bash
ssh tientieu@212.85.24.87
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "tientieu@vps"
cat ~/.ssh/id_ed25519.pub
```

Thêm public key vừa in ra vào GitHub → Settings → SSH and GPG keys (để clone/push mọi repo của anh). Nếu chỉ muốn cho phép repo này thì thêm vào Deploy keys của repo. Sau đó:

```bash
git clone git@github.com:<tài-khoản>/claude-prompt-manager.git ~/claude-prompt-manager
```

Key này nằm sẵn ở `~/.ssh/id_ed25519`, nên ở bước 8 web sẽ tự nhận và hiện ra, không cần tạo lại.

## 4. Cài đặt

```bash
cd ~/claude-prompt-manager
bash deploy/install.sh
```

Script sẽ:
- `npm ci` (build `node-pty`, mất khoảng 1 phút);
- lần đầu thì hỏi **tên đăng nhập và mật khẩu web** (tối thiểu 12 ký tự, nhập ẩn, lưu dạng hash ở `data/auth.json`);
- cài systemd user service `claude-prompt-manager` (giới hạn RAM 1.5 GB, CPU ưu tiên thấp) và chạy nó.

Dự án sẽ nằm ở `~/projects` (tự tạo, quyền 700).

## 5. Kiểm tra

```bash
systemctl --user status claude-prompt-manager --no-pager | head -5   # active (running)
curl -sI http://127.0.0.1:4777/login | head -1                       # HTTP/1.1 200 OK
```

Muốn thử ngay mà chưa có domain thì dùng tunnel từ Mac, rồi mở `http://localhost:4777`:

```bash
ssh -N -L 4777:127.0.0.1:4777 tientieu@212.85.24.87
```

Lưu ý: qua tunnel là HTTP nên cookie `Secure` không lưu được và sẽ không đăng nhập được. Chỉ dùng tunnel để xem trang login, hoặc chạy tạm `COOKIE_SECURE=0` (xem phần Xử lý sự cố). Dùng thật thì đi qua domain HTTPS.

## 6. Tạo site trong CloudPanel

Bước này làm nginx reload. Reload không làm rớt các website đang chạy, nhưng anh nên làm lúc ít truy cập.

1. **Sites → Add Site → Create a Reverse Proxy**
   - Domain: ví dụ `claude.domain-cua-anh.com` (trỏ DNS A record về `212.85.24.87` trước)
   - Reverse Proxy URL: `http://127.0.0.1:4777`
   - Site User: đặt tên mới, ví dụ `cpm` (user này chỉ để CloudPanel quản lý site, app không dùng)
2. Vào site vừa tạo → **SSL/TLS → Actions → New Let's Encrypt Certificate**.
3. Upload file lớn (tùy chọn): mặc định nginx giới hạn body khá nhỏ. Vào **Vhost** của site, trong `server { ... }` thêm hoặc sửa:

   ```nginx
   client_max_body_size 512m;
   ```

   Rồi Save. Không cần thì bỏ qua; upload quá giới hạn web sẽ báo "File quá lớn".

Template reverse proxy của CloudPanel đã có header cho WebSocket (`Upgrade`/`Connection`) và `X-Forwarded-For`, không cần sửa gì thêm.

## 7. Khai báo domain cho app

App chặn mọi request ghi và WebSocket không đến từ đúng domain (chống CSRF). Khai báo domain trong file cấu hình riêng (nằm ngoài repo nên `git pull` không đè):

```bash
cat > ~/.config/claude-prompt-manager.env <<'EOF'
ALLOWED_ORIGINS=https://claude.domain-cua-anh.com
# MAX_UPLOAD_MB=512
EOF
chmod 600 ~/.config/claude-prompt-manager.env
systemctl --user restart claude-prompt-manager
```

Mở `https://claude.domain-cua-anh.com` và đăng nhập bằng tài khoản ở bước 4.

## 8. Cài đặt git trên web

Màn **Dự án** → nút **⚙**:
- **Tên/Email** hiện trong commit → Lưu.
- **SSH key**: key ở bước 3 đã hiện sẵn. Nếu bỏ qua bước 3 thì bấm **Tạo SSH key**, Copy rồi thêm vào GitHub.

Thử: **＋ Dự án mới** → dán URL SSH của một repo (`git@github.com:...`) → Tạo. Repo HTTPS private không clone được vì web không bao giờ hỏi mật khẩu; hãy dùng URL SSH.

## 9. Đăng nhập Claude (1 lần)

Mở một dự án → **＋ → ✳ Claude** → trong tab gõ `/login`, chọn đăng nhập bằng subscription, mở link hiện ra trên trình duyệt, dán mã vào lại tab.

Hoặc làm qua SSH: `ssh tientieu@212.85.24.87` → `claude` → `/login`. Hai cách dùng chung `~/.claude` nên chỉ cần làm một lần.

---

## Cập nhật phiên bản mới

Trên Mac: commit rồi `git push`. Trên server:

```bash
cd ~/claude-prompt-manager && git pull && bash deploy/install.sh
```

Restart web **không** tắt các phiên Claude đang chạy (chúng nằm trong tmux; service dùng `KillMode=process`). Tab trên trình duyệt sẽ tự kết nối lại.

## Lệnh hay dùng

| Việc | Lệnh |
|---|---|
| Xem log | `journalctl --user -u claude-prompt-manager -f` |
| Restart / dừng | `systemctl --user restart claude-prompt-manager` / `stop` |
| Đổi mật khẩu web | `cd ~/claude-prompt-manager && npm run set-password && systemctl --user restart claude-prompt-manager` |
| Xem các phiên | `tmux -L cpm ls` |
| Vào một phiên từ SSH | `tmux -L cpm attach -t <tên>` (thoát mà không tắt: `Ctrl+b` rồi `d`) |
| Tắt hết phiên Claude | `tmux -L cpm kill-server` |
| Sao lưu dự án | `tar -czf projects-$(date +%F).tar.gz -C ~ projects` |

## Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| `install.sh` báo cần linger | Chưa làm bước 2. |
| `npm ci` lỗi khi build `node-pty` | Thiếu công cụ build: root chạy `apt install build-essential python3`. |
| Đăng nhập xong vẫn quay về trang login | Đang vào bằng HTTP. Phải dùng HTTPS, hoặc khi thử qua tunnel thì thêm `COOKIE_SECURE=0` vào file `.env` rồi restart (nhớ bỏ đi sau khi thử). |
| Bấm nút báo lỗi 403 / terminal không kết nối | `ALLOWED_ORIGINS` sai hoặc thiếu (bước 7). Phải đúng cả `https://` và domain, không có `/` ở cuối. |
| "Thử lại sau ... phút" khi đăng nhập | Bị khóa do nhập sai nhiều lần. Đợi 15 phút, hoặc `systemctl --user restart claude-prompt-manager` để mở khóa ngay. |
| Upload báo "File quá lớn" | Tăng `client_max_body_size` (bước 6.3) và/hoặc `MAX_UPLOAD_MB` (bước 7). |
| Clone/push báo `Permission denied (publickey)` | Chưa thêm SSH key vào GitHub, hoặc Deploy key chưa bật quyền ghi (khi push). |
| Pull báo không fast-forward | Nhánh đã lệch so với remote. Mở tab Terminal xử lý bằng tay (`git pull --rebase` hoặc merge). |
| Tab Claude báo `claude: command not found` | Claude chưa cài cho `tientieu`. Kiểm tra `bash -lc 'which claude'`. |
| Phiên Claude bị tắt đột ngột | Có thể vượt `MemoryMax=1500M`. Xem `journalctl --user -u claude-prompt-manager`; bớt số phiên chạy cùng lúc hoặc tăng giới hạn trong `deploy/claude-prompt-manager.service`. |

## Gỡ cài đặt

```bash
systemctl --user disable --now claude-prompt-manager
rm ~/.config/systemd/user/claude-prompt-manager.service
systemctl --user daemon-reload
tmux -L cpm kill-server            # tắt các phiên Claude
rm -rf ~/claude-prompt-manager     # code + data/auth.json; ~/projects vẫn giữ
```

Rồi xóa site trong CloudPanel. Root có thể tắt linger: `loginctl disable-linger tientieu`.

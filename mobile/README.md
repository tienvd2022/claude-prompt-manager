# App mobile (React Native)

App Android/iOS cho Claude Prompt Manager. Mở app → nhập địa chỉ server (vd `https://prompt.domain.vn`) → đăng nhập → dùng y như bản web.

- App là WebView chạy chính bản web của server, nên **sửa web và deploy server là app có luôn**, không cần build lại. Chỉ build lại khi sửa code trong `mobile/`.
- Lưu nhiều server, mở lại server dùng lần trước. Đổi server: nút ⇄ ở trang Dự án hoặc nút "Đổi server" ở trang đăng nhập. Đặt tên server lúc kết nối (không bắt buộc, để trống thì lấy tên miền). Sửa tên/địa chỉ server đã lưu: nút ✎ hoặc nhấn giữ. Xóa: nút ✕.
- Tải file/thư mục: Android lưu vào thư mục **Download**; iOS mở bảng chia sẻ (Lưu vào Tệp…), file cũng nằm trong app Tệp → Trên iPhone → Prompt Manager.
- Upload file, đính kèm ảnh, dán ảnh, giọng nói (bàn phím) dùng như trên trình duyệt điện thoại. Bảng chọn file trên Android chỉ có chọn file, không kèm chụp camera (manifest khai báo quyền CAMERA nhưng không bao giờ xin, để react-native-webview bỏ lựa chọn chụp).
- Link ra ngoài server mở bằng trình duyệt của máy. Android: nút Back quay lại trong trang.
- Server `http://` (mạng LAN, `COOKIE_SECURE=0`) cũng kết nối được.

Không dùng Expo/EAS: mọi bản build chạy trên máy này, không tốn phí.

## Cần có

Node ≥ 22.11, JDK 17, Android SDK (biến `ANDROID_HOME`), Xcode + CocoaPods (cho iOS).

```bash
cd mobile
npm ci
npm run ios:pods      # chỉ cho iOS, chạy lại khi thêm thư viện native
```

## Build development (có Metro, sửa code thấy ngay)

```bash
npm start             # Metro, để chạy riêng 1 terminal
npm run android       # cài lên máy Android cắm cáp (bật USB debugging) hoặc emulator
npm run ios           # simulator; máy thật: npm run ios -- --device
```

## Build release (rút cáp vẫn chạy, JS đóng gói sẵn trong app)

### Android

Key ký release nằm ở `android/app/release.keystore` + `android/keystore.properties` (không đưa lên git). **Sao lưu 2 file này**: mất key thì bản sau không cài đè được, phải gỡ app cũ (mất server đã lưu). Máy mới chưa có key thì chép 2 file vào, hoặc tạo key mới bằng `npm run android:keystore`.

```bash
npm run android:apk       # ra file android/app/build/outputs/apk/release/app-release.apk
npm run android:release   # build + cài thẳng lên máy đang cắm cáp
```

File APK gửi qua Zalo/Drive rồi cài trên điện thoại (cho phép "cài ứng dụng không rõ nguồn gốc").

### iOS

Lần đầu: mở `ios/CPMMobile.xcworkspace` bằng Xcode → target CPMMobile → Signing & Capabilities → chọn Team (đổi Bundle Identifier nếu Xcode báo trùng).

```bash
npm run ios:release -- --device   # build Release + cài lên iPhone đang cắm cáp
```

Hoặc trong Xcode: Product → Scheme → Edit Scheme → Run → Build Configuration = Release, rồi Run.
Với Apple ID miễn phí, app hết hạn sau 7 ngày (cài lại là chạy tiếp); tài khoản Developer trả phí thì 1 năm.

## Cấu trúc

| File | Việc |
|---|---|
| `App.tsx` | Chọn màn: chọn server hoặc WebView |
| `src/ServerScreen.tsx` | Nhập/lưu server, kiểm tra đúng là Claude Prompt Manager |
| `src/WebScreen.tsx` | WebView, nhận tin nhắn từ web, xử lý bàn phím Android, lỗi mạng |
| `src/download.ts` | Tải file bằng link dùng một lần (web xin ở `POST /api/projects/:p/download-ticket`) |

Web nhận biết đang chạy trong app qua `window.CPM_APP` (app tiêm vào) và `nativeApp` trong `public/common.js`.
Tin nhắn web → app (xuất PDF ở khung Preview cũng tải qua `download`): `{ type: 'download', url, name }`, `{ type: 'switchServer' }`. Feature web mới nào cần thứ WebView không tự làm được (tải file, chia sẻ, mở cửa sổ…) thì thêm loại tin nhắn mới ở đây.

Sửa tên app: `android/app/src/main/res/values/strings.xml`, `ios/CPMMobile/Info.plist` (`CFBundleDisplayName`). Tăng phiên bản: `versionCode`/`versionName` trong `android/app/build.gradle`, `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` trong Xcode.

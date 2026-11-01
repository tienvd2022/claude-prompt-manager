#!/bin/bash
# Đóng gói "CPM-server.app" (macOS). Chạy: bash packaging/mac/build.sh
# Kết quả: dist/CPM-server.app, kèm sẵn Node và node_modules (build cho kiến trúc máy đang build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/dist/CPM-server.app"
NODE_BIN="$(readlink -f "$(command -v node)")"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp "$ROOT/packaging/mac/ctl.sh" "$APP/Contents/Resources/ctl.sh"
swiftc -O -o "$APP/Contents/MacOS/CPM-server" "$ROOT/packaging/mac/CPMServer.swift"
cp "$ROOT/packaging/mac/open-computer-use.sh" "$APP/Contents/Resources/open-computer-use.sh"
cp "$NODE_BIN" "$APP/Contents/Resources/node"

cd "$ROOT"
cp -R src public scripts package.json package-lock.json "$APP/Contents/Resources/app/"
rm -rf "$APP/Contents/Resources/app/public/preview-lib/.cpm" 2>/dev/null || true
(cd "$APP/Contents/Resources/app" && PATH="$(dirname "$NODE_BIN"):$PATH" npm ci --omit=dev --no-audit --no-fund)

# Icon
ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
SRC="$ROOT/mobile/ios/CPMMobile/Images.xcassets/AppIcon.appiconset/icon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

VERSION="$(node -p "require('./package.json').version")"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>CPM-server</string>
<key>CFBundleDisplayName</key><string>CPM-server</string>
<key>CFBundleIdentifier</key><string>vn.nhanhnhau.claude-prompt-manager</string>
<key>CFBundleExecutable</key><string>CPM-server</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>LSUIElement</key><true/>
</dict></plist>
EOF
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Xong: $APP ($(du -sh "$APP" | cut -f1))"

#!/bin/bash
# Build app macOS (Mac Catalyst) từ project iOS, ký ad-hoc để chạy trên máy này / máy quen
# (không cần tài khoản Apple Developer). Kết quả: ios/build/CPM.app và ios/build/CPM-mac.zip.
# Hardened runtime phải tắt: bật nó với chữ ký ad-hoc thì dyld từ chối nạp React.framework.
set -euo pipefail
cd "$(dirname "$0")/../ios"
[ -d Pods ] || pod install
xcodebuild -workspace CPMMobile.xcworkspace -scheme CPMMobile -configuration Release \
  -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath build/catalyst \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  ENABLE_HARDENED_RUNTIME=NO build | grep -E "error:|warning: \[CP\]|BUILD (SUCCEEDED|FAILED)" || true
APP=build/catalyst/Build/Products/Release-maccatalyst/CPMMobile.app
[ -d "$APP" ] && codesign -v --deep "$APP"
rm -rf build/CPM.app build/CPM-mac.zip
cp -R "$APP" build/CPM.app
ditto -c -k --keepParent build/CPM.app build/CPM-mac.zip
echo "OK: $(pwd)/build/CPM.app ($(du -sh build/CPM-mac.zip | cut -f1) zip)"

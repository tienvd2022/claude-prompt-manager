#!/usr/bin/env bash
# Tạo key ký bản release Android (chạy 1 lần). Sao lưu 2 file tạo ra, mất là không cài đè bản cũ được.
set -euo pipefail
cd "$(dirname "$0")/../android"
if [ -f keystore.properties ]; then
  echo "Đã có android/keystore.properties, không tạo lại." >&2
  exit 1
fi
PASS="$(openssl rand -hex 16)"
keytool -genkeypair -v -storetype PKCS12 -keystore app/release.keystore -alias cpm \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" -dname "CN=Claude Prompt Manager"
cat > keystore.properties <<PROPS
storeFile=release.keystore
storePassword=$PASS
keyAlias=cpm
keyPassword=$PASS
PROPS
chmod 600 keystore.properties app/release.keystore
echo "Đã tạo android/app/release.keystore và android/keystore.properties. Hãy sao lưu cả 2 file."

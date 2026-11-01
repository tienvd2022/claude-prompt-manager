#!/bin/bash
# Bản React Native dựng sẵn (React.xcframework, ReactNativeDependencies.xcframework) có slice
# Mac Catalyst bị giải nén mất symlink: Versions/Current là thư mục thật, file nằm lẫn ở gốc.
# Framework kiểu macOS như vậy không ký được ("bundle format is ambiguous"). Script dựng lại
# cấu trúc chuẩn: binary, Headers, Modules, Resources nằm trong Versions/A (tài nguyên khác như
# *.bundle, PrivacyInfo.xcprivacy chuyển vào Resources), Current -> A, gốc chỉ còn symlink.
# Chạy lại được nhiều lần; ios/Podfile gọi nó sau pod install.
set -euo pipefail
PODS="${1:-$(cd "$(dirname "$0")/../ios/Pods" && pwd)}"

fix() {
  local fw="$1"
  [ -d "$fw/Versions" ] || return 0
  [ -L "$fw/Versions/Current" ] && return 0
  local a="$fw/Versions/A"
  local bin; bin=$(basename "$fw" .framework)
  mkdir -p "$a"
  for item in "$fw"/* "$fw"/.[!.]*; do
    [ -e "$item" ] || continue
    local name; name=$(basename "$item")
    [ "$name" = Versions ] && continue
    local dest="$a"
    case "$name" in
      Headers|Modules|Resources|"$bin") ;;
      *) dest="$a/Resources"; mkdir -p "$dest" ;;
    esac
    rm -rf "${dest:?}/$name"
    mv "$item" "$dest/$name"
  done
  rm -rf "$fw/Versions/Current"
  ln -s A "$fw/Versions/Current"
  for item in "$a"/*; do
    ln -s "Versions/Current/$(basename "$item")" "$fw/$(basename "$item")"
  done
  echo "fixed $fw"
}

shopt -s nullglob
for fw in "$PODS"/React-Core-prebuilt/React.xcframework/*maccatalyst/*.framework \
          "$PODS"/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/*maccatalyst/*.framework; do
  fix "$fw"
done

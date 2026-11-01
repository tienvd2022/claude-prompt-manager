#!/bin/bash
# Bật ClaudeComputerUse theo yêu cầu (không chạy kèm server). Tự tìm app ở ~/Applications, /Applications hoặc bất kỳ đâu Spotlight thấy.
pgrep -x ClaudeComputerUse >/dev/null && { echo "ClaudeComputerUse đang chạy"; exit 0; }
app=""
for d in "$HOME/Applications" /Applications; do [ -d "$d/ClaudeComputerUse.app" ] && { app="$d/ClaudeComputerUse.app"; break; }; done
[ -z "$app" ] && app="$(mdfind "kMDItemFSName == 'ClaudeComputerUse.app'" | head -1)"
[ -z "$app" ] && { echo "Không tìm thấy ClaudeComputerUse.app" >&2; exit 1; }
open -g "$app" && echo "Đã bật $app"

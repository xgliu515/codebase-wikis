#!/usr/bin/env bash
# 启动本地 wiki 网页服务，自动开浏览器
set -e
PORT="${1:-8765}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
URL="http://localhost:${PORT}/"
echo "Wiki 启动中…"
echo "  目录: $DIR"
echo "  地址: $URL"
echo "  Ctrl+C 停止"
# 开浏览器（macOS）
(sleep 0.5 && open "$URL") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1

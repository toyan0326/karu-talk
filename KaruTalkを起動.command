#!/bin/bash
# Macでローカル起動する。localhost はブラウザ的に「安全なコンテキスト」なので
# HTTPSでなくてもマイクが使える（LANのIP直打ちでは使えない）。
cd "$(dirname "$0")" || exit 1
PORT=8772
if ! nc -z 127.0.0.1 $PORT 2>/dev/null; then
  nohup python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 &
  disown
  sleep 1
fi
open "http://localhost:$PORT/index.html"
echo "KaruTalk: http://localhost:$PORT/"
echo "止めるときは: pkill -f 'http.server $PORT'"

#!/bin/sh
# One-time setup: lets the youdub extension start the local voice when you press TR.
# Writes a small native messaging manifest for each Chromium browser found.
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"
NAME="com.youdub.tts"
ID="eadpkhjldhfpfdaaabibjmijjmgnefdk" # fixed by the "key" in manifest.json

if [ ! -x server/.venv/bin/python ]; then
  python3 -m venv server/.venv
  server/.venv/bin/pip install -q "ema-lightning==1.1.2"
fi

for dir in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Chromium"; do
  [ -d "$dir" ] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  cat > "$dir/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "youdub local Turkish voice",
  "path": "$ROOT/server/youdub-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
  echo "installed: $dir/NativeMessagingHosts/$NAME.json"
done

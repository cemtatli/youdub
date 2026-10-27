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
  server/.venv/bin/python -m pip install -q "ema-lightning==1.1.2"
fi

# English words in Turkish captions: build the respelling table once (~50 MB download,
# ~1.7 MB kept). Sources pinned to commits; see server/lexicon.py.
if [ ! -s server/data/en_tr.tsv ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cmudict.dict" https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict
  freq=https://raw.githubusercontent.com/hermitdave/FrequencyWords/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018
  curl -fsSL -o "$tmp/tr.txt" "$freq/tr/tr_full.txt"
  curl -fsSL -o "$tmp/en.txt" "$freq/en/en_full.txt"
  server/.venv/bin/python server/lexicon.py "$tmp/cmudict.dict" "$tmp/tr.txt" "$tmp/en.txt"
  rm -rf "$tmp"
fi

for dir in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Chromium" \
  "$HOME/Library/Application Support/net.imput.helium"; do
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

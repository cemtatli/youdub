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

# English videos are translated on this machine (OPUS-MT, ~230 MB as int8; see
# server/translate.py). The conversion needs transformers once; the server only needs
# ctranslate2 + sentencepiece.
if [ ! -s server/models/opus-mt-en-tr/model.bin ]; then
  server/.venv/bin/python -m pip install -q "ctranslate2==4.8.4" "sentencepiece==0.2.2" "transformers==4.57.6"
  server/.venv/bin/ct2-transformers-converter --model Helsinki-NLP/opus-mt-tc-big-en-tr \
    --output_dir server/models/opus-mt-en-tr --quantization int8 --copy_files source.spm target.spm
fi

# English auto captions have no punctuation; this model splits them into sentences before
# translation (~53 MB as int8; see server/punctuate.py). onnx is needed only to quantize.
if [ ! -s server/models/punct-en/punct_cap_seg_en.onnx ]; then
  server/.venv/bin/python -m pip install -q "punctuators==0.0.7" "onnx==1.23.2"
  server/.venv/bin/python - <<'PY'
import shutil
from pathlib import Path
from huggingface_hub import hf_hub_download
from onnxruntime.quantization import QuantType, quantize_dynamic

repo, rev, out = "1-800-BAD-CODE/punct_cap_seg_en", "b26fd1c40e88678859048898218ea4edcc24c84a", Path("server/models/punct-en")
out.mkdir(parents=True, exist_ok=True)
for name in ("config.yaml", "spe_32k_lc_en.model"):
    shutil.copy(hf_hub_download(repo, name, revision=rev), out / name)
quantize_dynamic(hf_hub_download(repo, "punct_cap_seg_en.onnx", revision=rev), str(out / "punct_cap_seg_en.onnx"), weight_type=QuantType.QInt8)
PY
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

#!/bin/sh
# Start the local Turkish voice for youdub by hand (normally the TR button starts it). First run creates the venv and downloads the model (~34 MB).
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv && .venv/bin/pip install -q "ema-lightning==1.1.2"
fi
exec .venv/bin/python server.py

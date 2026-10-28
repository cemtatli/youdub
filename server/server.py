"""Local Turkish TTS helper for youdub, backed by EMA Lightning.

Listens on 127.0.0.1 only and answers only the youdub extension (by its Origin), so
websites and other machines on the network cannot use it. Browsers block YouTube pages
from reaching local addresses, so the extension's service worker makes the requests.

  POST /speak      {"text": "...", "speed": 1.0}  ->  audio/wav
  POST /translate  {"text": "...", "chars": 120}  ->  {"text": "..."}  (English -> Turkish)
  POST /punctuate  {"text": "..."}               ->  {"sentences": [...]}  (English auto captions)
  POST /health                                    ->  {"ok": true, "translate": true}

Both are POST because the browser leaves the Origin header off an extension's GET.
"""

import io
import json
import logging
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from ema_lightning import EMA

import lexicon
import punctuate
import translate

HOST = "127.0.0.1"
PORT = 7845
ALLOWED_ORIGINS = {"chrome-extension://eadpkhjldhfpfdaaabibjmijjmgnefdk"}  # fixed by manifest.json "key"
MAX_CHARS = 600
MAX_TRANSCRIPT = 400_000  # /punctuate gets a whole video's captions; an hour is ~60k

log = logging.getLogger("youdub")
tts = None
english = {}  # English words -> Turkish respelling (lexicon.py)
speaking = threading.Lock()  # one sentence at a time: requests arrive in parallel
translating = threading.Lock()


def load():
    """Load the model once. On an Apple M3 the CPU was ~22x faster than real time; MPS was slower."""
    global tts, english
    if tts is None:
        tts = EMA(device="cpu")
        tts.say("Hazır.")  # warm-up
        english = lexicon.load()
        if not english:
            log.warning("no %s; English words will be read the Turkish way (run install.sh)", lexicon.TABLE)
        translate.load()
        if not translate.translator:
            log.warning("no %s; using YouTube's translation (run install.sh)", translate.MODEL)


def to_wav(audio, sample_rate):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(sample_rate)
        file.writeframes(pcm)
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def origin(self):
        origin = self.headers.get("Origin", "")
        return origin if origin in ALLOWED_ORIGINS else None

    def send_cors(self, origin):
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def reply(self, status, body=b"", content_type="application/json"):
        origin = self.origin()
        self.send_response(status)
        if origin:
            self.send_cors(origin)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply(204 if self.origin() else 403)

    def do_POST(self):
        if self.path not in ("/speak", "/translate", "/punctuate", "/health"):
            return self.reply(404)
        if not self.origin():
            return self.reply(403)
        if self.path == "/health":
            return self.reply(200, json.dumps({"ok": True, "translate": bool(translate.translator)}).encode())
        try:
            length = int(self.headers.get("Content-Length", "0"))
            limit = MAX_TRANSCRIPT if self.path == "/punctuate" else MAX_CHARS
            payload = json.loads(self.rfile.read(min(length, limit * 4)) or b"{}")
            text = str(payload.get("text", "")).strip()[:limit]
            speed = min(2.0, max(0.5, float(payload.get("speed", 1.0))))
            chars = int(payload["chars"]) if payload.get("chars") else None
        except (ValueError, TypeError):
            return self.reply(400)
        if not text:
            return self.reply(400)

        if self.path == "/punctuate":
            if not punctuate.available():
                return self.reply(404)
            with translating:
                sentences = punctuate.sentences(text)
            log.info("punctuated %d chars into %d sentences", len(text), len(sentences))
            return self.reply(200, json.dumps({"sentences": sentences}, ensure_ascii=False).encode())

        if self.path == "/translate":
            if not translate.translator:
                return self.reply(404)
            with translating:
                turkish = translate.translate(text, chars)
            log.info("tr %d/%s  %s", len(turkish), chars, turkish[:70])
            return self.reply(200, json.dumps({"text": turkish}, ensure_ascii=False).encode())

        with speaking:
            speech = tts.say(lexicon.respell(text, english), speed=speed, seed=0)
        log.info("%.2fs  %s", speech.duration, text[:70])
        self.reply(200, to_wav(speech.audio, speech.sample_rate), "audio/wav")


def make_server():
    return ThreadingHTTPServer((HOST, PORT), Handler)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    load()
    log.info("youdub TTS listening on http://%s:%d", HOST, PORT)
    make_server().serve_forever()

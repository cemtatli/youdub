"""Local Turkish TTS helper for youdub, backed by EMA Lightning.

Listens on 127.0.0.1 only and answers requests whose Origin is YouTube, so other
websites and other machines on the network cannot use it.

  POST /speak  {"text": "...", "speed": 1.0}  ->  audio/wav
  GET  /health                                ->  {"ok": true}
"""

import io
import json
import logging
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from ema_lightning import EMA

HOST = "127.0.0.1"
PORT = 7845
ALLOWED_ORIGINS = {"https://www.youtube.com", "https://m.youtube.com"}
MAX_CHARS = 600

log = logging.getLogger("youdub")
tts = None


def load():
    """Load the model once. On an Apple M3 the CPU was ~22x faster than real time; MPS was slower."""
    global tts
    if tts is None:
        tts = EMA(device="cpu")
        tts.say("Hazır.")  # warm-up


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
        # Chrome asks before a public site may reach a local address.
        self.send_header("Access-Control-Allow-Private-Network", "true")
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

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404)
        if not self.origin():
            return self.reply(403)
        self.reply(200, b'{"ok": true}')

    def do_POST(self):
        if self.path != "/speak":
            return self.reply(404)
        if not self.origin():
            return self.reply(403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(min(length, 16_384)) or b"{}")
            text = str(payload.get("text", "")).strip()[:MAX_CHARS]
            speed = min(2.0, max(0.5, float(payload.get("speed", 1.0))))
        except (ValueError, TypeError):
            return self.reply(400)
        if not text:
            return self.reply(400)

        speech = tts.say(text, speed=speed, seed=0)
        log.info("%.2fs  %s", speech.duration, text[:70])
        self.reply(200, to_wav(speech.audio, speech.sample_rate), "audio/wav")


def make_server():
    return ThreadingHTTPServer((HOST, PORT), Handler)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    load()
    log.info("youdub TTS listening on http://%s:%d", HOST, PORT)
    make_server().serve_forever()

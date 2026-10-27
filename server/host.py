"""Chrome native messaging host for youdub.

Chrome starts this when you press TR and stops it (closes stdin) when the last YouTube
tab turns TR off or closes. While it runs, it serves the TTS on 127.0.0.1 (server.py).

Native messaging speaks length-prefixed JSON on stdin/stdout, so nothing else may write
to stdout; logs go to stderr, which Chrome keeps out of the protocol.
"""

import json
import logging
import os
import struct
import sys
import threading

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="youdub-host %(message)s")
log = logging.getLogger("youdub")

protocol_out = sys.stdout.buffer
sys.stdout = sys.stderr  # stray prints from libraries must not corrupt the protocol


def send(message):
    data = json.dumps(message).encode()
    protocol_out.write(struct.pack("<I", len(data)) + data)
    protocol_out.flush()


def start():
    try:
        import server

        try:
            httpd = server.make_server()
        except OSError:
            # Something already listens on the port, e.g. a manual `run.sh`. Use it.
            log.info("port %d busy; using the running server", server.PORT)
            send({"type": "ready", "port": server.PORT, "shared": True})
            return
        server.load()
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        log.info("listening on 127.0.0.1:%d", server.PORT)
        send({"type": "ready", "port": server.PORT})
    except Exception as error:  # report instead of dying silently
        log.exception("start failed")
        send({"type": "error", "message": str(error)})


def main():
    threading.Thread(target=start, daemon=True).start()
    stdin = sys.stdin.buffer
    while True:
        header = stdin.read(4)
        if len(header) < 4:
            break  # Chrome closed the port: TR is off everywhere
        stdin.read(struct.unpack("<I", header)[0])  # messages carry nothing we need yet
    log.info("stopping")
    os._exit(0)


if __name__ == "__main__":
    main()

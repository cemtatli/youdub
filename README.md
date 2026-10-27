# yt-dub

Chrome extension that speaks YouTube captions in Turkish while the video plays.

It uses YouTube's own Turkish captions (auto-translated when needed) and a natural Turkish
voice that runs on your machine ([EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning),
~34 MB, Apache 2.0). Without the local voice it falls back to the browser's Turkish voice.
No cloud, no API keys.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this folder.
4. Open a YouTube video and click the **TR** button in the player controls.

## Local voice (recommended)

```sh
server/run.sh
```

First run creates `server/.venv` and downloads the model. It listens on `127.0.0.1:7845`
only and answers requests from YouTube pages only. On an Apple M3 CPU it generates speech
about 22x faster than real time (~80-140 ms per sentence). Chrome may ask once to allow
YouTube to reach a local address.

## How it works

- Picks the video's spoken language from the player's audio track, then asks the player
  for Turkish captions (`tlang=tr`). The player fetches them with its own token; the
  extension keeps a copy of that response. A direct request is the fallback.
- Merges caption fragments into sentences (punctuation, a pause over 1.2 s, or ~7 s).
- Synthesizes the next ~20 s of sentences ahead of time, then plays each one when the video
  reaches it, slightly faster (pitch kept) if it would overrun the next one. Original audio drops to 15% while Turkish speech plays.
- Follows pause, play, seek and in-app navigation to another video.

## Debugging

In the page console: `__ytDub.state` (cues, index, voice), `__ytDub.setOn(true)`.
Logs use the `[yt-dub]` prefix at the Verbose level.

## Known limits

- Automated browsers (`navigator.webdriver`) get empty captions from YouTube; test in a
  normal Chrome profile.
- Browser fallback quality depends on the Turkish voices installed on the machine.
- Translation quality is YouTube's auto-translate.

## Credits

Caption URL and PO token approach learned from
[voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).

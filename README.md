# youdub

Chrome extension that speaks YouTube videos in Turkish while you watch.

It uses YouTube's own Turkish captions (auto-translated when needed) and a natural Turkish
voice that runs on your machine ([EMA Lightning](https://github.com/canberk7/ema-lightning),
model on [Hugging Face](https://huggingface.co/canberkkkkkk/ema-lightning), ~34 MB, Apache 2.0).
The voice starts only when you press **TR** and stops when you turn it off or close the tab.
No cloud, no API keys.

## Install

1. Run once: `./install.sh`
   Creates `server/.venv` (EMA Lightning + PyTorch) and registers the local voice with
   Chrome, Brave and Chromium (native messaging manifest `com.youdub.tts`).
2. Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked** → this folder.
   The extension ID is fixed (`eadpkhjldhfpfdaaabibjmijjmgnefdk`) by the `key` in
   `manifest.json`, so the voice only accepts this extension.
3. Open a YouTube video and press **TR** in the player controls.

If the local voice can't start, youdub falls back to the browser's Turkish voice and says
so in the top-left message.

## How it works

- **TR on** → `dub.js` (page) asks `bridge.js` → `background.js` to start the voice.
  Chrome launches `server/youdub-host`, which loads the model (~2 s) and serves TTS on
  `127.0.0.1:7845`, answering requests from YouTube pages only. ~260 MB RAM while on.
- **Captions**: picks the video's spoken language from the player's audio track, then asks
  the player for Turkish captions (`tlang=tr`). The player fetches them with its own token;
  youdub keeps a copy of that response. A direct request is the fallback.
- **Sentences**: caption fragments are merged at punctuation, a pause over 1.2 s, or ~7 s.
- **Timing**: the next ~20 s of sentences are synthesized ahead. Turkish usually runs
  longer than English, so a sentence that won't fit is spoken a bit faster by the voice
  itself (up to 1.25x), then stretched slightly (up to 1.1x, pitch kept), and finally the
  video slows down for that sentence (down to 0.9x of your chosen speed) and returns to
  normal right after. Original audio drops to 15% while Turkish plays.
- Follows pause, play, seek, buffering, speed changes and moving to another video.
- **TR off / last tab closed** → Chrome closes the host's stdin; the voice exits.

To run the voice by hand instead (for debugging): `server/run.sh`.

## Debugging

Page console: `__youdub.state` (cues, index, engine), `__youdub.setOn(true)`.
Logs use the `[youdub]` prefix at the Verbose level. Host logs: the extension's service
worker console (`chrome://extensions` → youdub → service worker).

## Known limits

- Automated browsers (`navigator.webdriver`) get empty captions from YouTube; test in a
  normal Chrome profile.
- Translation quality is YouTube's auto-translate; videos without captions are not dubbed.

## Credits

Caption URL and PO token approach learned from
[voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).
Icon generated with Codex CLI.

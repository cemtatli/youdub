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
   Chrome, Brave, Chromium and Helium (native messaging manifest `com.youdub.tts`).
2. Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked** → this folder.
   The extension ID is fixed (`eadpkhjldhfpfdaaabibjmijjmgnefdk`) by the `key` in
   `manifest.json`, so the voice only accepts this extension.
3. Open a YouTube video and press **TR** in the player controls.

If the local voice can't start, youdub falls back to the browser's Turkish voice and says
so in the top-left message.

## How it works

- **TR on** → `dub.js` (page) asks `bridge.js` → `background.js` to start the voice.
  Chrome launches `server/youdub-host`, which loads the model (~2 s) and serves TTS on
  `127.0.0.1:7845`, answering the youdub extension only. Pages can't reach local
  addresses, so `background.js` makes the voice requests for the page. ~260 MB RAM while on.
- **Captions**: picks the video's spoken language from the player's audio track, then asks
  the player for Turkish captions (`tlang=tr`). The player fetches them with its own token;
  youdub keeps a copy of that response. A direct request is the fallback.
- **Sentences**: caption fragments are merged at punctuation, a pause over 1.2 s, or ~7 s.
  Auto captions have no punctuation, so youdub adds it (the voice's intonation follows
  it): a comma where the speaker paused, a "?" after the question particle (mı/mi/mu/mü),
  a "." at the end. Symbols the voice would read aloud ("Adım 1:" → "iki nokta", `/`,
  `[Müzik]`) are cleaned up.
- **English words**: the server respells them the Turkish way ("feedback" → "fidbek") from
  a table `install.sh` builds once from the CMU Pronouncing Dictionary, with Turkish and
  English word frequencies deciding which words are English (`server/lexicon.py`, ~24 MB RAM).
- **Timing**: the next ~20 s of sentences are synthesized ahead. Turkish usually runs
  longer than English, so a sentence that won't fit is spoken a little faster (up to 1.08x,
  1.15x when behind; pitch kept), may run up to 1.5 s into the next one, and the video slows
  down for the rest (down to 0.85x of your chosen speed). Sentences are synthesized two at
  a time, the one due soonest first, so a seek gets its sentence quickly.
- Ads: TR waits for the ad to end and stays silent during mid-roll ads.
- **Ducking**: while Turkish plays, the original audio goes through Web Audio: the speech
  band (~0.6–3.8 kHz) drops ~36 dB, the rest ~12 dB, so music keeps its bass and highs.
- Follows pause, play, seek, buffering, speed changes and moving to another video.
- **TR off / last tab closed** → Chrome closes the host's stdin; the voice exits.

To run the voice by hand instead (for debugging): `server/run.sh`.

## Extra buttons

`actions.js` adds two buttons to the Like / Share row under the video (YouTube's own Save
and Ask buttons are removed from that row and its "..." menu):

- **Watch later** (clock): one click adds the video to Watch later, again removes it. Uses
  YouTube's InnerTube API with your signed-in session (`browse/edit_playlist`).
- **Minimal mode** (window icon): hides the recommendations. The right column shows a compact
  "Ask" button (presses the description's own Gemini "Ask" button) above the chapters, if
  the video has them; an open panel such as Gemini takes the whole column. With nothing to
  show, the video is centred. Turning it off closes the side panels. Remembered across videos.

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
Logo: `icons/logo.svg` (traced from `icons/logo-original.png`).
English pronunciations: [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)
(BSD); word frequencies: [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(MIT code, CC-BY-SA-4.0 data).

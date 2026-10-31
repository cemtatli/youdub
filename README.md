<p align="center">
  <img src="icons/logo.svg" width="112" alt="youdub logo">
</p>

<h1 align="center">youdub</h1>

<p align="center">
  Watch YouTube in Turkish. A Chrome extension that dubs videos with a Turkish voice, on your own machine.<br>
  No cloud, no API keys.
</p>

<p align="center"><b>English</b> · <a href="README.tr.md">Türkçe</a></p>

## Features

- **Turkish voice-over**: press **TR** in the player and the video speaks Turkish. The original audio is turned down, music stays.
- **Local translation**: English videos are translated on your machine. Other languages use YouTube's Turkish captions. Shift+click **TR** to switch between the two.
- **Stays in sync**: follows pause, seek and speed changes. Long sentences are spoken a little faster; if needed, the video slows down slightly.
- **English words read right**: "feedback" is said "fidbek", not letter by letter.
- **Turkish subtitles**: the globe button shows Turkish captions a sentence at a time, Netflix-style. Drag them up or down; double-click to reset.
- **Watch later**: one click under the video adds or removes it.
- **Minimal mode**: hides recommendations so only the video (and chapters) remain.
- **Ads**: stays silent during ads.

## Install

1. Run once:
   ```sh
   ./install.sh
   ```
   Sets up the local voice and models (~320 MB) and registers them with Chrome, Brave, Chromium and Helium.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder.
3. Open a YouTube video and press **TR**.

If the local voice can't start, youdub falls back to the browser's Turkish voice.

## Models

All run on your CPU. Nothing leaves your machine.

| Job | Model | Size | License |
| --- | --- | --- | --- |
| Voice | [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning) | ~34 MB | Apache 2.0 |
| Translation (EN → TR) | [OPUS-MT tc-big en-tr](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr), int8 | ~230 MB | CC-BY-4.0 |
| Punctuation (EN auto captions) | [punct_cap_seg_en](https://huggingface.co/1-800-BAD-CODE/punct_cap_seg_en), int8 | ~53 MB | Apache 2.0 |

About 730 MB of RAM while **TR** is on. Translation runs in a separate low-priority process that exits 20 s after its last request.

## Debugging

- Page console: `__youdub.state`, `__youdub.setOn(true)`. Logs use the `[youdub]` prefix.
- Voice logs: `chrome://extensions` → youdub → service worker.
- Run the voice by hand: `server/run.sh`.

## Known limits

- Local translation is English only and sentence by sentence, so it can miss context.
- Videos without captions are not dubbed.
- Automated browsers get empty captions from YouTube; test in a normal Chrome profile.

## Credits

Caption approach from [voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).
Font: [Geist](https://vercel.com/font) by Vercel (SIL OFL 1.1).
Pronunciations: [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (BSD).
Word frequencies: [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (MIT code, CC-BY-SA-4.0 data).

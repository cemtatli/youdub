# youdub

Chrome extension that speaks YouTube videos in Turkish while you watch.

English videos are translated on your machine ([OPUS-MT](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr),
CC-BY-4.0); other languages use YouTube's own Turkish captions. Speech is a natural Turkish
voice that runs on your machine ([EMA Lightning](https://github.com/canberk7/ema-lightning),
model on [Hugging Face](https://huggingface.co/canberkkkkkk/ema-lightning), ~34 MB, Apache 2.0).
The voice starts only when you press **TR** and stops when you turn it off or close the tab.
No cloud, no API keys.

## Install

1. Run once: `./install.sh`
   Creates `server/.venv` (EMA Lightning + PyTorch), converts the English → Turkish model
   (`server/models`, ~230 MB) and registers the local voice with
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
  addresses, so `background.js` makes the voice requests for the page. ~240-360 MB RAM while
  on. Translation and punctuation run in a separate low-priority process
  (`server/worker.py`, up to ~700 MB) that exits 20 s after its last request: inside the
  server, freeing the model gave no memory back.
- **Captions**: picks the video's spoken language from the player's audio track, then asks
  the player for Turkish captions (`tlang=tr`). The player fetches them with its own token;
  youdub keeps a copy of that response. A direct request is the fallback.
- **Translation** (English videos): youdub takes the English captions and translates them
  ahead, 8 sentences per request, from where the video is and then the rest (a 20-minute
  video in ~35 s, ~2 of 8 cores on an M3). YouTube's Turkish runs 25-60% longer than the
  English; OPUS-MT stays close to it. The model returns 4 candidates; a shorter one replaces
  the best only if it is nearly as likely and saves real time (one word can flip the
  meaning). Filler words ("um", ", you know,") are dropped first. English auto captions
  have no punctuation, and translating half sentences gives inverted Turkish, so a small
  model ([punct_cap_seg_en](https://huggingface.co/1-800-BAD-CODE/punct_cap_seg_en),
  Apache-2.0, ~53 MB, loaded only for that second) first splits the whole transcript into
  sentences. Without it, sentences are cut at the speaker's pauses. Shift+click **TR** switches between
  this and YouTube's translation, to compare.
- **Sentences**: caption fragments are merged at punctuation, a pause over 1.2 s, or ~7 s.
  Auto captions have no punctuation, so youdub adds it (the voice's intonation follows
  it): a comma where the speaker paused, a "?" after the question particle (mı/mi/mu/mü),
  a "." at the end. Symbols the voice would read aloud ("Adım 1:" → "iki nokta", `/`,
  `[Müzik]`) are cleaned up.
- **English words**: the server respells them the Turkish way ("feedback" → "fidbek") from
  a table `install.sh` builds once from the CMU Pronouncing Dictionary, with Turkish and
  English word frequencies deciding which words are English (`server/lexicon.py`, ~24 MB RAM).
- **Timing**: the next ~20 s of sentences are synthesized ahead. Turkish usually runs
  longer than English, so a sentence that won't fit is spoken a little faster (up to 1.05x,
  1.12x when behind; pitch kept), may run up to 1.5 s into the next one, and the video slows
  down for the rest (down to 0.85x of your chosen speed). Sentences are synthesized two at
  a time, the one due soonest first, so a seek gets its sentence quickly.
- Ads: TR waits for the ad to end and stays silent during mid-roll ads.
- **Ducking**: while Turkish plays, the original audio goes through Web Audio: the speech
  band (~0.6–3.8 kHz) drops ~40 dB, the rest ~16 dB, so music keeps its bass and highs.
- Follows pause, play, seek, buffering, speed changes and moving to another video.
- **TR off / last tab closed** → Chrome closes the host's stdin; the voice exits.

To run the voice by hand instead (for debugging): `server/run.sh`.

## Turkish subtitles

`subtitles.js` adds a globe button next to **TR** in the player controls. One click shows the
video's own Turkish captions, or YouTube's auto-translation into Turkish from the spoken
language (the menu route: CC → language → Auto-translate → Türkçe). It stays on across
videos until you turn it off.

YouTube shows auto captions word by word, like a live stream. youdub draws them itself,
Netflix-style: a whole sentence at a time (at most two lines of ~42 characters, long
sentences cut at a comma), faded in, centred, in white [Geist](https://vercel.com/font)
(`fonts/`, OFL) on a light, see-through dark box per line. The size follows the player
(~3.7% of its height). The font reaches the page as bytes (`background.js` → `bridge.js` →
a `FontFace`): Chrome refuses the extension's font URL to the page and to content scripts. The caption data is the player's own response, copied as it
arrives; without it, YouTube's captions stay, restyled.

Drag a caption up or down when the video has text or UI where it sits; it stays centred
and keeps that place for every video. Double-click it to put it back at the bottom.
Clicking a caption doesn't pause the video.

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
- Local translation is English only, and sentence by sentence: it can miss context
  ("ship" → "gemi"). Other languages get YouTube's auto-translate. Videos without captions
  are not dubbed.

## Credits

Caption URL and PO token approach learned from
[voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).
Subtitle font: Geist by Vercel (SIL OFL 1.1, `fonts/OFL.txt`).
Logo: `icons/logo.svg` (traced from `icons/logo-original.png`).
English pronunciations: [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)
(BSD); word frequencies: [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(MIT code, CC-BY-SA-4.0 data).

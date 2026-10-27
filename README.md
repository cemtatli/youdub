# yt-dub

Chrome extension that speaks YouTube captions in Turkish while the video plays.

v1 uses YouTube's own Turkish captions (auto-translated when needed) and the browser's
built-in Turkish voice. No server, no downloads, no API keys.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this folder.
4. Open a YouTube video and click the **TR** button in the player controls.

## How it works

- Picks the video's spoken language from the player's audio track, then asks the player
  for Turkish captions (`tlang=tr`). The player fetches them with its own token; the
  extension keeps a copy of that response. A direct request is the fallback.
- Merges caption fragments into sentences (punctuation, a pause over 1.2 s, or ~7 s).
- Speaks each sentence when the video reaches it, slightly faster if it would overrun
  the next one. Original audio drops to 15% while Turkish speech plays.
- Follows pause, play, seek and in-app navigation to another video.

## Debugging

In the page console: `__ytDub.state` (cues, index, voice), `__ytDub.setOn(true)`.
Logs use the `[yt-dub]` prefix at the Verbose level.

## Known limits

- Automated browsers (`navigator.webdriver`) get empty captions from YouTube; test in a
  normal Chrome profile.
- Voice quality depends on the Turkish voices installed on the machine.
- Translation quality is YouTube's auto-translate.

## Credits

Caption URL and PO token approach learned from
[voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).

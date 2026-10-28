// youdub: speaks YouTube captions in Turkish while the video plays.
// Runs in the page (MAIN world) so it can reach YouTube's player API.
// Caption URL + PO token approach learned from voice-over-translation (MIT):
// https://github.com/ilyhalight/voice-over-translation
(() => {
  const TARGET_LANG = "tr";
  const TRANSLATOR_KEY = "youdub.translator"; // "youtube" to skip the local translation
  // Original audio while Turkish speech plays: the whole track a little quieter, the
  // speech band much quieter, so the music keeps its bass and highs.
  const DUCK_GAIN = 0.15; // -16.5 dB
  const DUCK_VOICE_DB = -24; // on top of DUCK_GAIN: the voice ends up ~-40 dB
  const VOICE_BAND_HZ = 1500;
  const VOICE_BAND_Q = 0.5; // wide: roughly 600 Hz – 3.8 kHz
  const DUCK_ATTACK = 0.08; // seconds (time constant); quiet down fast
  const DUCK_RELEASE = 0.5; // come back slowly so gaps don't pump
  const DUCK_FALLBACK = 0.15; // plain video.volume level when Web Audio is unavailable
  const CHARS_PER_SEC = 14; // rough Turkish speech speed at rate 1
  const MAX_RATE = 1.7; // browser voice only
  const LATE_SKIP = 2.5; // seconds; drop a cue if we reach it this late (browser voice)
  // Local voice timing. Turkish usually runs longer than the English it replaces. Fast
  // speech sounds wrong (EMA is already brisk at speed 1), while a slightly slower video is
  // hard to notice with its own voice ducked, so the voice speeds up only a little and the
  // video slows down for the rest; only a large backlog makes us skip.
  const EMA_CHARS_PER_SEC = 17.5; // measured: EMA Lightning at speed 1
  const MAX_SPEED = 1.05; // fastest normal pace (EMA speed × stretch)
  const CATCH_UP_SPEED = 1.12; // allowed only while we are more than DRIFT_ALLOWANCE behind
  const EMA_LATE_SKIP = 4;
  const MIN_VIDEO_RATE = 0.85; // slow the video this far (relative) when Turkish still won't fit
  // Speech may run this far behind the video; the backlog closes at the next pause. It is one
  // shared budget: lateness left by earlier sentences is taken out of it, so it can't pile up.
  const DRIFT_ALLOWANCE = 1.5;
  const EARLY_START = 0.3; // a sentence may start this early to close a gap (local voice)
  const SEEK_JOIN = 1; // after a seek, join a sentence only if it began less than this ago
  const KEEP_DUCKED_GAP = 1.5; // stay quiet across short gaps; music and long pauses come back
  const MERGE_GAP = 0.5; // join neighbouring sentences closer than this for natural flow
  const MERGE_MAX_SECONDS = 10;
  const MERGE_MAX_CHARS = 220;
  const log = (...args) => console.debug("[youdub]", ...args);

  const state = {
    on: false,
    videoId: null,
    cues: [],
    index: 0,
    voice: null,
    timer: 0,
    loading: false,
    engine: "browser",
    translator: null, // "local" (OPUS-MT), "youtube" or "none" (Turkish captions)
    localTranslation: false,
  };

  const getPlayer = () => document.getElementById("movie_player");
  const adShowing = () => !!getPlayer()?.classList.contains("ad-showing");
  let inAd = false;
  const getVideo = () =>
    document.querySelector("video.html5-main-video") || document.querySelector("video");

  // --- captions -------------------------------------------------------------

  // The player sends caption requests with the right token itself. We keep a copy of
  // every caption response it receives, keyed by video, source language and target, and
  // the last request URL per video and language: with its token we can ask for the same
  // track with another target ourselves.
  const captured = new Map();
  const capturedUrls = new Map(); // "videoId|lang" -> URL
  const captionKey = (videoId, lang, tlang) => `${videoId}|${lang}|${tlang ?? ""}`;
  // YouTube answers a refused request (too many requests) with an HTML "Sorry..." page.
  const isCaptionJson = (body) => body?.trim().startsWith("{");
  let refused = false;

  function remember(url, body) {
    if (!isCaptionJson(body)) {
      if (body?.includes("<html")) refused = true;
      return;
    }
    try {
      const parsed = new URL(url, location.origin);
      const params = parsed.searchParams;
      if (params.get("fmt") !== "json3") return;
      captured.set(captionKey(params.get("v"), params.get("lang"), params.get("tlang")), body);
      capturedUrls.set(`${params.get("v")}|${params.get("lang")}`, parsed);
    } catch {}
  }

  // The player keeps the track it shows: asked for plain English while it shows English →
  // Turkish, it sends nothing. Reuse its last URL (and token) with our target instead.
  function siblingUrl(videoId, lang, tlang) {
    const known = capturedUrls.get(`${videoId}|${lang}`);
    if (!known) return null;
    const url = new URL(known);
    if (tlang) url.searchParams.set("tlang", tlang);
    else url.searchParams.delete("tlang");
    return url.toString();
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes("/api/timedtext")) {
      this.addEventListener("load", () => remember(String(url), this.responseText));
    }
    return xhrOpen.call(this, method, url, ...rest);
  };
  const pageFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await pageFetch.call(this, input, init);
    const url = typeof input === "string" ? input : input?.url;
    if (url?.includes("/api/timedtext")) {
      response
        .clone()
        .text()
        .then((body) => remember(url, body))
        .catch(() => {});
    }
    return response;
  };

  // YouTube rejects caption requests without the PO token the player itself uses.
  function tokenParams() {
    const tracks = getPlayer()?.getAudioTrack?.()?.captionTracks ?? [];
    const withPot = tracks.find((track) => track.url?.includes("&pot="));
    let pot = withPot ? /[?&]pot=([^&]+)/.exec(withPot.url)?.[1] : undefined;
    for (let i = 0; pot && i < 5; i += 1) {
      const decoded = decodeURIComponent(pot);
      if (decoded === pot) break;
      pot = decoded;
    }

    const config = window.ytcfg?.data_ ?? window.yt?.config_ ?? {};
    const client = config.INNERTUBE_CONTEXT?.client;
    const params = new URLSearchParams(config.DEVICE ?? "");
    params.delete("ceng");
    params.delete("cengver");
    params.set("c", client?.clientName ?? config.INNERTUBE_CLIENT_NAME ?? "WEB");
    params.set("cver", client?.clientVersion ?? config.INNERTUBE_CLIENT_VERSION ?? "");
    params.set("cplayer", "UNIPLAYER");
    if (pot) {
      params.set("potc", "1");
      params.set("pot", pot);
    }
    return { params, hasPot: Boolean(pot) };
  }

  // Prefer a human-made Turkish track; otherwise translate the video's own language: English
  // on this machine when the local model is there (`local`), anything else by YouTube.
  // A video can list many auto tracks (de, ar, …); the spoken language is the first
  // caption of the player's current audio track, not the first item in the list.
  function pickTrack(localTranslation) {
    const player = getPlayer();
    const renderer = player?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer;
    const tracks = renderer?.captionTracks ?? [];
    if (!tracks.length) return null;

    const turkish = tracks.find((t) => t.languageCode === TARGET_LANG && t.kind !== "asr");
    if (turkish) return { track: turkish, translate: false };

    const spoken = player.getAudioTrack?.()?.captionTracks?.[0]?.languageCode;
    const ofSpoken = tracks.filter((t) => t.languageCode === spoken && t.isTranslatable);
    const source =
      ofSpoken.find((t) => t.kind !== "asr") ??
      ofSpoken[0] ??
      tracks.find((t) => t.kind !== "asr" && t.isTranslatable) ??
      tracks.find((t) => t.isTranslatable) ??
      null;
    if (!source) return null;
    if (localTranslation && source.languageCode.startsWith("en")) return { track: source, translate: false, local: true };
    return { track: source, translate: true };
  }

  function captionUrl({ track, translate }) {
    const url = new URL(track.baseUrl, location.origin);
    url.searchParams.set("fmt", "json3");
    if (translate) url.searchParams.set("tlang", TARGET_LANG);
    const { params } = tokenParams();
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  }

  // Sound tags ([Müzik], ♪), censor stars and speaker marks (>>), in any language.
  const withoutTags = (text) => text.replace(/\[[^\]]*\]|[♪♫]|\p{L}*\*+\p{L}*|>>/gu, " ").replace(/\s+/g, " ").trim();

  // Captions are written to be read, not heard. Drop sound tags and say slashes the way
  // people do: the voice would read "/" as "eğik çizgi".
  function speakable(text) {
    return withoutTags(text)
      .replace(/(\S\.\p{L}{2,})\/\S*/gu, "$1") // a link: keep the site, drop the path
      .replace(/(?<!\p{L})ve\s*\/\s*veya(?!\p{L})/giu, "veya")
      .replace(/(\p{L})\s*\/\s*(?=\p{L})/gu, "$1 ya da ") // kullanıcı/müşteri
      .replace(/\//g, " ") // 7/24 → "yedi yirmi dört"
      .replace(/(\p{L})-(?=\d)/gu, "$1 ") // GPT-4: not "tire dört"
      .replace(/:(?=\s|$)/g, ",") // "Adım 1:" is read "iki nokta"; 10:30 has no space and stays a time
      .replace(/#(?=\d)/g, "") // #1: not "hashtag bir"
      .replace(/~\s*(?=\d)/g, "yaklaşık ")
      .replace(/(\d)\s*[x×](?![\p{L}\d])/gu, "$1 kat") // 3x daha hızlı
      .replace(/\s+/g, " ")
      .trim();
  }

  // Auto captions have no punctuation, and the voice takes its intonation from it (a "?"
  // ends high, "," and "." pause), so we add it where the speaker paused or a sentence ends.
  const COMMA_GAP = 0.25; // seconds of silence between caption lines that read as a comma
  const ENDS_PUNCTUATED = /[.,!?…:;]["')\]]?$/;
  // Turkish asks with the particle mı/mi/mu/mü, often with a person ending: "istiyor musun".
  const ENDS_QUESTION = /(?<!\p{L})(mı|mi|mu|mü)(yım|yim|yum|yüm|sın|sin|sun|sün|yız|yiz|yuz|yüz|sınız|siniz|sunuz|sünüz|dır|dir|dur|dür|ydı|ydi|ydu|ydü|ymış|ymiş|ymuş|ymüş)?$/iu;

  function pause(text) {
    if (ENDS_PUNCTUATED.test(text)) return text;
    return text + (ENDS_QUESTION.test(text) ? "?" : ",");
  }

  function closeSentence(text) {
    text = text.replace(/,$/, "");
    if (ENDS_PUNCTUATED.test(text)) return text;
    return text + (ENDS_QUESTION.test(text) ? "?" : ".");
  }

  // json3 events → lines → speakable cues. A cue ends at sentence punctuation,
  // a pause in speech, or when it gets long (auto captions have no punctuation).
  // English cues (`english`) keep their text in `source`; `text` is filled in by cueText().
  function buildCues(json, english = false) {
    const lines = [];
    for (const event of json.events ?? []) {
      if (!event.segs) continue;
      const raw = event.segs.map((seg) => seg.utf8 ?? "").join("");
      const text = english ? withoutTags(raw) : speakable(raw);
      if (!text) continue;
      const start = event.tStartMs / 1000;
      lines.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
    }

    const cues = [];
    let current = null;
    lines.forEach((line, i) => {
      if (!current) current = { start: line.start, end: line.end, text: line.text };
      else {
        if (line.start - lines[i - 1].end >= COMMA_GAP) current.text = pause(current.text);
        current.text += ` ${line.text}`;
        current.end = Math.max(current.end, line.end);
      }
      const next = lines[i + 1];
      const gap = next ? next.start - line.end : Infinity;
      const sentenceEnd = /[.!?…]["')\]]?$/.test(current.text) || gap > 1.2;
      const done = sentenceEnd || current.end - current.start >= 7;
      if (done) {
        // Cut only for length: likely mid-sentence, so keep the voice up with a comma.
        current.text = sentenceEnd ? closeSentence(current.text) : pause(current.text);
        cues.push(current);
        current = null;
      }
    });
    if (current) cues.push({ ...current, text: closeSentence(current.text) });

    // Longer utterances keep the voice's intonation flowing instead of resetting per line.
    const merged = [];
    for (const cue of cues) {
      const last = merged[merged.length - 1];
      if (
        last &&
        cue.start - last.end < MERGE_GAP &&
        cue.end - last.start <= MERGE_MAX_SECONDS &&
        last.text.length + cue.text.length < MERGE_MAX_CHARS
      ) {
        last.text += ` ${cue.text}`;
        last.end = Math.max(last.end, cue.end);
      } else merged.push({ ...cue });
    }
    for (const cue of merged) cue.text = closeSentence(cue.text);
    if (english) for (const cue of merged) [cue.source, cue.text] = [cue.text, null];
    return merged;
  }

  // English auto captions have no punctuation and roll on screen, so their lines cut
  // sentences anywhere ("let's imagine you" | "built an app"). Translating such halves gives
  // broken, inverted Turkish (the verb comes last). The server's punctuation model splits the
  // whole transcript into sentences, which we place on the word times. Word times come with
  // the caption when it has them; otherwise the words of a line are spread evenly over it.
  // Without the model we cut at the speaker's pauses, and split a long run at its best point:
  // a long pause, or before a word that usually starts a clause, late in the run.
  const ASR_PAUSE = 0.7; // seconds between word starts that read as a pause
  const ASR_MIN_SECONDS = 2.5;
  const ASR_MAX_SECONDS = 10;
  const CLAUSE_START = /^(but|so|and|because|however|which|then|now|if|when|while|where|although|or)$/i;

  function asrWords(json) {
    const events = (json.events ?? []).filter((event) => event.segs && !event.aAppend);
    const words = [];
    events.forEach((event, e) => {
      const eventEnd = Math.min(event.tStartMs + (event.dDurationMs ?? 0), events[e + 1]?.tStartMs ?? Infinity);
      event.segs.forEach((seg, s) => {
        const from = event.tStartMs + (seg.tOffsetMs ?? 0);
        const to = event.segs[s + 1]?.tOffsetMs != null ? event.tStartMs + event.segs[s + 1].tOffsetMs : eventEnd;
        const parts = withoutTags(seg.utf8 ?? "").split(" ").filter(Boolean);
        parts.forEach((text, k) => words.push({ text, start: (from + ((to - from) * k) / parts.length) / 1000 }));
      });
    });
    return words;
  }

  const cueFor = (words, first, last, source) => ({
    start: words[first].start,
    end: Math.min(words[last].start + 0.6, words[last + 1]?.start ?? Infinity),
    source,
    text: null,
  });

  // Walk the sentences over the words by their letters: the model changes case and
  // punctuation, never the letters themselves (except unknown symbols, rare).
  function sentenceCues(words, sentences) {
    const letters = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").length;
    const cues = [];
    let first = 0;
    let wordLetters = 0;
    let sentenceLetters = 0;
    for (const sentence of sentences) {
      if (first >= words.length) break;
      sentenceLetters += letters(sentence);
      let last = first;
      wordLetters += letters(words[first].text);
      while (last + 1 < words.length && wordLetters + letters(words[last + 1].text) / 2 <= sentenceLetters) {
        last += 1;
        wordLetters += letters(words[last].text);
      }
      cues.push(cueFor(words, first, last, sentence));
      first = last + 1;
    }
    if (first < words.length) cues[cues.length - 1].end = words[words.length - 1].start + 0.6;
    // Short neighbouring sentences go together, as in buildCues, for a natural flow.
    const merged = [];
    for (const cue of cues) {
      const last = merged[merged.length - 1];
      if (
        last &&
        cue.start - last.end < MERGE_GAP &&
        cue.end - last.start <= MERGE_MAX_SECONDS &&
        last.source.length + cue.source.length < MERGE_MAX_CHARS
      ) {
        last.source += ` ${cue.source}`;
        last.end = Math.max(last.end, cue.end);
      } else merged.push(cue);
    }
    return merged;
  }

  function pauseCues(words) {
    const gapAfter = (i) => (i + 1 < words.length ? words[i + 1].start - words[i].start : Infinity);
    const cues = [];
    let first = 0;
    const cut = (last) => {
      cues.push(cueFor(words, first, last, words.slice(first, last + 1).map((w) => w.text).join(" ")));
      first = last + 1;
    };
    for (let i = 0; i < words.length; i += 1) {
      const length = words[i].start - words[first].start;
      if (gapAfter(i) >= ASR_PAUSE && length >= ASR_MIN_SECONDS) cut(i);
      else if (length >= ASR_MAX_SECONDS) {
        let best = i;
        let bestScore = -1;
        for (let j = first + 3; j < i; j += 1) {
          const late = (words[j].start - words[first].start) / ASR_MAX_SECONDS; // 0..1
          const score = gapAfter(j) + (CLAUSE_START.test(words[j + 1].text) ? 0.4 : 0) + 0.3 * late;
          if (score > bestScore) [best, bestScore] = [j, score];
        }
        cut(best);
        i = best;
      }
    }
    if (first < words.length) cut(words.length - 1);
    return cues;
  }

  async function buildAsrCues(json) {
    const words = asrWords(json);
    if (!words.length) return [];
    const reply = await voiceRequest("/punctuate", { text: words.map((w) => w.text).join(" ") }, 30000);
    const sentences = reply && parseJson(reply)?.sentences;
    return sentences?.length ? sentenceCues(words, sentences) : pauseCues(words);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 1) Ask the player to show the Turkish captions; it fetches them with its own token
  //    and the hook above keeps the response. 2) If nothing arrives, request them directly.
  async function loadCues(videoId, localTranslation = false) {
    const choice = pickTrack(localTranslation);
    if (!choice) throw new Error("Bu videoda altyazı yok.");
    const lang = choice.track.languageCode;
    const tlang = choice.translate ? TARGET_LANG : undefined;
    const key = captionKey(videoId, lang, tlang);
    refused = false;

    if (!captured.has(key)) {
      const player = getPlayer();
      player?.loadModule?.("captions");
      player?.setOption?.("captions", "track", {
        languageCode: lang,
        ...(tlang ? { translationLanguage: { languageCode: tlang } } : {}),
      });
      for (let i = 0; i < 25 && !captured.has(key); i += 1) await wait(200);
    }

    let body = captured.get(key);
    for (const url of body ? [] : [siblingUrl(videoId, lang, tlang), captionUrl(choice)]) {
      if (!url) continue;
      const response = await pageFetch(url, { credentials: "include" }).catch(() => null);
      body = response ? await response.text() : "";
      if (isCaptionJson(body)) break;
      if (body.includes("<html") || response?.status === 429) refused = true;
      body = "";
    }
    if (!body) {
      throw new Error(
        refused
          ? "YouTube altyazı isteklerini geçici olarak engelledi (çok fazla istek). Biraz sonra tekrar dene."
          : "Altyazı alınamadı. Altyazıyı (CC) bir kez açıp kapatıp tekrar dene.",
      );
    }
    const json = JSON.parse(body);
    const cues = choice.local && choice.track.kind === "asr" ? await buildAsrCues(json) : buildCues(json, Boolean(choice.local));
    state.translator = choice.local ? "local" : tlang ? "youtube" : "none";
    log("cues", cues.length, lang, tlang ? `→ ${tlang}` : "", state.translator);
    return cues;
  }

  // --- speech ---------------------------------------------------------------

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(TARGET_LANG));
    state.voice = voices.find((v) => /google/i.test(v.name)) ?? voices[0] ?? null;
  }
  speechSynthesis.addEventListener("voiceschanged", pickVoice);
  pickVoice();

  // Duck the original audio through Web Audio, not video.volume: YouTube rewrites
  // video.volume itself (volume sync, loudness normalization), and a plain volume cut
  // drops the music with the voice. We cut the speech band hard and the rest gently.
  // A video can join a graph only once, so its graph is kept for the page's lifetime.
  const audioGraphs = new WeakMap(); // video -> { gain, voiceBand } | null
  let audioContext = null;
  let ducked = false;
  let savedVolume = 1; // fallback when Web Audio is unavailable

  function audioGraph(video) {
    if (audioGraphs.has(video)) return audioGraphs.get(video);
    let graph = null;
    try {
      audioContext ??= new AudioContext();
      const source = audioContext.createMediaElementSource(video);
      const voiceBand = new BiquadFilterNode(audioContext, { type: "peaking", frequency: VOICE_BAND_HZ, Q: VOICE_BAND_Q });
      const gain = new GainNode(audioContext);
      source.connect(voiceBand).connect(gain).connect(audioContext.destination);
      graph = { gain, voiceBand };
    } catch (error) {
      log("web audio unavailable, ducking with video.volume", error); // e.g. another extension took the video
    }
    audioGraphs.set(video, graph);
    return graph;
  }

  function setDucked(video, on) {
    if (ducked === on) return;
    ducked = on;
    const graph = audioGraph(video);
    if (!graph) {
      if (on) savedVolume = video.volume;
      video.volume = on ? savedVolume * DUCK_FALLBACK : savedVolume;
      return;
    }
    audioContext.resume();
    const now = audioContext.currentTime;
    const smoothing = on ? DUCK_ATTACK : DUCK_RELEASE;
    graph.gain.gain.setTargetAtTime(on ? DUCK_GAIN : 1, now, smoothing);
    graph.voiceBand.gain.setTargetAtTime(on ? DUCK_VOICE_DB : 0, now, smoothing);
  }

  const duck = (video) => setDucked(video, true);
  const unduck = (video) => setDucked(video, false);

  // Local EMA Lightning voice (server/run.sh). Falls back to the browser's voice.
  const PREFETCH_AHEAD = 20; // seconds of upcoming sentences to synthesize early
  const audioCache = new Map(); // cue index -> Promise<{ url, duration } | null>
  let current = null; // the <audio> playing now (EMA engine)
  let busy = false; // a sentence is playing or about to
  let generation = 0; // bumps on seek/stop so stale replies are dropped

  // Ask the extension (bridge.js → background.js) to start the local voice. It runs only
  // while TR is on. Resolves to its /health answer, or false to use the browser voice.
  function startVoice() {
    return new Promise((resolve) => {
      const done = (ok) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(ok);
      };
      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "youdub-ext") return;
        if (event.data.type === "ready") done(true);
        if (event.data.type === "error") {
          log("voice error", event.data.message);
          done(false);
        }
      };
      const timer = setTimeout(() => done(false), 20000); // first start loads the model
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "youdub-page", type: "start" }, "*");
    }).then(async (ok) => ok && (await serverUp()));
  }

  function stopVoice() {
    window.postMessage({ source: "youdub-page", type: "stop" }, "*");
  }

  // Requests to the local voice go through the extension: browsers block this page from
  // reaching 127.0.0.1 itself. Resolves to the response body (ArrayBuffer) or null, also
  // when no answer comes (e.g. the extension was reloaded under this tab).
  let voiceRequestId = 0;
  function voiceRequest(path, body, timeout = 30000) {
    const id = (voiceRequestId += 1);
    return new Promise((resolve) => {
      const done = (data) => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(data);
      };
      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "youdub-ext") return;
        if (event.data.type === "voice" && event.data.id === id) done(event.data.data ?? null);
      };
      const timer = setTimeout(() => done(null), timeout + 2000);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "youdub-page", type: "voice", id, path, body, timeout }, "*");
    });
  }

  const parseJson = (data) => {
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  };

  async function serverUp() {
    for (const timeout of [4000, 2000]) {
      const data = await voiceRequest("/health", null, timeout);
      if (data) return parseJson(data) ?? {};
    }
    return false;
  }

  // Speak faster only as much as the sentence needs to fit before the next one starts.
  function plannedSpeed(index) {
    const cue = state.cues[index];
    const next = state.cues[index + 1];
    const slot = Math.max(0.8, (next ? next.start : cue.end + 1.5) - cue.start) + DRIFT_ALLOWANCE;
    const needed = cue.text.length / EMA_CHARS_PER_SEC;
    return Math.round(Math.min(MAX_SPEED, Math.max(1, needed / slot)) * 100) / 100;
  }

  // Sentences are synthesized two at a time, the one needed soonest first. Sending all of
  // the prefetch window at once (start, every seek) left the sentence due now at the back
  // of the queue: it came late, then had to rush or was skipped.
  const MAX_IN_FLIGHT = 2;
  const queued = new Map(); // cue index -> { promise, resolve }, not sent yet
  let inFlight = 0;

  function synth(index) {
    if (!audioCache.has(index)) {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      audioCache.set(index, promise);
      queued.set(index, { promise, resolve });
      pumpSynth();
    }
    return audioCache.get(index);
  }

  function pumpSynth() {
    while (inFlight < MAX_IN_FLIGHT && queued.size) {
      const index = Math.min(...queued.keys());
      const { promise, resolve } = queued.get(index);
      queued.delete(index);
      inFlight += 1;
      requestClip(index).then((clip) => {
        inFlight -= 1;
        if (audioCache.get(index) !== promise) {
          if (clip) URL.revokeObjectURL(clip.url); // cache was cleared meanwhile (new video)
        } else if (!clip) {
          audioCache.delete(index); // failed: ask again next time instead of staying silent
        }
        resolve(clip);
        pumpSynth();
      });
    }
  }

  // After a seek the queued sentences may be far from where we are now.
  function dropQueued() {
    for (const [index, { resolve }] of queued) {
      audioCache.delete(index);
      resolve(null);
    }
    queued.clear();
  }

  // English cues get their Turkish just before they are synthesized. The model picks a
  // translation that fits the time until the next sentence at normal speed, if it has one.
  function cueText(index) {
    const cue = state.cues[index];
    if (cue.text) return Promise.resolve(cue.text);
    const next = state.cues[index + 1];
    const slot = (next ? next.start : cue.end + 1.5) - cue.start;
    return voiceRequest("/translate", { text: cue.source, chars: Math.round(slot * EMA_CHARS_PER_SEC) }).then((data) => {
      const turkish = data && parseJson(data)?.text;
      if (turkish) cue.text = closeSentence(speakable(turkish));
      return cue.text || null;
    });
  }

  function requestClip(index) {
    return cueText(index)
      .then((text) => text && voiceRequest("/speak", { text, speed: plannedSpeed(index) }))
      .then((data) => data && new Blob([data], { type: "audio/wav" }))
      .then(
        (blob) =>
          blob &&
          new Promise((resolve) => {
            const url = URL.createObjectURL(blob);
            const probe = new Audio(url);
            probe.addEventListener(
              "loadedmetadata",
              () => resolve({ url, duration: probe.duration, speed: plannedSpeed(index) }),
              { once: true },
            );
            probe.addEventListener("error", () => resolve(null), { once: true });
          }),
      )
      .catch(() => null);
  }

  function prefetch(time) {
    for (let i = state.index; i < state.cues.length && state.cues[i].start < time + PREFETCH_AHEAD; i += 1) synth(i);
  }

  function clearAudioCache() {
    dropQueued();
    for (const request of audioCache.values()) request.then((clip) => clip && URL.revokeObjectURL(clip.url));
    audioCache.clear();
  }

  // How long this sentence may take before the next one should start.
  function slotFor(cue, next, video) {
    const now = Math.max(video.currentTime, cue.start);
    return Math.max(0.8, (next ? next.start : cue.end + 1.5) - now);
  }

  // The user's own speed choice; our temporary slow-downs are applied on top of it.
  let baseRate = 1;
  let slowed = false;
  function setVideoRate(video, rate) {
    if (Math.abs(video.playbackRate - rate) < 0.001) return;
    state.ownRateChange = true;
    video.playbackRate = rate;
  }
  function restoreRate(video) {
    if (!slowed) return;
    slowed = false;
    setVideoRate(video, baseRate);
  }

  function finish(video) {
    busy = false;
    current = null;
    restoreRate(video); // the original audio comes back in tick() if no sentence follows soon
  }

  function speakEma(index, video) {
    const cue = state.cues[index];
    const next = state.cues[index + 1];
    const ticket = generation;
    busy = true;
    synth(index).then((clip) => {
      if (ticket !== generation) return;
      if (!clip || video.currentTime - cue.start > EMA_LATE_SKIP) return finish(video);
      const audio = new Audio(clip.url);
      const room = slotFor(cue, next, video) + DRIFT_ALLOWANCE; // video seconds it may take
      const behind = video.currentTime - cue.start > DRIFT_ALLOWANCE;
      const maxStretch = (behind ? CATCH_UP_SPEED : MAX_SPEED) / clip.speed;
      const stretch = Math.min(Math.max(1, maxStretch), Math.max(1, clip.duration / room));
      audio.playbackRate = stretch * baseRate; // pitch is preserved by default
      // Still too long: slow the video a little for this sentence so the next one waits.
      const slow = Math.max(MIN_VIDEO_RATE, Math.min(1, (room * stretch) / clip.duration));
      if (slow < 0.995) {
        slowed = true;
        setVideoRate(video, baseRate * slow);
      }
      audio.addEventListener("ended", () => finish(video), { once: true });
      audio.addEventListener("error", () => finish(video), { once: true });
      current = audio;
      duck(video);
      if (video.paused) return; // play resumes it
      audio.play().catch(() => finish(video));
    });
  }

  function speakBrowser(cue, next, video) {
    const needed = cue.text.length / CHARS_PER_SEC;
    const rate = Math.min(MAX_RATE, Math.max(1, needed / slotFor(cue, next, video))) * video.playbackRate;

    const utterance = new SpeechSynthesisUtterance(cue.text);
    utterance.lang = "tr-TR";
    if (state.voice) utterance.voice = state.voice;
    utterance.rate = rate;
    utterance.onstart = () => duck(video);

    speechSynthesis.speak(utterance);
  }

  const speaking = () => (state.engine === "ema" ? busy : speechSynthesis.speaking);

  // Landing inside a sentence: start with it only if it has just begun. Joining it seconds
  // late meant rushing to catch up; the next sentence comes soon anyway.
  function resetIndex(time) {
    const i = state.cues.findIndex((cue) => cue.start >= time - SEEK_JOIN);
    state.index = i === -1 ? state.cues.length : i;
  }

  function tick() {
    const video = getVideo();
    if (!video || !state.cues.length || video.paused) return;
    // During an ad the same <video> plays the ad, so its time means nothing to our cues.
    if (adShowing()) {
      if (!inAd) {
        inAd = true;
        stopSpeech();
        dropQueued();
      }
      return;
    }
    if (inAd) {
      inAd = false;
      resetIndex(video.currentTime);
    }
    const time = video.currentTime;
    if (state.engine === "ema") prefetch(time);

    // Bring the original audio back only for real gaps (music, long pauses).
    const upcoming = state.cues[state.index];
    if (!speaking() && ducked && (!upcoming || upcoming.start - time > KEEP_DUCKED_GAP)) {
      unduck(video);
    }

    while (state.index < state.cues.length) {
      const cue = state.cues[state.index];
      if (time < cue.start - (state.engine === "ema" ? EARLY_START : 0)) return;
      if (time - cue.start > (state.engine === "ema" ? EMA_LATE_SKIP : LATE_SKIP)) {
        state.index += 1; // fell behind; skip rather than drift
        continue;
      }
      if (speaking()) return; // wait for the current sentence to finish
      if (state.engine === "ema") speakEma(state.index, video);
      else speakBrowser(cue, state.cues[state.index + 1], video);
      state.index += 1;
      return;
    }
  }

  // --- control --------------------------------------------------------------

  function stopSpeech() {
    generation += 1;
    speechSynthesis.cancel();
    current?.pause();
    current = null;
    busy = false;
    const video = getVideo();
    if (video) {
      unduck(video);
      restoreRate(video);
    }
  }

  async function start() {
    const videoId = new URLSearchParams(location.search).get("v");
    if (!videoId || state.loading) return;
    state.loading = true;
    toast("Türkçe ses hazırlanıyor…");
    try {
      // The player can't give captions during an ad; wait for the video itself.
      if (adShowing()) toast("Reklam bitince Türkçe ses başlayacak.");
      while (adShowing() && state.on) await wait(500);
      if (!state.on) return;
      // The voice first: whether it can translate decides which captions we need.
      const voice = await startVoice();
      if (!state.on) return stopVoice();
      state.engine = voice ? "ema" : "browser";
      // A stale extension (not reloaded after an update) can't pass /translate on: try it once.
      const localTranslation =
        Boolean(voice?.translate) && !preferYouTube() && Boolean(await voiceRequest("/translate", { text: "Hello." }, 5000));
      if (state.videoId !== videoId || !state.cues.length || state.localTranslation !== localTranslation) {
        state.cues = await loadCues(videoId, localTranslation);
        state.videoId = videoId;
        state.localTranslation = localTranslation;
      }
      if (!state.on) return; // turned off while loading
      const translator = { local: ", lokal çeviri", youtube: ", YouTube çevirisi" }[state.translator] ?? "";
      if (state.engine === "ema") toast(`Türkçe ses açık (EMA Lightning${translator})`);
      else if (!state.voice) toast("Türkçe ses bulunamadı, varsayılan ses kullanılıyor.");
      else toast(`Türkçe ses açık (${state.voice.name}). Doğal ses için install.sh'i bir kez çalıştır.`);
      const video = getVideo();
      if (video && !slowed) baseRate = video.playbackRate;
      resetIndex(video?.currentTime ?? 0);
      clearInterval(state.timer);
      state.timer = setInterval(tick, 150);
    } catch (error) {
      log(error);
      toast(error.message);
      setOn(false);
    } finally {
      state.loading = false;
    }
  }

  function stop() {
    clearInterval(state.timer);
    stopSpeech();
    stopVoice();
  }

  function preferYouTube() {
    try {
      return localStorage.getItem(TRANSLATOR_KEY) === "youtube";
    } catch {
      return false;
    }
  }

  // Shift+click on TR switches between the local translation and YouTube's, to compare them.
  function switchTranslator() {
    const youtube = !preferYouTube();
    try {
      localStorage.setItem(TRANSLATOR_KEY, youtube ? "youtube" : "local");
    } catch {}
    toast(youtube ? "Çeviri: YouTube" : "Çeviri: lokal (OPUS-MT)");
    if (!state.on) return;
    clearInterval(state.timer);
    stopSpeech();
    clearAudioCache();
    start();
  }

  function setOn(on) {
    state.on = on;
    const button = document.getElementById("youdub-toggle");
    if (button) {
      button.setAttribute("aria-pressed", String(on));
      paintButton(button);
    }
    if (on) {
      // Build the audio graph inside the click, where the browser lets audio start.
      const video = getVideo();
      if (video && audioGraph(video)) audioContext.resume();
      start();
    } else {
      stop();
    }
  }

  // --- UI -------------------------------------------------------------------

  let toastTimer = 0;
  function toast(message) {
    const host = getPlayer();
    if (!host) return;
    let box = document.getElementById("youdub-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "youdub-toast";
      Object.assign(box.style, {
        position: "absolute",
        top: "12px",
        left: "12px",
        zIndex: "70",
        padding: "6px 10px",
        borderRadius: "8px",
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        font: "500 13px/1.3 Roboto, Arial, sans-serif",
        pointerEvents: "none",
        transition: "opacity 0.2s",
      });
      host.appendChild(box);
    }
    box.textContent = message;
    box.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.style.opacity = "0";
    }, 3500);
  }

  // icons/logo.svg, built with DOM calls because YouTube enforces Trusted Types.
  const LOGO_PATH =
    "M2360 9913 c-275 -21 -647 -139 -794 -252 -28 -21 -74 -50 -103 -65 -273 -137 -674 -637 -786 -981 -60 -183 -107 -380 -107 -450 -1 -38 -6 -101 -11 -140 -5 -38 -14 -252 -19 -475 -4 -223 -13 -425 -19 -450 -39 -171 -6 -733 64 -1074 19 -91 222 -507 284 -581 23 -27 83 -101 133 -163 185 -229 579 -492 848 -567 52 -15 121 -35 154 -46 32 -10 115 -25 185 -33 69 -9 169 -21 221 -28 127 -16 1150 -24 1202 -8 20 6 63 30 95 54 32 24 81 55 109 69 28 14 80 49 115 78 35 28 123 80 194 116 72 36 149 78 171 94 23 15 72 43 109 60 72 35 151 104 181 160 18 32 19 87 25 1244 4 935 8 1221 18 1258 62 232 312 262 593 71 59 -41 148 -94 198 -119 50 -25 140 -79 200 -120 304 -207 416 -232 552 -123 35 27 88 63 119 79 31 15 85 51 120 79 35 29 125 83 200 120 75 38 165 92 200 120 35 29 127 84 204 122 79 40 166 92 199 120 33 27 85 62 116 78 266 134 376 424 292 770 -17 69 -34 141 -37 160 -35 186 -222 450 -415 586 -185 130 -290 176 -530 235 -32 8 -4179 10 -4280 2z M7865 8246 c-48 -21 -235 -144 -305 -201 -63 -51 -157 -110 -324 -201 -43 -24 -103 -63 -133 -88 -30 -25 -119 -79 -197 -120 -79 -42 -170 -96 -202 -122 -32 -25 -81 -57 -109 -71 -27 -14 -81 -47 -120 -73 -38 -26 -89 -59 -113 -74 -104 -65 -85 -108 97 -219 75 -46 203 -126 284 -178 154 -98 202 -127 351 -213 369 -211 361 -499 -18 -688 -33 -16 -92 -54 -131 -82 -38 -29 -164 -101 -280 -160 -115 -59 -241 -131 -280 -160 -38 -29 -164 -101 -280 -160 -115 -59 -241 -131 -280 -160 -38 -29 -164 -101 -280 -160 -115 -59 -242 -132 -280 -161 -243 -185 -402 -204 -595 -71 -90 62 -116 61 -206 -10 -32 -25 -90 -62 -129 -81 -503 -253 -698 -521 -626 -858 44 -205 304 -506 543 -626 212 -107 137 -103 2088 -109 1775 -5 1775 -5 1817 -27 162 -87 422 -275 822 -595 208 -168 299 -240 381 -304 47 -37 119 -97 160 -134 195 -173 261 -212 364 -213 224 -2 270 225 146 728 -11 44 -27 136 -35 205 -9 69 -25 161 -37 205 -30 117 -32 145 -10 181 23 36 144 102 243 132 90 28 264 116 319 161 25 21 74 57 110 81 168 113 450 441 498 580 11 30 47 114 81 185 137 288 153 440 147 1424 -6 1051 -33 1226 -247 1577 -20 33 -51 88 -70 123 -37 71 -173 220 -314 343 -87 77 -489 298 -541 298 -9 0 -68 17 -132 39 -187 62 -2054 111 -2177 57z";
  const LOGO_RED = "#EF1B37";
  function logoIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    // Sized like YouTube's own icons (24x24 attributes, the player's CSS does the rest);
    // the viewBox frames the logo with the same margin their glyphs have.
    svg.setAttribute("viewBox", "-47 -48 1280 1280");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("transform", "translate(0 1184) scale(0.1 -0.1)");
    path.setAttribute("d", LOGO_PATH);
    svg.appendChild(path);
    return svg;
  }

  // White like the other player buttons while off, the logo's red while on.
  function paintButton(button) {
    const path = button.querySelector("path");
    if (path) path.setAttribute("fill", state.on ? LOGO_RED : "#fff");
  }

  function mountButton() {
    // Newer players group the right-hand buttons in pills; join the first one.
    const controls = document.querySelector(".ytp-right-controls-left") ?? document.querySelector(".ytp-right-controls");
    if (!controls || document.getElementById("youdub-toggle")) return;
    const button = document.createElement("button");
    button.id = "youdub-toggle";
    button.className = "ytp-button";
    button.title = "Türkçe seslendirme (youdub) · Shift+tık: çeviriyi değiştir";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(state.on));
    button.appendChild(logoIcon());
    paintButton(button);
    button.addEventListener("click", (event) => (event.shiftKey ? switchTranslator() : setOn(!state.on)));
    controls.prepend(button);
  }

  // --- wiring ---------------------------------------------------------------

  // Seeking: stop the sentence at once (dragging the bar fires many of these), then pick up
  // at the new position with only the sentences that are near it.
  document.addEventListener(
    "seeking",
    (event) => {
      if (state.on && event.target === getVideo()) stopSpeech();
    },
    true,
  );
  document.addEventListener(
    "seeked",
    (event) => {
      if (!state.on || event.target !== getVideo()) return;
      stopSpeech();
      dropQueued();
      resetIndex(event.target.currentTime);
    },
    true,
  );
  document.addEventListener(
    "pause",
    (event) => {
      if (!state.on || event.target !== getVideo()) return;
      speechSynthesis.pause();
      current?.pause();
    },
    true,
  );
  // Remember the speed the user picks; ignore the changes we make ourselves.
  document.addEventListener(
    "ratechange",
    (event) => {
      if (event.target !== getVideo()) return;
      if (state.ownRateChange) state.ownRateChange = false;
      else baseRate = event.target.playbackRate;
    },
    true,
  );

  // Buffering: the video stops but its "paused" flag stays false.
  document.addEventListener(
    "waiting",
    (event) => {
      if (state.on && event.target === getVideo()) current?.pause();
    },
    true,
  );
  document.addEventListener(
    "playing",
    (event) => {
      if (state.on && event.target === getVideo()) current?.play().catch(() => {});
    },
    true,
  );
  document.addEventListener(
    "play",
    (event) => {
      if (!state.on || event.target !== getVideo()) return;
      speechSynthesis.resume();
      current?.play().catch(() => {});
    },
    true,
  );

  // YouTube is a single-page app: a new video does not reload the page.
  document.addEventListener("yt-navigate-finish", () => {
    mountButton();
    clearInterval(state.timer); // keep the voice running between videos
    stopSpeech();
    clearAudioCache();
    state.cues = [];
    state.videoId = null;
    if (state.on) start();
  });

  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });

  // Debug hook for the console: window.__youdub.state, window.__youdub.loadCues()
  window.__youdub = { state, captured, loadCues, buildCues, asrWords, sentenceCues, setOn, switchTranslator };
})();

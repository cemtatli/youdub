// yt-dub v1: speaks YouTube captions in Turkish while the video plays.
// Runs in the page (MAIN world) so it can reach YouTube's player API.
// Caption URL + PO token approach learned from voice-over-translation (MIT):
// https://github.com/ilyhalight/voice-over-translation
(() => {
  const TARGET_LANG = "tr";
  const DUCK = 0.15; // original audio level while Turkish speech plays
  const CHARS_PER_SEC = 14; // rough Turkish speech speed at rate 1
  const MAX_RATE = 1.7; // browser voice only
  const LATE_SKIP = 2.5; // seconds; drop a cue if we reach it this late (browser voice)
  // Local voice timing. Turkish usually runs longer than the English it replaces, so a
  // sentence gets a little faster natural speech first (EMA speed), then a small stretch,
  // and may run into the next one; only a large backlog makes us skip.
  const EMA_CHARS_PER_SEC = 17.5; // measured: EMA Lightning at speed 1
  const MAX_SPEED = 1.25; // EMA speed when synthesizing
  const MAX_STRETCH = 1.1; // extra playbackRate at play time
  const EMA_LATE_SKIP = 4;
  const log = (...args) => console.debug("[yt-dub]", ...args);

  const state = {
    on: false,
    videoId: null,
    cues: [],
    index: 0,
    voice: null,
    savedVolume: null,
    timer: 0,
    loading: false,
    engine: "browser",
  };

  const getPlayer = () => document.getElementById("movie_player");
  const getVideo = () =>
    document.querySelector("video.html5-main-video") || document.querySelector("video");

  // --- captions -------------------------------------------------------------

  // The player sends caption requests with the right token itself. We keep a copy of
  // every caption response it receives, keyed by video, source language and target.
  const captured = new Map();
  const captionKey = (videoId, lang, tlang) => `${videoId}|${lang}|${tlang ?? ""}`;
  function remember(url, body) {
    if (!body?.trim()) return;
    try {
      const params = new URL(url, location.origin).searchParams;
      if (params.get("fmt") !== "json3") return;
      captured.set(captionKey(params.get("v"), params.get("lang"), params.get("tlang")), body);
    } catch {}
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

  // Prefer a human-made Turkish track; otherwise translate the video's own language.
  // A video can list many auto tracks (de, ar, …); the spoken language is the first
  // caption of the player's current audio track, not the first item in the list.
  function pickTrack() {
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
    return source ? { track: source, translate: true } : null;
  }

  function captionUrl({ track, translate }) {
    const url = new URL(track.baseUrl, location.origin);
    url.searchParams.set("fmt", "json3");
    if (translate) url.searchParams.set("tlang", TARGET_LANG);
    const { params } = tokenParams();
    for (const [key, value] of params) url.searchParams.set(key, value);
    return url.toString();
  }

  // json3 events → lines → speakable cues. A cue ends at sentence punctuation,
  // a pause in speech, or when it gets long (auto captions have no punctuation).
  function buildCues(json) {
    const lines = [];
    for (const event of json.events ?? []) {
      if (!event.segs) continue;
      const text = event.segs.map((seg) => seg.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const start = event.tStartMs / 1000;
      lines.push({ start, end: start + (event.dDurationMs ?? 0) / 1000, text });
    }

    const cues = [];
    let current = null;
    lines.forEach((line, i) => {
      if (!current) current = { start: line.start, end: line.end, text: line.text };
      else {
        current.text += ` ${line.text}`;
        current.end = Math.max(current.end, line.end);
      }
      const next = lines[i + 1];
      const gap = next ? next.start - line.end : Infinity;
      const done =
        /[.!?…]["')\]]?$/.test(current.text) || gap > 1.2 || current.end - current.start >= 7;
      if (done) {
        cues.push(current);
        current = null;
      }
    });
    if (current) cues.push(current);
    return cues;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 1) Ask the player to show the Turkish captions; it fetches them with its own token
  //    and the hook above keeps the response. 2) If nothing arrives, request them directly.
  async function loadCues(videoId) {
    const choice = pickTrack();
    if (!choice) throw new Error("Bu videoda altyazı yok.");
    const lang = choice.track.languageCode;
    const tlang = choice.translate ? TARGET_LANG : undefined;
    const key = captionKey(videoId, lang, tlang);

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
    if (!body) {
      const response = await pageFetch(captionUrl(choice), { credentials: "include" });
      body = response.ok ? await response.text() : "";
    }
    if (!body?.trim()) {
      throw new Error("Altyazı alınamadı. Altyazıyı (CC) bir kez açıp kapatıp tekrar dene.");
    }
    const cues = buildCues(JSON.parse(body));
    log("cues", cues.length, lang, tlang ? `→ ${tlang}` : "");
    return cues;
  }

  // --- speech ---------------------------------------------------------------

  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith(TARGET_LANG));
    state.voice = voices.find((v) => /google/i.test(v.name)) ?? voices[0] ?? null;
  }
  speechSynthesis.addEventListener("voiceschanged", pickVoice);
  pickVoice();

  function duck(video) {
    if (state.savedVolume === null) state.savedVolume = video.volume;
    video.volume = state.savedVolume * DUCK;
  }

  function unduck(video) {
    if (state.savedVolume === null) return;
    video.volume = state.savedVolume;
    state.savedVolume = null;
  }

  // Local EMA Lightning voice (server/run.sh). Falls back to the browser's voice.
  const TTS_URL = "http://127.0.0.1:7845";
  const PREFETCH_AHEAD = 20; // seconds of upcoming sentences to synthesize early
  const audioCache = new Map(); // cue index -> Promise<{ url, duration } | null>
  let current = null; // the <audio> playing now (EMA engine)
  let busy = false; // a sentence is playing or about to
  let generation = 0; // bumps on seek/stop so stale replies are dropped

  // The first local request can take a few seconds (Chrome's local network check).
  async function serverUp() {
    for (const timeout of [4000, 2000]) {
      try {
        const response = await pageFetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(timeout) });
        if (response.ok) return true;
      } catch {}
    }
    return false;
  }

  // Speak faster only as much as the sentence needs to fit before the next one starts.
  function plannedSpeed(index) {
    const cue = state.cues[index];
    const next = state.cues[index + 1];
    const slot = Math.max(0.8, (next ? next.start : cue.end + 1.5) - cue.start);
    const needed = cue.text.length / EMA_CHARS_PER_SEC;
    return Math.round(Math.min(MAX_SPEED, Math.max(1, needed / slot)) * 100) / 100;
  }

  function synth(index) {
    if (!audioCache.has(index)) {
      const request = pageFetch(`${TTS_URL}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: state.cues[index].text, speed: plannedSpeed(index) }),
      })
        .then((response) => (response.ok ? response.blob() : null))
        .then(
          (blob) =>
            blob &&
            new Promise((resolve) => {
              const url = URL.createObjectURL(blob);
              const probe = new Audio(url);
              probe.addEventListener("loadedmetadata", () => resolve({ url, duration: probe.duration }), { once: true });
              probe.addEventListener("error", () => resolve(null), { once: true });
            }),
        )
        .catch(() => null);
      audioCache.set(index, request);
    }
    return audioCache.get(index);
  }

  function prefetch(time) {
    for (let i = state.index; i < state.cues.length && state.cues[i].start < time + PREFETCH_AHEAD; i += 1) synth(i);
  }

  function clearAudioCache() {
    for (const request of audioCache.values()) request.then((clip) => clip && URL.revokeObjectURL(clip.url));
    audioCache.clear();
  }

  // How long this sentence may take before the next one should start.
  function slotFor(cue, next, video) {
    const now = Math.max(video.currentTime, cue.start);
    return Math.max(0.8, (next ? next.start : cue.end + 1.5) - now);
  }

  function finish(video) {
    busy = false;
    current = null;
    setTimeout(() => {
      if (!busy) unduck(video);
    }, 300);
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
      const stretch = Math.min(MAX_STRETCH, Math.max(1, clip.duration / slotFor(cue, next, video)));
      audio.playbackRate = stretch * video.playbackRate; // pitch is preserved by default
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
    utterance.onend = () => {
      setTimeout(() => {
        if (!speechSynthesis.speaking) unduck(video);
      }, 300);
    };
    speechSynthesis.speak(utterance);
  }

  const speaking = () => (state.engine === "ema" ? busy : speechSynthesis.speaking);

  function resetIndex(time) {
    const i = state.cues.findIndex((cue) => cue.end > time);
    state.index = i === -1 ? state.cues.length : i;
  }

  function tick() {
    const video = getVideo();
    if (!video || !state.cues.length || video.paused) return;
    const time = video.currentTime;
    if (state.engine === "ema") prefetch(time);

    while (state.index < state.cues.length) {
      const cue = state.cues[state.index];
      if (time < cue.start) return;
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
    if (video) unduck(video);
  }

  async function start() {
    const videoId = new URLSearchParams(location.search).get("v");
    if (!videoId || state.loading) return;
    state.loading = true;
    toast("Türkçe ses hazırlanıyor…");
    try {
      if (state.videoId !== videoId || !state.cues.length) {
        state.cues = await loadCues(videoId);
        state.videoId = videoId;
      }
      if (!state.on) return; // turned off while loading
      state.engine = (await serverUp()) ? "ema" : "browser";
      if (state.engine === "ema") toast("Türkçe ses açık (EMA Lightning)");
      else if (!state.voice) toast("Türkçe ses bulunamadı, varsayılan ses kullanılıyor.");
      else toast(`Türkçe ses açık (${state.voice.name}). Doğal ses için server/run.sh'i başlat.`);
      resetIndex(getVideo()?.currentTime ?? 0);
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
  }

  function setOn(on) {
    state.on = on;
    const button = document.getElementById("yt-dub-toggle");
    if (button) {
      button.setAttribute("aria-pressed", String(on));
      button.style.opacity = on ? "1" : "0.6";
    }
    if (on) start();
    else {
      stop();
    }
  }

  // --- UI -------------------------------------------------------------------

  let toastTimer = 0;
  function toast(message) {
    const host = getPlayer();
    if (!host) return;
    let box = document.getElementById("yt-dub-toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "yt-dub-toast";
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

  function mountButton() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls || document.getElementById("yt-dub-toggle")) return;
    const button = document.createElement("button");
    button.id = "yt-dub-toggle";
    button.className = "ytp-button";
    button.title = "Türkçe seslendirme (yt-dub)";
    button.setAttribute("aria-pressed", String(state.on));
    button.textContent = "TR";
    Object.assign(button.style, {
      font: "700 13px Roboto, Arial, sans-serif",
      color: "#fff",
      textAlign: "center",
      opacity: state.on ? "1" : "0.6",
    });
    button.addEventListener("click", () => setOn(!state.on));
    controls.prepend(button);
  }

  // --- wiring ---------------------------------------------------------------

  document.addEventListener(
    "seeked",
    (event) => {
      if (!state.on || event.target !== getVideo()) return;
      stopSpeech();
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
    stop();
    clearAudioCache();
    state.cues = [];
    state.videoId = null;
    if (state.on) start();
  });

  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });

  // Debug hook for the console: window.__ytDub.state, window.__ytDub.loadCues()
  window.__ytDub = { state, loadCues, buildCues, setOn };
})();

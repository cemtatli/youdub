// yt-dub v1: speaks YouTube captions in Turkish while the video plays.
// Runs in the page (MAIN world) so it can reach YouTube's player API.
// Caption URL + PO token approach learned from voice-over-translation (MIT):
// https://github.com/ilyhalight/voice-over-translation
(() => {
  const TARGET_LANG = "tr";
  const DUCK = 0.15; // original audio level while Turkish speech plays
  const CHARS_PER_SEC = 14; // rough Turkish speech speed at rate 1
  const MAX_RATE = 1.7;
  const LATE_SKIP = 2.5; // seconds; drop a cue if we reach it this late
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

  function speak(cue, next, video) {
    const now = Math.max(video.currentTime, cue.start);
    const slot = Math.max(0.8, (next ? next.start : cue.end + 1.5) - now);
    const needed = cue.text.length / CHARS_PER_SEC;
    const rate = Math.min(MAX_RATE, Math.max(1, needed / slot)) * video.playbackRate;

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

  function resetIndex(time) {
    const i = state.cues.findIndex((cue) => cue.end > time);
    state.index = i === -1 ? state.cues.length : i;
  }

  function tick() {
    const video = getVideo();
    if (!video || !state.cues.length || video.paused) return;
    const time = video.currentTime;

    while (state.index < state.cues.length) {
      const cue = state.cues[state.index];
      if (time < cue.start) return;
      if (time - cue.start > LATE_SKIP) {
        state.index += 1; // fell behind; skip rather than drift
        continue;
      }
      if (speechSynthesis.speaking) return; // wait for the current sentence to finish
      speak(cue, state.cues[state.index + 1], video);
      state.index += 1;
      return;
    }
  }

  // --- control --------------------------------------------------------------

  function stopSpeech() {
    speechSynthesis.cancel();
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
      if (!state.voice) toast("Türkçe ses bulunamadı, varsayılan ses kullanılıyor.");
      else toast(`Türkçe ses açık (${state.voice.name})`);
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
      if (state.on && event.target === getVideo()) speechSynthesis.pause();
    },
    true,
  );
  document.addEventListener(
    "play",
    (event) => {
      if (state.on && event.target === getVideo()) speechSynthesis.resume();
    },
    true,
  );

  // YouTube is a single-page app: a new video does not reload the page.
  document.addEventListener("yt-navigate-finish", () => {
    mountButton();
    stop();
    state.cues = [];
    state.videoId = null;
    if (state.on) start();
  });

  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });

  // Debug hook for the console: window.__ytDub.state, window.__ytDub.loadCues()
  window.__ytDub = { state, loadCues, buildCues, setOn };
})();

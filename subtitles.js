// youdub: one-click Turkish subtitles, a button next to TR in the player controls.
// Opens the video's own Turkish captions, or YouTube's auto-translation into Turkish from
// the spoken language (the menu route: CC → language → Auto-translate → Türkçe, at the very
// bottom). Remembered across videos.
//
// YouTube shows auto captions word by word as they are spoken, like a live stream. We draw
// them ourselves instead, Netflix-style: a whole sentence at a time (at most two lines),
// faded in. The caption data is the player's own response, copied as it arrives. If we
// don't get it, YouTube's captions stay, restyled (STYLE).
(() => {
  const KEY = "youdub-subtitles";
  const TARGET_LANG = "tr";
  const BUTTON_ID = "youdub-subtitles";
  const ON_CLASS = "youdub-subs"; // on #movie_player while our subtitles are on
  const OWN_CLASS = "youdub-subs-own"; // ...and we draw them ourselves
  const CAPTION_ID = "youdub-caption";
  const SHADE_ID = "youdub-caption-shade"; // dark gradient at the bottom while a caption shows
  const MAX_CHARS = 84; // two lines of ~42 characters, as on Netflix
  const LINGER = 1.2; // seconds a caption stays after its last word when nothing follows
  const log = (...args) => console.debug("[youdub:subs]", ...args);

  // Netflix-style captions: white Geist text on a light, see-through dark box that keeps it
  // readable on any picture. YouTube's caption options offer only a few fonts; this overrides
  // its inline styles. The size stays YouTube's: it scales with the player and its own size
  // setting. Geist (OFL) ships with the extension: the page can't be relied on to load fonts
  // from elsewhere. The extension ID is fixed by the "key" in manifest.json.
  const FONT_URL = "chrome-extension://eadpkhjldhfpfdaaabibjmijjmgnefdk/fonts/Geist-Variable.woff2";
  const STYLE = `
    @font-face {
      font-family: "youdub Geist";
      src: url("${FONT_URL}") format("woff2");
      font-weight: 100 900;
      font-display: swap;
    }
    /* Always centred: YouTube places auto captions by their own anchor, often off to one side. */
    #movie_player.${ON_CLASS} .caption-window {
      left: 50% !important;
      right: auto !important;
      margin-left: 0 !important;
      transform: translateX(-50%) !important;
      width: max-content !important;
      max-width: 82% !important;
      text-align: center !important;
      background: transparent !important;
      line-height: 1.3 !important;
    }
    #movie_player.${ON_CLASS} .captions-text {
      text-align: center !important;
    }
    #movie_player.${OWN_CLASS} .ytp-caption-window-container {
      display: none !important;
    }
    #${CAPTION_ID} {
      position: absolute;
      left: 50%;
      bottom: 6%;
      z-index: 40;
      max-width: min(82%, 24em);
      text-align: center;
      text-wrap: balance;
      line-height: 1.32;
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, 0.25em);
      transition: opacity 160ms ease-out, transform 160ms ease-out, bottom 200ms ease;
    }
    #movie_player:not(.ytp-autohide) #${CAPTION_ID} {
      bottom: calc(6% + 52px); /* above the controls while they show */
    }
    #${CAPTION_ID}.show {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    #${SHADE_ID} {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 30%;
      z-index: 39;
      pointer-events: none;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.45) 45%, transparent);
      opacity: 0;
      transition: opacity 300ms ease;
    }
    #${SHADE_ID}.show {
      opacity: 1;
    }
    #${CAPTION_ID} span,
    #movie_player.${ON_CLASS} .ytp-caption-segment {
      font-family: "youdub Geist", "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif !important;
      font-weight: 600 !important;
      letter-spacing: -0.005em !important;
      color: #fff !important;
      background: rgba(0, 0, 0, 0.5) !important;
      padding: 0.04em 0.35em !important;
      border-radius: 0.25em !important;
      box-decoration-break: clone !important;
      -webkit-box-decoration-break: clone !important;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6) !important;
      -webkit-font-smoothing: antialiased;
    }
    /* Our captions sit on the gradient: no box of their own. */
    #${CAPTION_ID} span {
      background: transparent !important;
      padding: 0 !important;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.75) !important;
    }
  `;

  const getPlayer = () => document.getElementById("movie_player");
  const getVideo = () => document.querySelector("video.html5-main-video") || document.querySelector("video");
  let on = false;
  try {
    on = localStorage.getItem(KEY) === "1";
  } catch {}

  // The video's own Turkish track if it has one; otherwise its spoken language (the first
  // caption track of the current audio track), translated. Prefers human captions.
  function pickTrack(player) {
    const tracks = player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) return null;
    const turkish = tracks.find((t) => t.languageCode === TARGET_LANG && t.kind !== "asr");
    if (turkish) return { languageCode: TARGET_LANG };
    const spoken = player.getAudioTrack?.()?.captionTracks?.[0]?.languageCode;
    const ofSpoken = tracks.filter((t) => t.languageCode === spoken && t.isTranslatable);
    const source =
      ofSpoken.find((t) => t.kind !== "asr") ??
      ofSpoken[0] ??
      tracks.find((t) => t.kind !== "asr" && t.isTranslatable) ??
      tracks.find((t) => t.isTranslatable);
    if (!source) return null;
    if (source.languageCode === TARGET_LANG) return { languageCode: TARGET_LANG };
    return { languageCode: source.languageCode, translationLanguage: { languageCode: TARGET_LANG } };
  }

  // --- caption data ---------------------------------------------------------

  // Every caption response the player receives, keyed by video, language and target.
  // (dub.js keeps its own copy for the voice; the two features don't depend on each other.)
  const responses = new Map();
  const key = (videoId, lang, tlang) => `${videoId}|${lang}|${tlang ?? ""}`;
  function remember(url, body) {
    if (!body?.trim().startsWith("{")) return; // a refused request gets an HTML page
    try {
      const params = new URL(url, location.origin).searchParams;
      if (params.get("fmt") === "json3") responses.set(key(params.get("v"), params.get("lang"), params.get("tlang")), body);
    } catch {}
  }
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(url).includes("/api/timedtext")) this.addEventListener("load", () => remember(String(url), this.responseText));
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

  const ENTITIES = { "&gt;": ">", "&lt;": "<", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
  const clean = (text) =>
    text
      .replace(/&(?:gt|lt|amp|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
      .replace(/>>+/g, " ") // speaker marks
      .replace(/\s+/g, " ")
      .trim();

  // json3 → captions of whole sentences. Each line's words are spread over its time (until
  // the next line starts), sentences end at . ! ? …, and a sentence longer than two lines is
  // cut into balanced parts, at a comma when one is near.
  function buildCaptions(json) {
    const lines = (json.events ?? [])
      .filter((event) => event.segs && !event.aAppend)
      .map((event) => ({
        text: clean(event.segs.map((seg) => seg.utf8 ?? "").join("")),
        start: event.tStartMs / 1000,
        end: (event.tStartMs + (event.dDurationMs ?? 2000)) / 1000,
      }))
      .filter((line) => line.text);
    const words = [];
    lines.forEach((line, i) => {
      const until = Math.min(line.end, lines[i + 1]?.start ?? Infinity);
      const parts = line.text.split(" ");
      parts.forEach((text, k) => words.push({ text, time: line.start + ((until - line.start) * k) / parts.length, end: until }));
    });

    const sentences = [];
    let current = [];
    for (const word of words) {
      current.push(word);
      if (/[.!?…]["')\]]?$/.test(word.text)) {
        sentences.push(current);
        current = [];
      }
    }
    if (current.length) sentences.push(current);

    const parts = [];
    for (const sentence of sentences) {
      const length = sentence.map((w) => w.text).join(" ").length;
      const pieces = Math.ceil(length / MAX_CHARS);
      const target = length / pieces;
      let part = [];
      let size = 0;
      sentence.forEach((word, i) => {
        part.push(word);
        size += word.text.length + 1;
        const more = i < sentence.length - 1;
        const comma = pieces > 1 && /,$/.test(word.text) && size >= target * 0.6; // cut a little early
        if (more && (size >= target || comma)) {
          parts.push(part);
          part = [];
          size = 0;
        }
      });
      if (part.length) parts.push(part);
    }

    return parts.map((part, i) => {
      const next = parts[i + 1]?.[0].time ?? Infinity;
      const last = part[part.length - 1];
      return {
        text: part.map((w) => w.text).join(" "),
        start: part[0].time,
        end: Math.min(next, Math.max(last.end, last.time + LINGER)),
      };
    });
  }

  // --- our own captions ------------------------------------------------------

  let captions = [];
  let captionsKey = null;
  let shown = null;
  let renderTimer = 0;
  let resize = null;

  function wantedKey(player) {
    const track = player.getOption?.("captions", "track");
    const videoId = player.getVideoData?.()?.video_id;
    if (!track?.languageCode || !videoId) return null;
    return key(videoId, track.languageCode, track.translationLanguage?.languageCode);
  }

  function captionBox(player) {
    let box = document.getElementById(CAPTION_ID);
    if (!box || box.parentElement !== player) {
      box?.remove();
      document.getElementById(SHADE_ID)?.remove();
      const shade = document.createElement("div");
      shade.id = SHADE_ID;
      player.appendChild(shade);
      box = document.createElement("div");
      box.id = CAPTION_ID;
      box.appendChild(document.createElement("span"));
      player.appendChild(box);
      // Netflix sizes captions by the picture: ~4.5% of the player's height.
      resize?.disconnect();
      resize = new ResizeObserver(() => {
        box.style.fontSize = `${Math.min(48, Math.max(15, player.clientHeight * 0.045))}px`;
      });
      resize.observe(player);
    }
    return box;
  }

  function show(box, caption) {
    if (caption === shown) return;
    shown = caption;
    box.classList.remove("show");
    // The gradient stays through the short gaps between captions; it fades only when they stop.
    document.getElementById(SHADE_ID)?.classList.toggle("show", Boolean(caption) || gapIsShort());
    if (!caption) return;
    box.firstChild.textContent = caption.text;
    void box.offsetWidth; // restart the fade for the new caption
    box.classList.add("show");
  }

  // Within a second of the next caption: keep the gradient up, so it doesn't pulse.
  function gapIsShort() {
    const time = getVideo()?.currentTime ?? 0;
    return captions.some((c) => c.start > time && c.start - time < 1);
  }

  function render() {
    const player = getPlayer();
    const video = getVideo();
    if (!on || !player || !video) return;
    const wanted = wantedKey(player);
    if (wanted !== captionsKey) {
      const body = wanted && responses.get(wanted);
      captions = body ? buildCaptions(JSON.parse(body)) : [];
      captionsKey = body ? wanted : null;
      if (body) log("drawing", captions.length, "captions for", wanted);
    }
    player.classList.toggle(OWN_CLASS, captions.length > 0);
    if (!captions.length) return;
    const box = captionBox(player);
    const time = video.currentTime;
    const ad = player.classList.contains("ad-showing");
    show(box, ad ? null : (captions.find((c) => time >= c.start && time < c.end) ?? null));
  }

  function startDrawing() {
    clearInterval(renderTimer);
    renderTimer = setInterval(render, 100);
  }

  function stopDrawing() {
    clearInterval(renderTimer);
    shown = null;
    captionsKey = null;
    captions = [];
    document.getElementById(CAPTION_ID)?.remove();
    document.getElementById(SHADE_ID)?.remove();
    getPlayer()?.classList.remove(OWN_CLASS);
  }

  // --- control --------------------------------------------------------------

  // The player response of a new video arrives a moment after navigation: retry briefly.
  let applyTimer = 0;
  function apply(tries = 20) {
    clearTimeout(applyTimer);
    const player = getPlayer();
    if (!on) return;
    const track = player && pickTrack(player);
    if (!track) {
      if (tries > 0) applyTimer = setTimeout(() => apply(tries - 1), 500);
      return;
    }
    player.classList.add(ON_CLASS);
    startDrawing();
    player.loadModule?.("captions");
    const shown = player.getOption?.("captions", "track");
    const same =
      shown?.languageCode === track.languageCode &&
      (shown?.translationLanguage?.languageCode ?? null) === (track.translationLanguage?.languageCode ?? null);
    if (!same) player.setOption?.("captions", "track", track);
    log("on", track.languageCode, track.translationLanguage ? `→ ${TARGET_LANG}` : "");
  }

  function setOn(value) {
    on = value;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {}
    paintButton();
    const player = getPlayer();
    if (on) apply();
    else if (player) {
      stopDrawing();
      player.classList.remove(ON_CLASS);
      player.unloadModule?.("captions"); // captions off, as the CC button does
    }
  }

  // --- UI -------------------------------------------------------------------

  // A globe (language), drawn with DOM calls: YouTube enforces Trusted Types.
  function icon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    const shapes = [
      ["circle", { cx: 12, cy: 12, r: 8.5 }],
      ["ellipse", { cx: 12, cy: 12, rx: 3.6, ry: 8.5 }], // meridians
      ["path", { d: "M3.8 9h16.4M3.8 15h16.4" }], // parallels
    ];
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
      svg.appendChild(shape);
    }
    return svg;
  }

  function paintButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.querySelector("svg")?.setAttribute("stroke", on ? "#EF1B37" : "#fff");
    button.setAttribute("aria-pressed", String(on));
  }

  function mountButton() {
    const controls = document.querySelector(".ytp-right-controls-left") ?? document.querySelector(".ytp-right-controls");
    if (!controls || document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.className = "ytp-button";
    button.title = "Türkçe altyazı (youdub)";
    button.setAttribute("aria-label", button.title);
    button.appendChild(icon());
    button.addEventListener("click", () => setOn(!on));
    // Right after the TR (dub) button when it is there.
    const dub = document.getElementById("youdub-toggle");
    if (dub?.parentElement === controls) dub.after(button);
    else controls.prepend(button);
    paintButton();
  }

  function mountStyle() {
    if (document.getElementById(`${BUTTON_ID}-style`) || !document.head) return;
    const style = document.createElement("style");
    style.id = `${BUTTON_ID}-style`;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // --- wiring ---------------------------------------------------------------

  document.addEventListener("yt-navigate-finish", () => {
    mountStyle();
    mountButton();
    apply();
  });
  // The dub (dub.js) may switch the shown track to fetch the captions it needs.
  window.addEventListener("youdub-captions-changed", () => setTimeout(() => apply(), 300));
  new MutationObserver(() => {
    mountStyle();
    mountButton();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

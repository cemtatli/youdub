// youdub: one-click Turkish subtitles, a button next to TR in the player controls.
// Opens the video's own Turkish captions, or YouTube's auto-translation into Turkish from
// the spoken language (the menu route: CC → language → Auto-translate → Türkçe, at the very
// bottom). Remembered across videos. While on, the captions get our own style (STYLE).
(() => {
  const KEY = "youdub-subtitles";
  const TARGET_LANG = "tr";
  const BUTTON_ID = "youdub-subtitles";
  const ON_CLASS = "youdub-subs"; // on #movie_player while our subtitles are on
  const log = (...args) => console.debug("[youdub:subs]", ...args);

  // Netflix-style captions: no box, white Geist text with a soft dark halo that keeps it
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
    #movie_player.${ON_CLASS} .ytp-caption-segment {
      font-family: "youdub Geist", "SF Pro Text", -apple-system, BlinkMacSystemFont, sans-serif !important;
      font-weight: 600 !important;
      letter-spacing: -0.005em !important;
      color: #fff !important;
      background: transparent !important;
      text-shadow:
        0 0 2px rgba(0, 0, 0, 0.9),
        0 0 6px rgba(0, 0, 0, 0.6),
        0 2px 4px rgba(0, 0, 0, 0.8) !important;
      -webkit-font-smoothing: antialiased;
    }
  `;

  const getPlayer = () => document.getElementById("movie_player");
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
      player.classList.remove(ON_CLASS);
      player.unloadModule?.("captions"); // captions off, as the CC button does
    }
  }

  // --- UI -------------------------------------------------------------------

  // A caption box with "TR" in it, built with DOM calls (YouTube enforces Trusted Types).
  function icon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const box = document.createElementNS(ns, "rect");
    for (const [k, v] of Object.entries({ x: 3, y: 5, width: 18, height: 14, rx: 2.5, fill: "none", "stroke-width": 1.8 })) {
      box.setAttribute(k, v);
    }
    const text = document.createElementNS(ns, "text");
    for (const [k, v] of Object.entries({ x: 12, y: 15.4, "text-anchor": "middle", "font-size": 8.5, "font-weight": 700 })) {
      text.setAttribute(k, v);
    }
    text.setAttribute("font-family", "Roboto, Arial, sans-serif");
    text.textContent = "TR";
    svg.append(box, text);
    return svg;
  }

  function paintButton() {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    const color = on ? "#EF1B37" : "#fff";
    button.querySelector("rect")?.setAttribute("stroke", color);
    button.querySelector("text")?.setAttribute("fill", color);
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

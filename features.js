// Feed tweaks controlled from the popup (chrome.storage.sync), plus the popup's line to
// minimal mode in actions.js. Runs in the isolated world: it needs chrome.storage and
// chrome.runtime, and shares the page's DOM and localStorage.
//   shortsHidden  hides Shorts shelves, the Shorts guide entry and Shorts in search/feeds.
//   watchedMode   "off" | "dim" | "hide" for videos you've mostly watched (red bar >= 80%).
(() => {
  "use strict";

  const DEFAULTS = { shortsHidden: false, watchedMode: "off" };
  const MINIMAL_KEY = "youdub-minimal"; // owned by actions.js
  const WATCHED_MIN = 80; // percent of the red progress bar
  // Pages where watched videos are the point; never dim or hide there.
  const WATCHED_SKIP_RE = /^\/(?:feed\/history|playlist|feed\/playlists|feed\/library|@[^/]+\/playlists)/;

  // A video card, whichever renderer YouTube used for it.
  const ITEM = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "yt-lockup-view-model",
  ].join(",");
  // The red "watched" bar: the old overlay's #progress and the new lockup's segment.
  const PROGRESS = [
    "ytd-thumbnail-overlay-resume-playback-renderer #progress",
    "[class*='WatchedProgressBarSegment']",
  ].join(",");

  let settings = { ...DEFAULTS };
  const html = document.documentElement;

  // --- styles ---------------------------------------------------------------

  const SHORTS = [
    "ytd-rich-shelf-renderer[is-shorts]",
    "ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])",
    "ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model)",
    "ytd-reel-shelf-renderer",
    "grid-shelf-view-model:has(ytm-shorts-lockup-view-model)",
    "ytd-item-section-renderer:has(> #contents > grid-shelf-view-model ytm-shorts-lockup-view-model):not(:has(ytd-video-renderer))",
    "ytd-guide-entry-renderer:has(a[title='Shorts'])",
    "ytd-mini-guide-entry-renderer[aria-label='Shorts']",
    "ytd-rich-item-renderer:has(a[href^='/shorts/'])",
    "ytd-video-renderer:has(a[href^='/shorts/'])",
    "ytd-compact-video-renderer:has(a[href^='/shorts/'])",
    "yt-tab-shape[tab-title='Shorts']",
  ];

  function injectStyle() {
    if (document.getElementById("knobs-features-style")) return;
    const style = document.createElement("style");
    style.id = "knobs-features-style";
    style.textContent = `
      ${SHORTS.map((s) => `html.knobs-no-shorts ${s}`).join(",\n      ")} { display: none !important; }
      html.knobs-watched-dim [data-knobs-watched] {
        opacity: 0.4;
        filter: saturate(0.4);
        transition: opacity 0.2s ease, filter 0.2s ease;
      }
      html.knobs-watched-dim [data-knobs-watched]:hover { opacity: 1; filter: none; }
      html.knobs-watched-hide [data-knobs-watched] { display: none !important; }
    `;
    (document.head || html).append(style);
  }

  // --- watched videos -------------------------------------------------------

  function watchedHere() {
    return settings.watchedMode !== "off" && !WATCHED_SKIP_RE.test(location.pathname);
  }

  function percent(bar) {
    const m = /width:\s*([\d.]+)%/.exec(bar.getAttribute("style") || "");
    return m ? Number(m[1]) : 0;
  }

  // Cards are recycled for other videos as you scroll, so every pass re-derives the mark
  // from the bar that is there now instead of trusting an old one.
  function markWatched() {
    const marked = new Set();
    if (watchedHere()) {
      for (const bar of document.querySelectorAll(PROGRESS)) {
        if (percent(bar) < WATCHED_MIN) continue;
        // The new lockup sits inside ytd-rich-item-renderer; mark the outermost card.
        let item = bar.closest(ITEM);
        const outer = item?.parentElement?.closest(ITEM);
        if (outer) item = outer;
        if (item) marked.add(item);
      }
    }
    for (const el of document.querySelectorAll("[data-knobs-watched]")) {
      if (!marked.has(el)) delete el.dataset.knobsWatched;
    }
    for (const el of marked) if (!el.dataset.knobsWatched) el.dataset.knobsWatched = "";
  }

  let pending = false;
  function scheduleMark() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      markWatched();
    }, 250);
  }

  const observer = new MutationObserver(() => {
    if (settings.watchedMode !== "off") scheduleMark();
  });

  // --- apply ----------------------------------------------------------------

  function apply() {
    html.classList.toggle("knobs-no-shorts", !!settings.shortsHidden);
    html.classList.toggle("knobs-watched-dim", settings.watchedMode === "dim");
    html.classList.toggle("knobs-watched-hide", settings.watchedMode === "hide");
    markWatched();
  }

  document.addEventListener("yt-navigate-finish", () => markWatched());

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) {
        settings[key] = newValue ?? DEFAULTS[key];
        changed = true;
      }
    }
    if (changed) apply();
  });

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    injectStyle();
    apply();
    observer.observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
  });

  // --- popup <-> minimal mode -----------------------------------------------

  // The popup can't see this tab's localStorage or call actions.js (page world), so it asks
  // here; the change goes on to actions.js as a window message, like bridge.js does.
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "knobs:get") {
      let minimal = false;
      try {
        minimal = localStorage.getItem(MINIMAL_KEY) === "1";
      } catch {}
      reply({ minimal });
    } else if (message?.type === "knobs:minimal") {
      window.postMessage({ source: "youdub-ext", type: "minimal", on: !!message.on }, "*");
      reply({ minimal: !!message.on });
    }
  });
})();

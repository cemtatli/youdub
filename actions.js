// youdub: extra buttons in the Like / Share row under the video.
// - Watch later: one click adds / removes the video. Runs in the page (MAIN world) so it can
//   use YouTube's own InnerTube API with the signed-in session, like the "Save" menu does.
// - Minimal mode: hides the recommendations column; remembered across videos. Chapters,
//   when the video has them, open in its place, under a compact "Ask" (Gemini) button that
//   stands in for the description's Ask card.
(() => {
  const PLAYLIST_ID = "WL";
  const log = (...args) => console.debug("[youdub:wl]", ...args);

  const MINIMAL_KEY = "youdub-minimal";
  const CHAPTERS_ID = '[target-id="engagement-panel-macro-markers-description-chapters"]';
  const CHAPTERS = `ytd-engagement-panel-section-list-renderer${CHAPTERS_ID}`;
  const EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
  const ASK = "yt-video-description-youchat-section-view-model"; // "Soru" card in the description
  const state = { videoId: null, saved: false, busy: false, minimal: false, chaptersFor: null };

  const getPlayer = () => document.getElementById("movie_player");
  const currentVideoId = () =>
    getPlayer()?.getVideoData?.()?.video_id || new URLSearchParams(location.search).get("v");

  // --- InnerTube --------------------------------------------------------------

  function cookie(name) {
    return document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1];
  }

  async function sha1(text) {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Signed-in requests carry SAPISIDHASH: sha1("<time> <SAPISID> <origin>").
  async function authHeader() {
    const sapisid = cookie("SAPISID") ?? cookie("__Secure-3PAPISID");
    if (!sapisid) return null;
    const time = Math.floor(Date.now() / 1000);
    return `SAPISIDHASH ${time}_${await sha1(`${time} ${sapisid} ${location.origin}`)}`;
  }

  async function innertube(endpoint, body) {
    const cfg = window.ytcfg;
    const headers = {
      "Content-Type": "application/json",
      "X-Origin": location.origin,
      "X-Goog-AuthUser": String(cfg.get("SESSION_INDEX") ?? 0),
    };
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const visitor = cfg.get("VISITOR_DATA");
    if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
    const pageId = cfg.get("DELEGATED_SESSION_ID"); // brand accounts
    if (pageId) headers["X-Goog-PageId"] = pageId;
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ context: cfg.get("INNERTUBE_CONTEXT"), ...body }),
    });
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    return res.json();
  }

  // The Save menu's data; the WL entry says whether this video is already in it.
  // Searched loosely because the menu's renderer names change between UI versions.
  function findWatchLater(node) {
    if (!node || typeof node !== "object") return null;
    if (node.playlistId === PLAYLIST_ID && "containsSelectedVideos" in node) return node;
    for (const value of Object.values(node)) {
      const found = findWatchLater(value);
      if (found) return found;
    }
    return null;
  }

  async function loadSaved(videoId) {
    const data = await innertube("playlist/get_add_to_playlist", {
      videoIds: [videoId],
      excludeWatchLater: false,
    });
    return findWatchLater(data)?.containsSelectedVideos === "ALL";
  }

  async function setSaved(videoId, saved) {
    const action = saved
      ? { action: "ACTION_ADD_VIDEO", addedVideoId: videoId }
      : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: videoId };
    const data = await innertube("browse/edit_playlist", { playlistId: PLAYLIST_ID, actions: [action] });
    if (data.status && data.status !== "STATUS_SUCCEEDED") throw new Error(data.status);
  }

  // --- UI -------------------------------------------------------------------

  // YouTube's own bottom-left toast.
  function toast(message) {
    const app = document.querySelector("ytd-app");
    if (!app) return;
    app.dispatchEvent(
      new CustomEvent("yt-action", {
        bubbles: true,
        composed: true,
        detail: {
          actionName: "yt-open-popup-action",
          args: [
            {
              openPopupAction: {
                popup: { notificationActionRenderer: { responseText: { simpleText: message } } },
                popupType: "TOAST",
              },
            },
            app,
          ],
          returnValue: [],
        },
      }),
    );
  }

  // Built with DOM calls because YouTube enforces Trusted Types. Drawn like YouTube's
  // own icons: a 2px rounded outline while not saved, solid (hands cut out) once saved.
  function clockIcon(saved) {
    const ns = "http://www.w3.org/2000/svg";
    const el = (name, attrs) => {
      const node = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    const svg = el("svg", { viewBox: "0 0 24 24", width: "24", height: "24", fill: "none" });
    svg.style.display = "block";
    const hands = { d: "M12 7v5l3.5 2", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (saved) {
      const mask = el("mask", { id: "youdub-wl-mask" });
      mask.append(el("rect", { width: "24", height: "24", fill: "#fff" }), el("path", { ...hands, stroke: "#000" }));
      svg.append(mask, el("circle", { cx: "12", cy: "12", r: "10", fill: "currentColor", mask: "url(#youdub-wl-mask)" }));
    } else {
      svg.append(
        el("circle", { cx: "12", cy: "12", r: "9", stroke: "currentColor", "stroke-width": "2" }),
        el("path", { ...hands, stroke: "currentColor" }),
      );
    }
    return svg;
  }

  // A window with the recommendations column: outlined while shown, filled once hidden.
  function sidebarIcon(minimal) {
    const ns = "http://www.w3.org/2000/svg";
    const el = (name, attrs) => {
      const node = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    const svg = el("svg", { viewBox: "0 0 24 24", width: "24", height: "24", fill: "none" });
    svg.style.display = "block";
    const line = { stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" };
    svg.append(el("rect", { x: "3", y: "4", width: "18", height: "16", rx: "3", ...line }));
    if (minimal) svg.append(el("path", { d: "M15 4h3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-3z", fill: "currentColor" }));
    svg.append(el("path", { d: "M15 4v16", ...line }));
    return svg;
  }

  function paint(id, icon, label, pressed) {
    const button = document.getElementById(id);
    if (!button) return;
    button.querySelector(".youdub-row-icon").replaceChildren(icon);
    button.parentElement.querySelector(".youdub-row-tip").textContent = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(pressed));
  }

  function paintButton() {
    paint("youdub-watchlater", clockIcon(state.saved), state.saved ? "Daha sonra izle'den çıkar" : "Daha sonra izle", state.saved);
    const button = document.getElementById("youdub-watchlater");
    if (button) button.style.opacity = state.busy ? "0.5" : "";
  }

  function paintMinimal() {
    paint("youdub-minimal", sidebarIcon(state.minimal), state.minimal ? "Önerileri göster" : "Minimal mod", state.minimal);
  }

  async function toggle() {
    const videoId = currentVideoId();
    if (!videoId || state.busy) return;
    const next = !state.saved;
    state.busy = true;
    paintButton();
    try {
      await setSaved(videoId, next);
      if (currentVideoId() === videoId) state.saved = next;
      toast(next ? "Daha sonra izle'ye eklendi" : "Daha sonra izle'den çıkarıldı");
    } catch (error) {
      log("edit failed", error);
      toast("Daha sonra izle güncellenemedi (oturum açık mı?)");
    } finally {
      state.busy = false;
      paintButton();
    }
  }

  async function refresh() {
    const videoId = currentVideoId();
    if (!videoId || videoId === state.videoId) return;
    state.videoId = videoId;
    state.saved = false;
    paintButton();
    try {
      const saved = await loadSaved(videoId);
      if (state.videoId === videoId) state.saved = saved;
    } catch (error) {
      log("status failed", error);
    }
    paintButton();
  }

  // Drop the row's own Save and Ask buttons (Cem doesn't use them; this button replaces
  // Save). Removed from the menu's data, so they don't fall back into the "..." menu either.
  // Save is PLAYLIST_ADD; Ask uses a spark icon.
  const isDropped = (item) => /"iconType":"(PLAYLIST_ADD|[A-Z_]*SPARK[A-Z_]*)"/.test(JSON.stringify(item));

  function dropMenuItems(menu) {
    const host = menu.polymerController ?? menu.inst ?? menu;
    const data = host.data;
    if (!data) return;
    const flexibleItems = data.flexibleItems?.filter((item) => !isDropped(item));
    const items = data.items?.filter((item) => !isDropped(item));
    if (flexibleItems?.length === data.flexibleItems?.length && items?.length === data.items?.length) return;
    host.data = { ...data, flexibleItems, items };
  }

  // --- minimal mode ---------------------------------------------------------

  // Opens the chapters panel once per video; closing it with its X is respected.
  function openChapters() {
    const videoId = currentVideoId();
    if (!state.minimal || !videoId || state.chaptersFor === videoId) return;
    const panel = document.querySelector(CHAPTERS);
    if (!panel?.querySelector("ytd-macro-markers-list-item-renderer")) return;
    state.chaptersFor = videoId;
    panel.setAttribute("visibility", EXPANDED);
  }

  // A compact Ask button at the top of the right column. It presses the description's own
  // "Soru sorun" button, so YouTube opens its Gemini panel as usual.
  function sparkIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 3c.5 4.6 3.4 7.5 9 9-5.6 1.5-8.5 4.4-9 9-.5-4.6-3.4-7.5-9-9 5.6-1.5 8.5-4.4 9-9z");
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }

  // Keeps --youdub-player-height in step with the player.
  const playerSize = new ResizeObserver(([entry]) => {
    document.documentElement.style.setProperty("--youdub-player-height", `${Math.round(entry.contentRect.height)}px`);
  });
  let observedPlayer = null;
  function watchPlayerSize() {
    const player = getPlayer();
    if (!player || player === observedPlayer) return;
    if (observedPlayer) playerSize.unobserve(observedPlayer);
    playerSize.observe(player);
    observedPlayer = player;
  }

  const askSource = () => document.querySelector(`ytd-watch-metadata ${ASK} button`);

  function placeAsk() {
    watchPlayerSize();
    const column = document.querySelector("ytd-watch-flexy #secondary-inner") ?? document.querySelector("ytd-watch-flexy #secondary");
    if (!column) return;
    let button = document.getElementById("youdub-ask");
    if (!button) {
      button = document.createElement("button");
      button.id = "youdub-ask";
      const label = document.createElement("span");
      label.textContent = "Bu video hakkında soru sor";
      button.append(sparkIcon(), label);
      button.addEventListener("click", () => askSource()?.click());
      column.prepend(button);
    }
    const available = !!askSource();
    if (button.hidden === available) button.hidden = !available;
  }

  function setMinimal(on) {
    state.minimal = on;
    state.chaptersFor = null;
    placeAsk();
    if (on) openChapters();
    else {
      // Back to the normal page: close chapters, Gemini and any other side panel.
      for (const panel of document.querySelectorAll(`ytd-watch-flexy #secondary [visibility="${EXPANDED}"]`)) {
        panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      }
    }
    document.documentElement.classList.toggle("youdub-minimal", on);
    try {
      localStorage.setItem(MINIMAL_KEY, on ? "1" : "0");
    } catch {}
    paintMinimal();
    window.dispatchEvent(new Event("resize")); // let the player resize to the wider column
  }

  try {
    state.minimal = localStorage.getItem(MINIMAL_KEY) === "1";
  } catch {}
  document.documentElement.classList.toggle("youdub-minimal", state.minimal);

  // --- row buttons ----------------------------------------------------------

  // Tooltip like the row's own ("Kaydet"); a stylesheet because it needs :hover.
  // Minimal mode: no recommendations. The column stays while a panel (chapters, transcript,
  // ...) is open in it; otherwise it goes and the video column is centred at player width.
  // Theater and fullscreen already hide it from beside the video, so they are left alone.
  const STYLE = `
    .youdub-row-wrap { position: relative; display: inline-flex; flex: none; }
    .youdub-row-tip {
      position: absolute; top: calc(100% + 24px); left: 50%; transform: translateX(-50%);
      padding: 8px; border-radius: 4px; white-space: nowrap; pointer-events: none;
      background: #616161e6; color: #fff; font: 400 12px/18px Roboto, Arial, sans-serif;
      opacity: 0; transition: opacity 0.1s; z-index: 2202;
    }
    .youdub-row-wrap:hover .youdub-row-tip { opacity: 1; transition-delay: 0.3s; }
    html.youdub-minimal ytd-watch-flexy #secondary #related { display: none !important; }
    #youdub-ask {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; height: 40px; margin: 0 0 12px; padding: 0 16px; border: 0; border-radius: 20px;
      background: var(--yt-spec-badge-chip-background, rgba(255,255,255,0.1));
      color: var(--yt-spec-text-primary, #fff); font: 500 14px/20px Roboto, Arial, sans-serif;
      cursor: pointer;
    }
    #youdub-ask:hover { background: var(--yt-spec-button-chip-background-hover, rgba(255,255,255,0.2)); }
    #youdub-ask[hidden], html:not(.youdub-minimal) #youdub-ask { display: none; }
    html.youdub-minimal ytd-watch-metadata ${ASK} { display: none; }
    /* Gemini (or any other panel) open: it gets the whole column. */
    html.youdub-minimal #secondary:has([visibility="${EXPANDED}"]:not(${CHAPTERS_ID})) :is(#youdub-ask, ${CHAPTERS_ID}) {
      display: none !important;
    }
    /* The column ends with the player: YouTube sizes panels for the narrower two-column
       player, so use the real player height (--youdub-player-height, set from JS). */
    html.youdub-minimal #secondary [visibility="${EXPANDED}"] {
      max-height: var(--youdub-player-height, var(--ytd-watch-flexy-panel-max-height)) !important;
    }
    html.youdub-minimal #secondary:has(#youdub-ask:not([hidden])) ${CHAPTERS_ID} {
      max-height: calc(var(--youdub-player-height, var(--ytd-watch-flexy-panel-max-height)) - 52px) !important;
    }
    html.youdub-minimal ytd-watch-flexy:not([theater]):not([fullscreen]):not(:has(#secondary [visibility="${EXPANDED}"])):not(:has(#youdub-ask:not([hidden]))) #secondary {
      display: none !important;
    }
    html.youdub-minimal ytd-watch-flexy:not([theater]):not([fullscreen]):not(:has(#secondary [visibility="${EXPANDED}"])):not(:has(#youdub-ask:not([hidden]))) #primary {
      max-width: var(--ytd-watch-flexy-max-player-width) !important;
      margin-inline: auto !important;
      padding-right: 0 !important;
    }
  `;

  function addStyle() {
    if (document.getElementById("youdub-row-style")) return;
    const style = document.createElement("style");
    style.id = "youdub-row-style";
    style.textContent = STYLE;
    (document.head ?? document.documentElement).appendChild(style);
  }

  // Copies the "..." button (the row's other icon-only round button) so size, colours,
  // hover and spacing match YouTube's own exactly.
  function rowButton(more, id, onClick) {
    const template = more.querySelector("button");
    const button = template.cloneNode(false); // classes only; YouTube's handlers stay behind
    button.id = id;
    button.removeAttribute("aria-haspopup");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("title");
    const iconBox = template.querySelector(".yt-spec-button-shape-next__icon")?.cloneNode(false) ?? document.createElement("div");
    const icon = document.createElement("span");
    icon.className = "youdub-row-icon";
    Object.assign(icon.style, { display: "block", width: "24px", height: "24px" });
    iconBox.appendChild(icon);
    button.appendChild(iconBox);
    button.addEventListener("click", onClick);
    const tip = document.createElement("span");
    tip.className = "youdub-row-tip";
    const wrap = document.createElement("div");
    wrap.className = "youdub-row-wrap";
    wrap.style.marginLeft = getComputedStyle(more).marginLeft;
    wrap.append(button, tip); // outside the button, which clips its contents
    more.before(wrap);
  }

  function mountButton() {
    addStyle();
    const menu = document.querySelector("ytd-watch-metadata #actions ytd-menu-renderer");
    if (!menu) return;
    dropMenuItems(menu); // YouTube re-renders the row per video, so check every time
    openChapters(); // chapters arrive after the row
    placeAsk();
    if (document.getElementById("youdub-watchlater")) return;
    const more = menu.querySelector(":scope > #button-shape");
    if (!more?.querySelector("button")) return;
    rowButton(more, "youdub-watchlater", toggle);
    rowButton(more, "youdub-minimal", () => setMinimal(!state.minimal));
    paintButton();
    paintMinimal();
    refresh();
  }

  // --- wiring ---------------------------------------------------------------

  document.addEventListener("yt-navigate-finish", () => {
    mountButton();
    refresh();
  });

  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });

  // Debug hook for the console: window.__youdubActions.state
  window.__youdubActions = { state, loadSaved, setSaved, refresh, setMinimal };
})();

// Real thumbnails: swap the uploader-chosen thumbnail for a frame YouTube took from the video.
//
// YouTube saves three stills per video at roughly 25% / 50% / 75%:
//   i.ytimg.com/vi/<id>/maxres{1,2,3}.jpg   1280x720, HD videos only
//   i.ytimg.com/vi/<id>/hq{1,2,3}.jpg       480x360, every video (letterboxed)
// We try maxresN, fall back to hqN, and keep the original if neither exists.
// Adapted from Honest Thumbnails by 851 Labs (MIT): https://github.com/851-labs/honest-thumbnails
// Runs in the isolated world so it can read chrome.storage; the popup writes the settings.
(() => {
  "use strict";

  const DEFAULTS = { thumbsEnabled: true, thumbsFrame: 2 };
  const ORIGIN = "https://i.ytimg.com";

  // Video thumbnails live under /vi/<id>/ or /vi_webp/<id>/. Storyboards (/sb/) and animated
  // hover previews (/an_webp/) are deliberately not matched.
  const THUMB_RE = /^(?:https?:)?\/\/i\d*\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\/(\w+)\.(?:jpg|webp)/;
  // Names that are already auto-generated frames, not uploader thumbnails.
  const AUTO_FRAME_RE = /^(?:hq|mq|sd|maxres|oar|hq720_)?[123]$/;
  const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/;
  // YouTube serves a 120x90 grey placeholder for frames that don't exist.
  const PLACEHOLDER_WIDTH = 120;

  let settings = { ...DEFAULTS };

  // --- frame lookup ---------------------------------------------------------

  const cache = new Map(); // "<id>:<frame>" -> Promise<url | null>

  function probe(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > PLACEHOLDER_WIDTH);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  function resolveFrame(id, frame) {
    const key = `${id}:${frame}`;
    let promise = cache.get(key);
    if (!promise) {
      promise = (async () => {
        for (const name of [`maxres${frame}`, `hq${frame}`]) {
          const url = `${ORIGIN}/vi/${id}/${name}.jpg`;
          if (await probe(url)) return url;
        }
        return null;
      })();
      cache.set(key, promise);
    }
    return promise;
  }

  function parseThumb(url) {
    const m = url && THUMB_RE.exec(url);
    if (!m || AUTO_FRAME_RE.test(m[2])) return null;
    return m[1];
  }

  // --- <img> thumbnails -----------------------------------------------------

  function processImg(img) {
    const src = img.getAttribute("src") || "";
    if (img.dataset.youdubThumb && src === img.dataset.youdubThumb) return; // ours

    // New src from YouTube (first load, or the element was recycled for another video).
    delete img.dataset.youdubThumb;
    delete img.dataset.youdubThumbSrcset;

    const id = parseThumb(src);
    if (!id) {
      delete img.dataset.youdubThumbOrig;
      return;
    }

    img.dataset.youdubThumbOrig = src;
    const frame = settings.thumbsFrame;
    resolveFrame(id, frame).then((url) => {
      if (!url || !settings.thumbsEnabled || settings.thumbsFrame !== frame) return;
      if (img.getAttribute("src") !== src) return; // recycled while probing
      img.dataset.youdubThumb = url; // mark before setting src so the observer skips it
      if (img.hasAttribute("srcset")) {
        img.dataset.youdubThumbSrcset = img.getAttribute("srcset");
        img.removeAttribute("srcset");
      }
      img.src = url;
    });
  }

  // --- background-image thumbnails (player poster, end-screen wall) ---------

  function processBg(el) {
    const style = el.getAttribute("style");
    if (!style || !style.includes("ytimg.com")) return;
    const bg = el.style.backgroundImage;
    const m = bg && CSS_URL_RE.exec(bg);
    if (!m) return;
    const current = m[1];
    if (el.dataset.youdubThumbBg && current === el.dataset.youdubThumbBg) return; // ours

    delete el.dataset.youdubThumbBg;
    const id = parseThumb(current);
    if (!id) {
      delete el.dataset.youdubThumbBgOrig;
      return;
    }

    el.dataset.youdubThumbBgOrig = bg;
    const frame = settings.thumbsFrame;
    resolveFrame(id, frame).then((url) => {
      if (!url || !settings.thumbsEnabled || settings.thumbsFrame !== frame) return;
      if (el.style.backgroundImage !== bg) return;
      el.dataset.youdubThumbBg = url;
      el.style.backgroundImage = `url("${url}")`;
    });
  }

  // --- scanning -------------------------------------------------------------

  function scan(root) {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.tagName === "IMG") processImg(root);
    else if (root.getAttribute?.("style")) processBg(root);
    for (const img of root.querySelectorAll('img[src*="ytimg.com/vi"]')) processImg(img);
    for (const el of root.querySelectorAll('[style*="ytimg.com/vi"]')) processBg(el);
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.thumbsEnabled) return;
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.attributeName === "src") {
          if (m.target.tagName === "IMG") processImg(m.target);
        } else {
          processBg(m.target);
        }
      } else {
        for (const node of m.addedNodes) scan(node);
      }
    }
  });

  function revertAll() {
    for (const img of document.querySelectorAll("img[data-youdub-thumb-orig]")) {
      const ours = img.dataset.youdubThumb;
      const orig = img.dataset.youdubThumbOrig;
      delete img.dataset.youdubThumb;
      delete img.dataset.youdubThumbOrig;
      if (img.dataset.youdubThumbSrcset !== undefined) {
        img.setAttribute("srcset", img.dataset.youdubThumbSrcset);
        delete img.dataset.youdubThumbSrcset;
      }
      if (ours && img.getAttribute("src") === ours) img.src = orig;
    }
    for (const el of document.querySelectorAll("[data-youdub-thumb-bg-orig]")) {
      const ours = el.dataset.youdubThumbBg;
      const orig = el.dataset.youdubThumbBgOrig;
      delete el.dataset.youdubThumbBg;
      delete el.dataset.youdubThumbBgOrig;
      if (ours && el.style.backgroundImage.includes(ours)) el.style.backgroundImage = orig;
    }
  }

  // hq1/2/3 frames are 4:3 with letterbox bars; crop them away.
  function injectStyle() {
    const style = document.createElement("style");
    style.id = "youdub-thumbs-style";
    style.textContent = `
      img[data-youdub-thumb] { object-fit: cover !important; }
      [data-youdub-thumb-bg] { background-size: cover !important; background-position: center !important; }
    `;
    (document.head || document.documentElement).append(style);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let changed = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) {
        settings[key] = newValue ?? DEFAULTS[key];
        changed = true;
      }
    }
    if (!changed) return;
    revertAll();
    if (settings.thumbsEnabled) scan(document);
  });

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    injectStyle();
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src", "style"],
    });
    if (settings.thumbsEnabled) scan(document);
  });
})();

// Settings popup. thumbnails.js and features.js read these keys from chrome.storage.sync;
// minimal mode lives in the YouTube tab, so it goes through features.js in that tab.
const DEFAULTS = { thumbsEnabled: true, thumbsFrame: 2, shortsHidden: false, watchedMode: "off" };
const $ = (id) => document.getElementById(id);
const t = (key) => chrome.i18n.getMessage(key);

// Strings come from _locales/<lang>/messages.json, picked by the browser's language.
document.documentElement.lang = chrome.i18n.getUILanguage();
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));

function setPressed(group, value) {
  for (const btn of group.querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.value === String(value)));
  }
}

function render(s) {
  $("thumbs-enabled").checked = s.thumbsEnabled;
  $("thumbs-sub").classList.toggle("open", s.thumbsEnabled);
  setPressed($("thumbs-frame"), s.thumbsFrame);
  $("shorts-hidden").checked = s.shortsHidden;
  setPressed($("watched-mode"), s.watchedMode);
}

function save(patch) {
  chrome.storage.sync.set(patch);
  chrome.storage.sync.get(DEFAULTS, render);
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  render(s);
  // Turn on the switch animation only after the first paint.
  requestAnimationFrame(() => document.body.classList.add("ready"));
});

$("thumbs-enabled").addEventListener("change", (e) => save({ thumbsEnabled: e.target.checked }));
$("shorts-hidden").addEventListener("change", (e) => save({ shortsHidden: e.target.checked }));
$("thumbs-frame").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn) save({ thumbsFrame: Number(btn.dataset.value) });
});
$("watched-mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (btn) save({ watchedMode: btn.dataset.value });
});

$("version").textContent = `v${chrome.runtime.getManifest().version}`;

// --- minimal mode, through the active YouTube tab --------------------------

const minimalEl = $("minimal");
let tabId = null;

function minimalUnavailable(text) {
  $("minimal-item").classList.add("off");
  minimalEl.disabled = true;
  $("minimal-hint").textContent = text;
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return minimalUnavailable(t("minimalNoTab"));
  tabId = tab.id;
  chrome.tabs.sendMessage(tabId, { type: "knobs:get" }, (reply) => {
    if (chrome.runtime.lastError || !reply) {
      // Not YouTube, or a YouTube tab opened before the extension was reloaded.
      return minimalUnavailable(t("minimalReload"));
    }
    minimalEl.checked = reply.minimal;
  });
});

minimalEl.addEventListener("change", () => {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "knobs:minimal", on: minimalEl.checked }, () => void chrome.runtime.lastError);
});

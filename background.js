// Starts the local voice (native messaging host) when a YouTube tab turns TR on and stops
// it when the last such tab turns it off or closes. Nothing runs until you press TR.
const HOST = "com.youdub.tts";

let host = null;
let ready = false;
const tabs = new Set(); // ports from bridge.js, one per tab with TR on

function broadcast(message) {
  for (const port of tabs) port.postMessage(message);
}

function startHost() {
  if (host) return;
  ready = false;
  host = chrome.runtime.connectNative(HOST);
  host.onMessage.addListener((message) => {
    if (message.type === "ready") ready = true;
    broadcast(message);
  });
  host.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message;
    host = null;
    ready = false;
    if (tabs.size) broadcast({ type: "error", message: reason ?? "Ses sunucusu kapandı." });
  });
}

function stopHostIfIdle() {
  if (tabs.size || !host) return;
  host.disconnect(); // closes the host's stdin; it exits
  host = null;
  ready = false;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "youdub") return;
  tabs.add(port);
  port.onMessage.addListener((message) => {
    if (message.type !== "start") return;
    if (ready) port.postMessage({ type: "ready" });
    else startHost();
  });
  port.onDisconnect.addListener(() => {
    tabs.delete(port);
    stopHostIfIdle();
  });
});

// Browsers block YouTube pages from reaching 127.0.0.1, so the page's voice requests come
// here through bridge.js. Messages are JSON, so the audio travels base64-encoded.
const VOICE_URL = "http://127.0.0.1:7845";
// Any plain path: the server answers only its own (404 otherwise). A fixed list here meant
// a new server feature stayed blocked until the extension itself was reloaded.
const VOICE_PATH = /^\/[a-z]+$/;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "voice" || !VOICE_PATH.test(message.path ?? "")) return;
  voiceRequest(message).then(sendResponse, () => sendResponse(null));
  return true; // answer asynchronously
});

// Always POST: the browser leaves the Origin header (which the server checks) off a GET.
async function voiceRequest({ path, body, timeout }) {
  const response = await fetch(VOICE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) return null;
  return { data: toBase64(new Uint8Array(await response.arrayBuffer())) };
}

function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

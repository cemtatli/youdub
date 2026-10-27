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

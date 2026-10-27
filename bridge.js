// Relays between dub.js (page world, no extension APIs) and background.js.
// While TR is on, this tab holds a port open; closing the tab closes the port.
let port = null;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "youdub-page") return;
  if (event.data.type === "start") {
    if (!port) {
      port = chrome.runtime.connect({ name: "youdub" });
      port.onMessage.addListener((message) => window.postMessage({ source: "youdub-ext", ...message }, "*"));
      port.onDisconnect.addListener(() => {
        port = null;
      });
    }
    port.postMessage({ type: "start" });
  } else if (event.data.type === "stop") {
    port?.disconnect();
    port = null;
  }
});

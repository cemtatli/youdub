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
  } else if (event.data.type === "font") {
    // The subtitle font, as bytes. Only background.js can read the extension's files in
    // every browser; Chrome refuses them to the page and to this script.
    let request;
    try {
      request = chrome.runtime.sendMessage({ type: "font" });
    } catch {
      request = Promise.resolve(null);
    }
    request
      .catch(() => null)
      .then((reply) => {
        const data = reply && Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0)).buffer;
        window.postMessage({ source: "youdub-ext", type: "font", data }, "*", data ? [data] : []);
      });
  } else if (event.data.type === "voice") {
    // A request for the local voice; background.js makes it (pages can't reach 127.0.0.1).
    const { id, path, body, timeout } = event.data;
    let request;
    try {
      request = chrome.runtime.sendMessage({ type: "voice", path, body, timeout });
    } catch {
      request = Promise.resolve(null); // extension reloaded: this tab needs a refresh
    }
    request
      .catch(() => null)
      .then((reply) => {
        const data = reply && Uint8Array.from(atob(reply.data), (c) => c.charCodeAt(0)).buffer;
        window.postMessage({ source: "youdub-ext", type: "voice", id, data }, "*", data ? [data] : []);
      });
  }
});

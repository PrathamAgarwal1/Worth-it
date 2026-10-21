// Test-only stand-in for the chrome.* extension APIs, so the real extension code can run on a
// normal web page (test/serve.py). Storage persists in localStorage; messages go to the real
// store.js running in-page instead of a service worker.
(function () {
  "use strict";
  const KEY = "wi-mock-storage";
  const listeners = [];
  const read = () => JSON.parse(localStorage.getItem(KEY) || "{}");
  const write = (d) => localStorage.setItem(KEY, JSON.stringify(d));
  const pickKeys = (all, keys) => {
    if (keys == null) return { ...all };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, structuredClone(all[k])]));
  };
  const notify = (changes) => listeners.forEach((fn) => fn(changes, "local"));
  const asyncify = (fn) => (...args) => {
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const p = Promise.resolve().then(() => fn(...args));
    if (cb) p.then(cb);
    return p;
  };

  const local = {
    get: asyncify((keys) => pickKeys(read(), keys)),
    set: asyncify((obj) => {
      const all = read(), changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: all[k], newValue: v };
        all[k] = v;
      }
      write(all);
      notify(changes);
    }),
    clear: asyncify(() => write({})),
  };

  let handlers = null;
  function getHandlers() {
    if (handlers) return handlers;
    const S = globalThis.WorthItStore;
    // Deterministic fake thumbnail arousal per video id (no cross-origin pixels in tests).
    const fakeArousal = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 7) / 1000;
    handlers = {
      context: () => S.context(), thumb: (m) => fakeArousal(m.id), impressions: (m) => S.recordImpressions(m.items),
      watchStart: (m) => S.watchStart(m), watchEnd: (m) => S.watchEnd(m.watch), rate: (m) => S.rate(m),
      dismiss: (m) => S.dismiss(m), skip: (m) => S.skip(m), later: (m) => S.later(m), pendingRating: () => S.pendingRating(), reset: () => S.reset(), loadDemo: () => S.loadDemo(),
    };
    return handlers;
  }

  window.chrome = {
    storage: { local, onChanged: { addListener: (fn) => listeners.push(fn) } },
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        const h = getHandlers()[msg.type];
        Promise.resolve()
          .then(() => globalThis.WorthItStore.init())
          .then(() => (h ? h(msg) : undefined))
          .then((result) => cb && cb({ ok: true, result }), (e) => cb && cb({ ok: false, error: String(e) }));
      },
      openOptionsPage: () => (location.href = "/report/report.html"),
    },
  };
  window.__wiLog = [];
  const orig = window.chrome.runtime.sendMessage;
  window.chrome.runtime.sendMessage = (msg, cb) => {
    window.__wiLog.push(msg.type);
    return orig(msg, cb);
  };
})();

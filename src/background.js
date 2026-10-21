/*
 * Background service worker: the single writer for storage, and the thumbnail analyser
 * (content scripts can't read cross-origin image pixels; the worker can, via host permission).
 */
importScripts("hooks.js", "model.js", "demo.js", "store.js");

const S = globalThis.WorthItStore;
chrome.runtime.onInstalled.addListener(() => S.init());
chrome.runtime.onStartup.addListener(() => S.init());

// ---- Thumbnail arousal ------------------------------------------------------------------
const thumbMemo = new Map();
let active = 0;
const waiting = [];

async function analyseThumb(id) {
  if (thumbMemo.has(id)) return thumbMemo.get(id);
  const { thumbs = {} } = await chrome.storage.local.get("thumbs");
  if (id in thumbs) {
    thumbMemo.set(id, thumbs[id]);
    return thumbs[id];
  }
  if (active >= 4) await new Promise((r) => waiting.push(r));   // at most 4 fetches at once
  active++;
  try {
    const res = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { resizeWidth: 64, resizeHeight: 36 });
    const canvas = new OffscreenCanvas(64, 36);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const arousal = WorthIt.thumbnailArousal(ctx.getImageData(0, 0, 64, 36).data);
    thumbMemo.set(id, arousal);
    S.cacheThumb(id, arousal);
    return arousal;
  } catch (e) {
    return null;
  } finally {
    active--;
    if (waiting.length) waiting.shift()();
  }
}

// ---- Messages from content script / popup / report -------------------------------------
const handlers = {
  context: () => S.context(),
  thumb: (m) => analyseThumb(m.id),
  impressions: (m) => S.recordImpressions(m.items),
  watchStart: (m) => S.watchStart(m),
  watchEnd: (m) => S.watchEnd(m.watch),
  rate: (m) => S.rate(m),
  dismiss: (m) => S.dismiss(m),
  later: (m) => S.later(m),
  pendingRating: () => S.pendingRating(),
  reset: () => S.reset(),
  loadDemo: () => S.loadDemo(),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => S.init().then(() => h(msg)))
    .then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: String(e) }));
  return true; // async reply
});

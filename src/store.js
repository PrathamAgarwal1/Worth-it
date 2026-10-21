/*
 * Storage (background service worker only). Everything stays in chrome.storage.local on this
 * computer. All writes go through `serial`, so concurrent YouTube tabs can't clobber each other.
 */
(function (root) {
  "use strict";
  const W = root.WorthIt;
  const SESSION_GAP_MS = 30 * 60 * 1000;
  const MAX_WATCHES = 2000;
  const MAX_THUMBS = 3000;
  const MIN_WATCH_SEC = 15;
  const DEPTH_BUCKETS = ["1", "2–4", "5–9", "10–19", "20+"];

  const DEFAULT_SETTINGS = { blur: true, badges: true, askRating: true, askMode: "sometimes", lambda: 1 };

  const cell = () => ({ shown: 0, clicked: 0, watched: 0, rated: 0, ratingSum: 0, worth: 0 });
  function freshStats() {
    return {
      hooks: Object.fromEntries(W.HOOK_IDS.map((h) => [h, cell()])),
      none: cell(),                                   // videos with no hook at all
      hours: Array.from({ length: 24 }, cell),
      depth: Object.fromEntries(DEPTH_BUCKETS.map((b) => [b, cell()])),
      moods: {},
    };
  }
  const depthBucket = (d) => (d <= 1 ? "1" : d <= 4 ? "2–4" : d <= 9 ? "5–9" : d <= 19 ? "10–19" : "20+");

  const local = chrome.storage.local;
  let queue = Promise.resolve();
  /** Run fn(state) -> result with exclusive access; fn may mutate state, which is then saved. */
  function serial(keys, fn) {
    const run = queue.then(async () => {
      const state = await local.get(keys);
      const result = await fn(state);
      await local.set(state);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Fill in missing keys once per worker lifetime (queued like any other write). */
  let ready = null;
  function init() {
    ready = ready || serial(["settings", "model", "stats", "watches", "session", "thumbs"], (s) => {
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
      s.model = s.model || W.freshModel();
      s.stats = s.stats || freshStats();
      s.watches = s.watches || [];
      s.session = s.session || { lastTs: 0, depth: 0 };
      s.thumbs = s.thumbs || {};
    });
    return ready;
  }

  function cellsFor(stats, hooks, hour, depth) {
    const cells = hooks.length ? hooks.map((h) => stats.hooks[h]) : [stats.none];
    cells.push(stats.hours[hour], stats.depth[depthBucket(depth)]);
    return cells;
  }

  /** items: [{id, hooks, clicked, ts, depth}] — videos that were on screen, and whether you clicked. */
  function recordImpressions(items) {
    return serial(["model", "stats"], (st) => {
      for (const it of items) {
        const d = new Date(it.ts);
        const ctx = { lateNight: W.isLateNight(d), depth: it.depth || 0 };
        W.update(st.model, "want", W.features(it.hooks, ctx), it.clicked ? 1 : 0, { channel: it.channel });
        for (const c of cellsFor(st.stats, it.hooks, d.getHours(), it.depth || 0)) {
          c.shown++;
          if (it.clicked) c.clicked++;
        }
      }
    });
  }

  /** Weak liking signal from how much you watched, for videos you didn't rate (see W.implicitDecision). */
  function settleImplicit(model, w, now) {
    if (w.learned || w.rating != null) return;
    const d = W.implicitDecision(w, now);
    if (d.action === "wait") return;
    w.learned = true;
    if (d.action === "learn") {
      W.update(model, "like", W.features(w.hooks, { lateNight: w.lateNight, depth: w.depth }), d.y,
               { channel: w.channel, weight: 0.5 });
    }
  }

  /** An unfinished, unrated viewing of this video you could be coming back to. */
  function findOpen(watches, id, now) {
    for (let i = watches.length - 1; i >= 0; i--) {
      const x = watches[i];
      if (x.id === id && x.rating == null && !x.learned && now - (x.lastTs || x.ts) < W.RESUME_DAYS * W.DAY_MS) return i;
    }
    return -1;
  }

  /**
   * Called when a watch page opens: advances the session counter and returns the context. If you're
   * returning to a video you didn't finish, the same viewing continues (resume: its key and time so far).
   */
  function watchStart({ id } = {}) {
    return serial(["session", "watches", "model"], (st) => {
      const now = Date.now();
      for (const w of st.watches) if (now - (w.lastTs || w.ts) > SESSION_GAP_MS) settleImplicit(st.model, w, now);
      const s = st.session;
      s.depth = now - s.lastTs > SESSION_GAP_MS ? 1 : s.depth + 1;
      s.lastTs = now;
      let resume = null;
      const i = id ? findOpen(st.watches, id, now) : -1;
      if (i >= 0) {
        const [w] = st.watches.splice(i, 1);   // move to the end: most recent
        Object.assign(w, { lastTs: now, visits: (w.visits || 1) + 1, later: false, dismissed: false });
        st.watches.push(w);
        resume = { ts: w.ts, watchedSec: w.watchedSec };
      }
      return { depth: s.depth, lateNight: W.isLateNight(new Date(now)), resume };
    });
  }

  async function context() {
    const { session } = await local.get("session");
    const live = session && Date.now() - session.lastTs < SESSION_GAP_MS;
    return { depth: live ? session.depth : 0, lateNight: W.isLateNight(new Date()) };
  }

  /** w: {id, title, channel, hooks, ts, lastTs, depth, watchedSec, durationSec}; ts is the first visit. */
  function watchEnd(w) {
    if (!w || w.watchedSec < MIN_WATCH_SEC) return Promise.resolve(false);
    return serial(["watches", "stats"], (st) => {
      const d = new Date(w.ts);
      const rec = { ...w, lastTs: w.lastTs || w.ts, hour: d.getHours(), lateNight: W.isLateNight(d), rating: null, mood: null };
      const i = st.watches.findIndex((x) => x.id === w.id && x.ts === w.ts);
      if (i >= 0) {
        // Same viewing (checkpoint or a return visit): keep its context, answers and flags.
        const old = st.watches[i];
        st.watches[i] = { ...old, ...rec, hour: old.hour, lateNight: old.lateNight, depth: old.depth,
                          rating: old.rating, mood: old.mood };
      } else {
        st.watches.push(rec);
        for (const c of cellsFor(st.stats, w.hooks, rec.hour, w.depth)) c.watched++;
      }
      if (st.watches.length > MAX_WATCHES) st.watches.splice(0, st.watches.length - MAX_WATCHES);
      return true;
    });
  }

  /** Your answer to "Was that worth it?" — this is the *liking* signal. */
  function rate({ id, ts, rating, mood, partial }) {
    return serial(["watches", "stats", "model"], (st) => {
      const w = st.watches.find((x) => x.id === id && x.ts === ts);
      if (!w || w.rating != null) return false;
      w.rating = rating;
      w.mood = mood || null;
      w.partial = !!partial;   // "got what I needed": worth it without finishing
      w.later = false;
      const worth = rating >= 4 ? 1 : 0;
      const cells = cellsFor(st.stats, w.hooks, w.hour, w.depth);
      if (mood) cells.push((st.stats.moods[mood] = st.stats.moods[mood] || cell()));
      for (const c of cells) {
        c.rated++;
        c.ratingSum += rating;
        c.worth += worth;
      }
      if (!w.learned) {
        W.update(st.model, "like", W.features(w.hooks, { lateNight: w.lateNight, depth: w.depth }), W.ratingTarget(rating),
                 { channel: w.channel });
        w.learned = true;
      }
      return true;
    });
  }

  function dismiss({ id, ts }) {
    return serial(["watches", "model"], (st) => {
      const w = st.watches.find((x) => x.id === id && x.ts === ts);
      if (w && w.rating == null) {
        w.dismissed = true;
        settleImplicit(st.model, w, Date.now());
      }
    });
  }

  /** "I'll finish it later": learn nothing now, don't ask again until you come back and finish. */
  function later({ id, ts }) {
    return serial(["watches"], (st) => {
      const w = st.watches.find((x) => x.id === id && x.ts === ts);
      if (w && w.rating == null) w.later = true;
    });
  }

  /** Most recent unrated, unanswered watch from the last 30 minutes (e.g. you closed the tab mid-video). */
  async function pendingRating() {
    const { watches = [], settings } = await local.get(["watches", "settings"]);
    if (settings && (settings.askRating === false || settings.askMode === "never")) return null;
    for (let i = watches.length - 1; i >= 0; i--) {
      const w = watches[i];
      if (Date.now() - (w.lastTs || w.ts) > SESSION_GAP_MS) continue;
      if (w.rating == null && !w.dismissed && !w.later && !w.learned) return w;
    }
    return null;
  }

  function cacheThumb(id, arousal) {
    return serial(["thumbs"], (st) => {
      st.thumbs[id] = arousal;
      const keys = Object.keys(st.thumbs);
      if (keys.length > MAX_THUMBS) for (const k of keys.slice(0, keys.length - MAX_THUMBS)) delete st.thumbs[k];
    });
  }

  function reset() {
    return serial(["settings"], async (st) => {
      await local.clear();
      st.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
      Object.assign(st, { model: W.freshModel(), stats: freshStats(), watches: [], session: { lastTs: 0, depth: 0 },
                          thumbs: {}, demo: false });
    });
  }

  /** Three weeks of simulated viewing, run through the real learning code, for screenshots. */
  function loadDemo() {
    return serial(["settings"], async (st) => {
      const data = root.WorthItDemo.generate(W, { freshStats, cellsFor, depthBucket });
      await local.clear();
      Object.assign(st, data, { settings: { ...DEFAULT_SETTINGS, ...(st.settings || {}) }, demo: true,
                                session: { lastTs: 0, depth: 0 }, thumbs: {} });
    });
  }

  root.WorthItStore = { init, recordImpressions, watchStart, watchEnd, context, rate, dismiss, later, pendingRating,
                        cacheThumb, reset, loadDemo, DEPTH_BUCKETS, freshStats, cellsFor, depthBucket,
                        DEFAULT_SETTINGS };
})(globalThis);

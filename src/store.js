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
  const CATCH_UP_MS = 10 * 60 * 1000;   // ask about a video you left unasked only this soon after
  const DEPTH_BUCKETS = ["1", "2–4", "5–9", "10–19", "20+"];

  // askMode: "bar" (rate in a bar under the video, no popups), "often" / "sometimes" (bar plus a popup), "never".
  const DEFAULT_SETTINGS = { blur: true, badges: true, askRating: true, askMode: "bar", lambda: 1, barIntro: true };

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
      // The bar under the video replaced popups as the way to rate: switch existing installs over once.
      if (s.settings && !s.settings.barIntro && s.settings.askMode !== "never" && s.settings.askRating !== false) {
        s.settings.askMode = "bar";
      }
      s.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}), barIntro: true };
      s.model = s.model || W.freshModel();
      s.stats = s.stats || freshStats();
      s.watches = s.watches || [];
      s.session = s.session || { lastTs: 0, depth: 0 };
      s.thumbs = s.thumbs || {};
      s.model.overrides = s.model.overrides || { channels: {} };
      if (mergeDuplicates(s) || !s.model.record) W.rebuildRecord(s.model, s.watches);
      else W.refreshRecord(s.model);   // old ratings have faded since last time
    });
    return ready;
  }

  function cellsFor(stats, hooks, hour, depth) {
    const cells = hooks.length ? hooks.map((h) => stats.hooks[h]) : [stats.none];
    cells.push(stats.hours[hour], stats.depth[depthBucket(depth)]);
    return cells;
  }

  /** Add (sign 1) or take back (sign -1) a watch's rating in the running stats. */
  function tallyRating(stats, w, sign) {
    if (w.rating == null) return;
    const cells = cellsFor(stats, w.hooks || [], w.hour, w.depth || 0);
    if (w.mood) cells.push((stats.moods[w.mood] = stats.moods[w.mood] || cell()));
    for (const c of cells) {
      c.rated = Math.max(0, c.rated + sign);
      c.ratingSum = Math.max(0, c.ratingSum + sign * w.rating);
      c.worth = Math.max(0, c.worth + sign * (w.rating >= 4 ? 1 : 0));
    }
  }

  /** The entry for this video (there's one per video), or -1. */
  function findEntry(watches, id) {
    for (let i = watches.length - 1; i >= 0; i--) if (watches[i].id === id) return i;
    return -1;
  }

  /**
   * Older versions saved a new entry each time you watched a video again. Fold those into one entry
   * per video: watch time and visits add up, the latest answer wins, and the stats count it once.
   */
  function mergeDuplicates(st) {
    if (new Set(st.watches.map((w) => w.id)).size === st.watches.length) return false;
    const keep = new Map();   // id -> newest entry
    for (let i = st.watches.length - 1; i >= 0; i--) {
      const w = st.watches[i], k = keep.get(w.id);
      if (!k) {
        keep.set(w.id, w);
        continue;
      }
      for (const c of cellsFor(st.stats, w.hooks || [], w.hour, w.depth || 0)) c.watched = Math.max(0, c.watched - 1);
      tallyRating(st.stats, w, -1);
      if (k.rating == null && w.rating != null) {
        Object.assign(k, { rating: w.rating, mood: w.mood, partial: w.partial });
        tallyRating(st.stats, k, 1);
      }
      k.watchedSec += w.watchedSec;
      k.visits = (k.visits || 1) + (w.visits || 1);
      k.learned = k.learned || w.learned;
    }
    st.watches = st.watches.filter((w) => keep.get(w.id) === w);
    return true;
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

  /**
   * Called when a watch page opens: advances the session counter and returns the context. If you've
   * watched this video before, it continues the same entry (resume: its key, time so far, and your
   * last answer), so watching again never adds a second entry.
   */
  function watchStart({ id } = {}) {
    return serial(["session", "watches", "model"], (st) => {
      const now = Date.now();
      for (const w of st.watches) if (now - (w.lastTs || w.ts) > SESSION_GAP_MS) settleImplicit(st.model, w, now);
      W.refreshRecord(st.model, now);
      const s = st.session;
      s.depth = now - s.lastTs > SESSION_GAP_MS ? 1 : s.depth + 1;
      s.lastTs = now;
      let resume = null;
      const i = id ? findEntry(st.watches, id) : -1;
      if (i >= 0) {
        const [w] = st.watches.splice(i, 1);   // move to the end: most recent
        // Coming back to a video you'd already finished is a rewatch: a strong sign you liked it.
        const finished = w.durationSec > 0 && w.watchedSec >= 0.7 * w.durationSec;
        Object.assign(w, { lastTs: now, visits: (w.visits || 1) + 1, later: false, dismissed: false, skipped: false,
                           endTs: null, rewatch: finished ? { fromSec: w.watchedSec, counted: false } : null });
        st.watches.push(w);
        resume = { ts: w.ts, watchedSec: w.watchedSec, rating: w.rating, partial: !!w.partial, mood: w.mood || null };
      }
      return { depth: s.depth, lateNight: W.isLateNight(new Date(now)), resume };
    });
  }

  async function context() {
    const { session } = await local.get("session");
    const live = session && Date.now() - session.lastTs < SESSION_GAP_MS;
    return { depth: live ? session.depth : 0, lateNight: W.isLateNight(new Date()) };
  }

  /**
   * w: {id, title, channel, hooks, ts, lastTs, depth, watchedSec, durationSec, ended}; ts is the first visit.
   * ended is false for a checkpoint while the video is still playing, true once you've left it.
   */
  function watchEnd(w) {
    if (!w || w.watchedSec < MIN_WATCH_SEC) return Promise.resolve(false);
    return serial(["watches", "stats", "model"], (st) => saveWatch(st, w));
  }

  const REWATCH_SEC = 60;   // watching a finished video again for this long counts as a rewatch

  /** Add or update this video's entry (needs st.watches and st.stats). */
  function saveWatch(st, w) {
    const d = new Date(w.ts);
    const { ended, ...rest } = w;
    const rec = { ...rest, lastTs: w.lastTs || w.ts, hour: d.getHours(), lateNight: W.isLateNight(d), rating: null, mood: null,
                  endTs: ended ? Date.now() : null };
    const i = findEntry(st.watches, w.id);
    if (i >= 0) {
      // Same video (checkpoint or a return visit): keep its key, context, answers and flags. If the
      // tab didn't get the time so far (watchStart failed), never let the total go down.
      const old = st.watches[i];
      const watchedSec = old.ts === w.ts ? w.watchedSec : Math.max(old.watchedSec, w.watchedSec);
      st.watches[i] = { ...old, ...rec, ts: old.ts, hour: old.hour, lateNight: old.lateNight, depth: old.depth,
                        rating: old.rating, mood: old.mood, watchedSec };
    } else {
      st.watches.push(rec);
      for (const c of cellsFor(st.stats, w.hooks, rec.hour, w.depth)) c.watched++;
    }
    const e = st.watches[findEntry(st.watches, w.id)];
    if (st.model && e.rewatch && !e.rewatch.counted && e.watchedSec - e.rewatch.fromSec >= REWATCH_SEC) {
      e.rewatch.counted = true;
      e.rewatches = (e.rewatches || 0) + 1;
      W.update(st.model, "like", W.features(e.hooks, { lateNight: e.lateNight, depth: e.depth }), 0.9,
               { channel: e.channel, weight: 0.7 });
    }
    if (st.watches.length > MAX_WATCHES) st.watches.splice(0, st.watches.length - MAX_WATCHES);
    return true;
  }

  const entry = (watches, id) => watches[findEntry(watches, id)];

  /**
   * Your answer to "Was that worth it?" — this is the *liking* signal. Rating a video again replaces
   * your earlier answer; the model only learns again if your opinion changed. watch: the video as it
   * stands, for rating it from the bar under the player before it's been saved.
   */
  function rate({ id, rating, mood, partial, watch }) {
    return serial(["watches", "stats", "model"], (st) => {
      if (watch && findEntry(st.watches, id) < 0) saveWatch(st, { ...watch, ended: false });
      const w = entry(st.watches, id);
      if (!w) return false;
      const before = w.rating;
      tallyRating(st.stats, w, -1);
      w.rating = rating;
      w.mood = mood || null;
      w.partial = !!partial;   // "got what I needed": worth it without finishing
      w.later = false;
      w.ratedTs = Date.now();
      tallyRating(st.stats, w, 1);
      W.recordRating(st.model, w, before, rating, w.ratedTs);   // the track record behind junk-food verdicts
      if (before == null || W.ratingTarget(before) !== W.ratingTarget(rating)) {
        W.update(st.model, "like", W.features(w.hooks, { lateNight: w.lateNight, depth: w.depth }), W.ratingTarget(rating),
                 { channel: w.channel });
        w.learned = true;
      }
      return true;
    });
  }

  function dismiss({ id }) {
    return serial(["watches", "model"], (st) => {
      const w = entry(st.watches, id);
      if (w && w.rating == null) {
        w.dismissed = true;
        settleImplicit(st.model, w, Date.now());
      }
    });
  }

  /**
   * A bounce: you opened a video and left within seconds. A small "not worth it" for the liking model
   * only (never the track record, which is only your ratings), unless you've rated it.
   */
  function bounce({ watch: v }) {
    if (!v) return Promise.resolve(false);
    return serial(["watches", "model"], (st) => {
      const e = entry(st.watches, v.id);
      if (e && (e.rating != null || e.learned)) return false;
      W.update(st.model, "like", W.features(v.hooks || [], { lateNight: W.isLateNight(new Date(v.ts)), depth: v.depth || 0 }), 0.2,
               { channel: v.channel, weight: 0.3 });
      if (e) e.learned = true;   // already learned from: no early-exit lesson on top later
      return true;
    });
  }

  /** Your own call on a channel: "never" (not junk for me), "always" (always flag), or null (let it decide). */
  function override({ channel, value }) {
    return serial(["model"], (st) => W.setOverride(st.model, channel, value));
  }

  /** Not asked about (e.g. "Sometimes" mode): don't bring it up later. Learns from watch time as usual. */
  function skip({ id }) {
    return serial(["watches"], (st) => {
      const w = entry(st.watches, id);
      if (w && w.rating == null) w.skipped = true;
    });
  }

  /** "I'll finish it later": learn nothing now, don't ask again until you come back and finish. */
  function later({ id, watch }) {
    return serial(["watches", "stats"], (st) => {
      if (watch && findEntry(st.watches, id) < 0) saveWatch(st, { ...watch, ended: false });
      const w = entry(st.watches, id);
      if (w && w.rating == null) w.later = true;
    });
  }

  /**
   * A video you left in the last few minutes and were never asked about (e.g. you closed its tab).
   * Videos still playing, in this tab or another, aren't finished, so they're never returned.
   */
  async function pendingRating() {
    const { watches = [], settings } = await local.get(["watches", "settings"]);
    if (settings && (settings.askRating === false || settings.askMode === "never")) return null;
    const now = Date.now();
    for (let i = watches.length - 1; i >= 0; i--) {
      const w = watches[i];
      if (!w.endTs || now - w.endTs > CATCH_UP_MS) continue;
      if (w.rating == null && !w.dismissed && !w.skipped && !w.later && !w.learned) return w;
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

  root.WorthItStore = { init, recordImpressions, watchStart, watchEnd, context, rate, dismiss, skip, later, pendingRating, bounce, override,
                        cacheThumb, reset, loadDemo, __resetForTest: () => (ready = null), DEPTH_BUCKETS, freshStats, cellsFor, depthBucket,
                        DEFAULT_SETTINGS };
})(globalThis);

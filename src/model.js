/*
 * Personal wanting-vs-liking model.
 *
 * Two tiny logistic regressions over the same features (hooks + your current state):
 *   want: P(you click | the video was on your screen)          <- learned from impressions
 *   like: P(you're glad you watched | you watched it)           <- learned from your 1–5 ratings,
 *                                                                  and more weakly from how much you watched
 * plus a per-channel offset on each, so "curiosity gaps from this channel pay off for you" can
 * differ from "curiosity gaps in general". Packaging is not the whole story; track record is.
 *
 * Both start from research-informed priors (hooks pull harder but pay off less; late night and
 * long sessions make it worse) and drift toward *your* behaviour as data comes in. L2 pulls the
 * weights back toward the prior (and channel offsets toward 0), so a handful of ratings can't
 * swing things wildly.
 *
 * Ranking follows the KuaiRand study in this repo:
 *   gap   = max(0, want lift - like lift)      (log-odds; how much more it pulls than it pays)
 *   score = like logit - λ · gap
 *
 * Verdicts (junk food, risky, worth it) come from your *track record* instead: how you actually rated
 * each channel and each hook, kept as counts of "worth it" vs "not worth it" ratings. A group is only
 * judged when the evidence is confident (a Beta posterior: e.g. at least 85% sure that under half of
 * that channel's videos are worth it to you), and a verdict only changes when the evidence clearly
 * moves (separate thresholds to enter and to leave a level). Older ratings count less (they fade with
 * a 90-day half-life), so a channel that changed gets re-judged. Your rating of a video always wins
 * for that video, then your own call on a channel ("not junk" / "always flag"). Long videos you'd
 * likely regret are judged more strictly than short ones.
 */
(function (root) {
  "use strict";
  const H = root.WorthIt || (typeof require !== "undefined" ? require("./hooks.js") : {});

  const STATE_FEATURES = ["late_night", "deep_session"];
  const FEATURES = [...H.HOOK_IDS, ...STATE_FEATURES];
  const DEEP_SESSION = 10;      // videos in the current session

  // Track record. Each group (a channel, or a hook) starts from Beta(2, 2): "no idea, about half".
  const TRACK_PRIOR = 2;
  // How sure it must be that under half of a group's videos are worth it to you, to enter a level,
  // and how far that can fall before it leaves it again (so one rating doesn't flip it back and forth).
  // With these, 2 bad ratings of a channel make it risky, 3 of 3 or 4 of 5 make it junk food.
  const LEVELS = {
    junk: { enter: 0.85, exit: 0.75 },
    risky: { enter: 0.7, exit: 0.6 },
    good: { enter: 0.85, exit: 0.75 },   // sure that *over* half are worth it
  };
  const LONG_REGRET_MIN = 30;   // a risky video you'd likely regret this many minutes of counts as junk food
  const SHORT_REGRET_MIN = 2;   // junk food this short is only risky (unless you rated it yourself)
  const MAX_RATED_VIDEOS = 3000;
  const HALF_LIFE_DAYS = 90;    // a rating this old counts half as much as one from today

  const PRIOR = {
    want: { bias: -2.0, curiosity_gap: 0.5, outrage: 0.4, fear: 0.35, urgency: 0.3, social_proof: 0.2,
            hype: 0.35, shouting: 0.25, loud_thumbnail: 0.3, late_night: 0.2, deep_session: 0.1 },
    like: { bias: 0.6, curiosity_gap: -0.5, outrage: -0.5, fear: -0.35, urgency: -0.3, social_proof: -0.15,
            hype: -0.3, shouting: -0.25, loud_thumbnail: -0.2, late_night: -0.3, deep_session: -0.35 },
  };
  const LR = { want: 0.03, like: 0.15 };
  const L2 = { want: 0.002, like: 0.02 };
  const LR_CHANNEL = { want: 0.05, like: 0.35 };
  const L2_CHANNEL = { want: 0.01, like: 0.03 };
  const MAX_CHANNELS = 1500;

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const channelKey = (name) => (name || "").trim().toLowerCase();

  function isLateNight(date) {
    const h = date.getHours();
    return h >= 23 || h < 5;
  }

  /** Feature dict for one video in one context. */
  function features(hooks, ctx) {
    const x = {};
    for (const f of FEATURES) x[f] = 0;
    for (const h of hooks) if (h in x) x[h] = 1;
    x.late_night = ctx && ctx.lateNight ? 1 : 0;
    x.deep_session = ctx && ctx.depth >= DEEP_SESSION ? 1 : 0;
    return x;
  }

  function freshModel() {
    return { want: { ...PRIOR.want }, like: { ...PRIOR.like }, nWant: 0, nLike: 0, channels: {}, record: freshRecord(),
             overrides: { channels: {} } };
  }

  /** Linear part without the bias: how much this video's cues shift you vs. your average. */
  function lift(w, x) {
    let z = 0;
    for (const f of FEATURES) z += (w[f] || 0) * x[f];
    return z;
  }

  function channelOf(model, name, create) {
    const key = channelKey(name);
    if (!key) return null;
    model.channels = model.channels || {};
    if (!model.channels[key] && create) {
      const keys = Object.keys(model.channels);
      if (keys.length >= MAX_CHANNELS) delete model.channels[keys[0]];   // forget the oldest
      model.channels[key] = { name: name.trim(), want: 0, like: 0, nWant: 0, nLike: 0 };
    }
    return model.channels[key] || null;
  }

  /**
   * One SGD step on head ("want" | "like") toward target y in [0, 1].
   * opts.channel: channel name (learns its offset too); opts.weight: <1 for weaker evidence.
   */
  function update(model, head, x, y, opts = {}) {
    const w = model[head], prior = PRIOR[head];
    const ch = channelOf(model, opts.channel, true);
    const weight = opts.weight == null ? 1 : opts.weight;
    const p = sigmoid(w.bias + lift(w, x) + (ch ? ch[head] : 0));
    const g = (p - y) * weight;
    w.bias -= LR[head] * (g + L2[head] * (w.bias - prior.bias));
    for (const f of FEATURES) {
      w[f] -= LR[head] * (g * x[f] + L2[head] * (w[f] - prior[f]));
    }
    if (ch) {
      ch[head] -= LR_CHANNEL[head] * (g + L2_CHANNEL[head] * ch[head]);
      ch[head === "want" ? "nWant" : "nLike"]++;
    }
    model[head === "want" ? "nWant" : "nLike"]++;
  }

  /** Map a 1–5 rating to a soft "glad I watched" target. Worth it means 4–5; "OK" (3) mostly isn't. */
  const ratingTarget = (r) => [0, 0, 0.05, 0.3, 0.9, 1][r] ?? 0.5;

  /**
   * How much of an unrated video you watched, as a weak liking signal: finishing most of it
   * suggests you liked it, bailing out early suggests you didn't. Returns null when unclear.
   */
  function implicitTarget(watchedSec, durationSec) {
    if (!durationSec || durationSec < 30) return null;
    const f = Math.min(1, watchedSec / durationSec);
    if (f >= 0.7) return 0.8;
    if (f < 0.2 && watchedSec < 180) return 0.25;
    return null;
  }

  const DAY_MS = 86400000;
  const RESUME_DAYS = 14;        // reopening an unfinished video within this window continues the same viewing
  const EARLY_EXIT_GRACE_DAYS = 3;   // an early exit only counts against a video if you don't come back

  /**
   * What to learn from an unrated viewing, given how it ended:
   *   {action: "learn", y}  learn y now (half weight)
   *   {action: "wait"}      not yet: you might still come back to it
   *   {action: "drop"}      nothing to learn; settle it
   * Finishing most of a video counts at once. Leaving early only counts after a few days without a
   * return, so "I'll watch the rest later" is never held against a video. "Finishing later" is never
   * a negative at all.
   */
  function implicitDecision(w, now) {
    const idle = now - (w.lastTs || w.ts);
    if (w.later) return idle > RESUME_DAYS * DAY_MS ? { action: "drop" } : { action: "wait" };
    const y = implicitTarget(w.watchedSec, w.durationSec);
    if (y == null) return { action: "drop" };
    if (y > 0.5) return { action: "learn", y };
    return idle >= EARLY_EXIT_GRACE_DAYS * DAY_MS ? { action: "learn", y } : { action: "wait" };
  }

  // ---- Track record -----------------------------------------------------------------------
  const freshRecord = () => ({ channels: {}, hooks: {}, videos: {} });
  // good/bad: fading weights (as of time t); n/pos/neg: plain counts of your ratings, for explanations.
  const freshGroup = () => ({ good: 0, bad: 0, n: 0, pos: 0, neg: 0, level: "none", t: null });

  /** How much a rating made at `from` still counts at `to`. */
  const fade = (from, to) => Math.pow(0.5, Math.max(0, to - from) / (HALF_LIFE_DAYS * DAY_MS));
  /** Bring a group's weights forward to time `at`. */
  function age(g, at) {
    if (g.t != null && at > g.t) {
      const f = fade(g.t, at);
      g.good *= f;
      g.bad *= f;
    }
    g.t = Math.max(g.t || 0, at);
  }
  const ratingOf = (v) => (v != null && typeof v === "object" ? v.r : v);

  // log Γ(z) (Lanczos), for the Beta distribution below.
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
                   12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = LANCZOS[0];
    for (let i = 1; i < 9; i++) x += LANCZOS[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }
  /** P(θ < x) for θ ~ Beta(a, b), a, b ≥ 1 (Simpson's rule; plenty accurate for a verdict). */
  function betaCdf(x, a, b) {
    const lB = lgamma(a) + lgamma(b) - lgamma(a + b);
    const f = (t) => (t <= 0 ? (a > 1 ? 0 : Math.exp(-lB)) : Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t) - lB));
    const n = 200, h = x / n;
    let sum = f(0) + f(x);
    for (let i = 1; i < n; i++) sum += f(i * h) * (i % 2 ? 4 : 2);
    return Math.min(1, Math.max(0, (sum * h) / 3));
  }
  /** How sure we are that under half of this group's videos are worth it to you. */
  const badChance = (g) => betaCdf(0.5, TRACK_PRIOR + g.good, TRACK_PRIOR + g.bad);

  /** The group's level, given the one it had: entering a level takes more evidence than staying in it. */
  function nextLevel(prev, g) {
    const p = badChance(g);
    const has = (lvl) => prev === lvl || (lvl === "risky" && prev === "junk");
    if (p >= (prev === "junk" ? LEVELS.junk.exit : LEVELS.junk.enter)) return "junk";
    if (p >= (has("risky") ? LEVELS.risky.exit : LEVELS.risky.enter)) return "risky";
    if (1 - p >= (prev === "good" ? LEVELS.good.exit : LEVELS.good.enter)) return "good";
    return "none";
  }

  function groupsOf(model, w, create) {
    const r = (model.record = model.record || freshRecord());
    const out = [];
    const key = channelKey(w.channel);
    if (key) {
      if (!r.channels[key] && create) r.channels[key] = { name: w.channel.trim(), ...freshGroup() };
      if (r.channels[key]) out.push(r.channels[key]);
    }
    for (const h of w.hooks || []) {
      if (!r.hooks[h] && create) r.hooks[h] = freshGroup();
      if (r.hooks[h]) out.push(r.hooks[h]);
    }
    return out;
  }

  /**
   * Your rating of video w changed from `before` to `after` (either may be null) at time `at`: update
   * the track record of its channel and hooks, then their levels, once, so a change of mind can't
   * flip-flop them. The earlier rating is taken back at the weight it has faded to.
   */
  function recordRating(model, w, before, after, at = Date.now()) {
    const groups = groupsOf(model, w, after != null);
    const prev = model.record.videos[w.id];
    const prevWeight = prev != null && typeof prev === "object" ? fade(prev.t, at) : 1;
    const add = (g, rating, sign, weight) => {
      if (rating == null) return;
      const t = ratingTarget(rating);
      g.good = Math.max(0, g.good + sign * weight * t);
      g.bad = Math.max(0, g.bad + sign * weight * (1 - t));
      g.n = Math.max(0, g.n + sign);
      if (rating >= 4) g.pos = Math.max(0, g.pos + sign);
      else g.neg = Math.max(0, g.neg + sign);
    };
    for (const g of groups) {
      age(g, at);
      add(g, before, -1, prevWeight);
      add(g, after, 1, 1);
      g.level = nextLevel(g.level, g);
    }
    const videos = model.record.videos;
    delete videos[w.id];
    if (after != null) {
      videos[w.id] = { r: after, t: at };   // re-added at the end: the oldest are forgotten first
      const ids = Object.keys(videos);
      if (ids.length > MAX_RATED_VIDEOS) for (const id of ids.slice(0, ids.length - MAX_RATED_VIDEOS)) delete videos[id];
    }
  }

  /** Let every group's evidence fade up to now, and re-judge it (old verdicts expire on their own). */
  function refreshRecord(model, now = Date.now()) {
    const r = model.record;
    if (!r) return;
    for (const g of [...Object.values(r.channels), ...Object.values(r.hooks)]) {
      age(g, now);
      g.level = nextLevel(g.level, g);
    }
  }

  /** When a watch was rated: the rating time if saved, else its last visit. */
  const ratedAt = (w) => w.ratedTs || w.lastTs || w.ts || Date.now();

  /** Rebuild the track record from your rated watches (older saved data, demo data, merged entries). */
  function rebuildRecord(model, watches, now = Date.now()) {
    model.record = freshRecord();
    const rated = watches.filter((w) => w.rating != null).sort((a, b) => ratedAt(a) - ratedAt(b));
    for (const w of rated) recordRating(model, w, null, w.rating, ratedAt(w));
    refreshRecord(model, now);
  }

  /** Your own call on a channel: "never" (not junk for me), "always" (always flag), or null to let it decide. */
  function setOverride(model, channel, value) {
    const key = channelKey(channel);
    if (!key) return;
    model.overrides = model.overrides || { channels: {} };
    if (value === "never" || value === "always") model.overrides.channels[key] = { value, name: channel.trim() };
    else delete model.overrides.channels[key];
  }
  const overrideOf = (model, channel) => {
    const o = model.overrides && model.overrides.channels[channelKey(channel)];
    return o ? o.value : null;
  };

  /**
   * The verdict on one video, and what it's based on:
   *   level: "junk" | "risky" | "good" | "none"
   *   basis: {kind: "you", rating} | {kind: "channel", ...group} | {kind: "hook", hook, ...group} | null
   */
  function verdict(model, { id, hooks = [], channel, durationSec, worthIt }) {
    const r = model.record || freshRecord();
    const regretMin = durationSec > 0 ? (durationSec / 60) * (1 - worthIt) : null;
    const mine = id != null ? ratingOf(r.videos[id]) : undefined;
    // 1. Your own rating of this very video always wins.
    if (mine != null && mine !== 3) return { level: mine <= 2 ? "junk" : "good", basis: { kind: "you", rating: mine }, regretMin };
    // 2. Then your own call on the channel.
    const ov = overrideOf(model, channel);
    if (ov) return { level: ov === "always" ? "junk" : "none", basis: { kind: "override", value: ov }, regretMin };
    // 3. The channel's track record, if it has one.
    const ch = r.channels[channelKey(channel)];
    let level = "none", basis = null, capped = false;
    if (ch && ch.level !== "none") {
      level = ch.level;
      basis = { kind: "channel", ...ch };
    } else {
      // 4. Otherwise the worst hook's track record, across all the channels you've rated it on.
      const order = { junk: 2, risky: 1 };
      for (const h of hooks) {
        const g = r.hooks[h];
        if (g && order[g.level] && (!basis || order[g.level] > order[level])) {
          level = g.level;
          basis = { kind: "hook", hook: h, ...g };
        }
      }
      // A hook alone doesn't blur a channel you've enjoyed before.
      if (level === "junk" && ch && ch.pos > 0) {
        level = "risky";
        capped = true;
      }
    }
    // 5. Minutes matter: a long video you'd likely regret is junk food; a tiny one is only risky.
    let long = false, short = false;
    if (level === "risky" && regretMin != null && regretMin >= LONG_REGRET_MIN) {
      level = "junk";
      long = true;
    } else if (level === "junk" && regretMin != null && regretMin < SHORT_REGRET_MIN) {
      level = "risky";
      short = true;
    }
    return { level, basis, regretMin, long, short, capped };
  }

  /**
   * Everything the UI needs to show about one video. video: {id, durationSec} for the verdict, when
   * known (your own rating of it, and how many minutes it would cost you).
   */
  function score(model, hooks, ctx, lambda, channel, video = {}) {
    const x = features(hooks, ctx);
    const ch = channelOf(model, channel, false);
    const wantLift = lift(model.want, x) + (ch ? ch.want : 0);
    const likeLift = lift(model.like, x) + (ch ? ch.like : 0);
    const likeLogit = model.like.bias + likeLift;
    const gap = Math.max(0, wantLift - likeLift);
    const worthIt = sigmoid(likeLogit);
    const v = verdict(model, { id: video.id, hooks, channel, durationSec: video.durationSec, worthIt });
    return {
      pWant: sigmoid(model.want.bias + wantLift),
      pull: Math.exp(wantLift),                 // × your usual click odds
      worthIt,                                  // chance you'll be glad you watched
      gap,
      ...v,
      junk: v.level === "junk",
      risky: v.level === "risky",
      good: v.level === "good",
      rank: likeLogit - (lambda == null ? 1 : lambda) * gap,
    };
  }

  const api = { FEATURES, PRIOR, DEEP_SESSION, LEVELS, LONG_REGRET_MIN, SHORT_REGRET_MIN, sigmoid, isLateNight, features,
                freshModel, lift, update, ratingTarget, implicitTarget, implicitDecision, score, channelKey,
                betaCdf, badChance, nextLevel, recordRating, rebuildRecord, refreshRecord, verdict, setOverride, overrideOf,
                fade, HALF_LIFE_DAYS,
                RESUME_DAYS, EARLY_EXIT_GRACE_DAYS, DAY_MS };
  root.WorthIt = Object.assign(root.WorthIt || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = { ...H, ...api };
})(typeof globalThis !== "undefined" ? globalThis : this);

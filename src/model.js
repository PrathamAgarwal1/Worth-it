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
 * A video is only called junk food with *evidence*: your own ratings of this channel or of these
 * hooks. Before that, hooks are shown as information, not as a verdict.
 */
(function (root) {
  "use strict";
  const H = root.WorthIt || (typeof require !== "undefined" ? require("./hooks.js") : {});

  const STATE_FEATURES = ["late_night", "deep_session"];
  const FEATURES = [...H.HOOK_IDS, ...STATE_FEATURES];
  const DEEP_SESSION = 10;      // videos in the current session
  const JUNK_GAP = 0.6;         // log-odds gap above which a hooked video counts as junk food
  const WORTH_OK = 0.6;         // at or above this chance of enjoying it, a video is never junk food
  const EVIDENCE = { channel: 2, hook: 5 };   // ratings needed before the model will call something junk

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
    return { want: { ...PRIOR.want }, like: { ...PRIOR.like }, nWant: 0, nLike: 0, channels: {}, hookRated: {} };
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
    if (head === "like") {
      model.hookRated = model.hookRated || {};
      for (const h of H.HOOK_IDS) if (x[h]) model.hookRated[h] = (model.hookRated[h] || 0) + 1;
    }
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

  /** What personal evidence backs a verdict on this video. */
  function evidence(model, hooks, channel) {
    const ch = channelOf(model, channel, false);
    const chRated = ch ? ch.nLike : 0;
    const hookRated = Math.max(0, ...hooks.map((h) => (model.hookRated && model.hookRated[h]) || 0));
    return { channelRated: chRated, hookRated, enough: chRated >= EVIDENCE.channel || hookRated >= EVIDENCE.hook };
  }

  /** Everything the UI needs to show about one video. */
  function score(model, hooks, ctx, lambda, channel) {
    const x = features(hooks, ctx);
    const ch = channelOf(model, channel, false);
    const wantLift = lift(model.want, x) + (ch ? ch.want : 0);
    const likeLift = lift(model.like, x) + (ch ? ch.like : 0);
    const likeLogit = model.like.bias + likeLift;
    const gap = Math.max(0, wantLift - likeLift);
    const ev = evidence(model, hooks, channel);
    return {
      pWant: sigmoid(model.want.bias + wantLift),
      pull: Math.exp(wantLift),                 // × your usual click odds
      worthIt: sigmoid(likeLogit),              // chance you'll be glad you watched
      gap,
      evidence: ev,
      junk: hooks.length > 0 && gap >= JUNK_GAP && ev.enough && sigmoid(likeLogit) < WORTH_OK,
      rank: likeLogit - (lambda == null ? 1 : lambda) * gap,
    };
  }

  const api = { FEATURES, PRIOR, DEEP_SESSION, JUNK_GAP, WORTH_OK, EVIDENCE, sigmoid, isLateNight, features, freshModel,
                lift, update, ratingTarget, implicitTarget, implicitDecision, evidence, score, channelKey,
                RESUME_DAYS, EARLY_EXIT_GRACE_DAYS, DAY_MS };
  root.WorthIt = Object.assign(root.WorthIt || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = { ...H, ...api };
})(typeof globalThis !== "undefined" ? globalThis : this);

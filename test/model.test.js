// Run: node --test test/hooks.test.js test/model.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/model.js");

const rateN = (m, hooks, rating, n, channel) => {
  for (let i = 0; i < n; i++) M.update(m, "like", M.features(hooks, {}), M.ratingTarget(rating), { channel });
};

test("priors: hooks lower the expected payoff, but no junk verdict without your own ratings", () => {
  const m = M.freshModel();
  const hooked = M.score(m, ["curiosity_gap", "shouting"], { depth: 1, lateNight: false }, 1);
  const plain = M.score(m, [], { depth: 1, lateNight: false }, 1);
  assert.ok(hooked.pull > 1 && plain.pull === 1);
  assert.ok(plain.worthIt > hooked.worthIt);
  assert.ok(plain.rank > hooked.rank);
  assert.ok(hooked.gap >= M.JUNK_GAP, "the gap is there...");
  assert.equal(hooked.junk, false, "...but it isn't a verdict yet");
  assert.equal(hooked.evidence.enough, false);
});

test("junk food once your ratings back it up", () => {
  const m = M.freshModel();
  rateN(m, ["curiosity_gap"], 1, 6);
  const s = M.score(m, ["curiosity_gap"], {}, 1);
  assert.equal(s.evidence.hookRated, 6);
  assert.equal(s.junk, true);
});

test("channel track record beats packaging: same hook, different channels", () => {
  const m = M.freshModel();
  rateN(m, ["curiosity_gap"], 5, 4, "Curious Science");   // hooky titles, great videos
  rateN(m, ["curiosity_gap"], 1, 4, "Drama Daily");       // hooky titles, regretted
  const good = M.score(m, ["curiosity_gap"], {}, 1, "Curious Science");
  const bad = M.score(m, ["curiosity_gap"], {}, 1, "drama daily");   // channel names are case-insensitive
  assert.ok(good.worthIt > bad.worthIt + 0.2, `good=${good.worthIt} bad=${bad.worthIt}`);
  assert.equal(good.junk, false);
  assert.equal(bad.junk, true);
  assert.equal(bad.evidence.channelRated, 4);
});

test("never junk if you're likely to enjoy it", () => {
  const m = M.freshModel();
  rateN(m, [], 5, 30);                         // you enjoy most things
  rateN(m, ["outrage"], 4, 6);
  const s = M.score(m, ["outrage"], {}, 1);
  assert.ok(s.worthIt >= M.WORTH_OK);
  assert.equal(s.junk, false);
});

test("late night and deep sessions lower the expected payoff", () => {
  const m = M.freshModel();
  const day = M.score(m, [], { depth: 1, lateNight: false }).worthIt;
  const night = M.score(m, [], { depth: 15, lateNight: true }).worthIt;
  assert.ok(night < day);
});

test("λ = 0 ranks by enjoyment only; larger λ buries hooked videos harder", () => {
  const m = M.freshModel();
  const s0 = M.score(m, ["outrage"], {}, 0), s2 = M.score(m, ["outrage"], {}, 2);
  assert.ok(Math.abs(s0.rank - Math.log(s0.worthIt / (1 - s0.worthIt))) < 1e-9);
  assert.ok(s2.rank < s0.rank);
});

test("watch completion as a weak liking signal", () => {
  assert.equal(M.implicitTarget(540, 600), 0.8);    // watched 90%
  assert.equal(M.implicitTarget(40, 900), 0.25);    // bailed after 40 s
  assert.equal(M.implicitTarget(300, 600), null);   // half: unclear
  assert.equal(M.implicitTarget(20, 0), null);      // unknown length
  const m = M.freshModel(), before = m.like.bias;
  M.update(m, "like", M.features([], {}), 0.8, { weight: 0.5 });
  M.update(m, "like", M.features([], {}), 0.8);
  const half = M.freshModel();
  M.update(half, "like", M.features([], {}), 0.8, { weight: 0.5 });
  assert.ok(half.like.bias - before < (m.like.bias - before) / 2 + 1e-9, "half weight moves the model less");
});

test("leaving early only counts against a video if you don't come back", () => {
  const now = Date.now(), day = M.DAY_MS;
  const v = (watchedSec, durationSec, daysAgo, extra = {}) => ({ watchedSec, durationSec, ts: now - daysAgo * day, ...extra });
  assert.deepEqual(M.implicitDecision(v(720, 900, 0), now), { action: "learn", y: 0.8 });   // finished: counts now
  assert.deepEqual(M.implicitDecision(v(40, 900, 0), now), { action: "wait" });             // left early: wait...
  assert.deepEqual(M.implicitDecision(v(40, 900, 2), now), { action: "wait" });
  assert.deepEqual(M.implicitDecision(v(40, 900, 4), now), { action: "learn", y: 0.25 });   // ...no return in 3 days
  assert.deepEqual(M.implicitDecision(v(450, 900, 5), now), { action: "drop" });            // halfway: no signal
  assert.deepEqual(M.implicitDecision(v(40, 900, 10, { later: true }), now), { action: "wait" });   // "finishing later"
  assert.deepEqual(M.implicitDecision(v(40, 900, 15, { later: true }), now), { action: "drop" });   // never a negative
  // lastTs (most recent visit) is what counts, not the first visit.
  assert.deepEqual(M.implicitDecision(v(40, 900, 10, { lastTs: now - day }), now), { action: "wait" });
});

test("learns from clicks: never clicking outrage lowers its pull", () => {
  const m = M.freshModel();
  for (let i = 0; i < 300; i++) M.update(m, "want", M.features(["outrage"], {}), 0);
  assert.ok(m.want.outrage < M.PRIOR.want.outrage);
});

test("old saved models (before channels) still score", () => {
  const old = { want: { ...M.PRIOR.want }, like: { ...M.PRIOR.like }, nWant: 0, nLike: 0 };
  const s = M.score(old, ["hype"], {}, 1, "Some Channel");
  assert.ok(s.worthIt > 0 && s.worthIt < 1);
});

test("demo data: hooky-but-good channel is spared, hooky-and-bad one is flagged", () => {
  globalThis.chrome = { storage: { local: {} } };   // store.js only needs the reference at load time
  require("../src/demo.js");
  require("../src/store.js");
  const S = globalThis.WorthItStore;
  const { model, stats, watches } = globalThis.WorthItDemo.generate(globalThis.WorthIt, S);
  assert.ok(watches.length > 100, `watches=${watches.length}`);
  const ctr = (c) => c.clicked / c.shown, worth = (c) => c.worth / c.rated;
  assert.ok(ctr(stats.hooks.curiosity_gap) > ctr(stats.none), "curiosity gap should pull harder");
  assert.ok(worth(stats.hooks.shouting) < worth(stats.none), "shouting should pay off less");
  const hooks = M.detectHooks("The Truth About Seed Oils Nobody Tells You", 0.8);
  assert.equal(M.score(model, hooks, { depth: 1 }, 1, "Curious Science").junk, false);
  assert.ok(M.score(model, hooks, { depth: 1 }, 1, "Curious Science").worthIt > 0.85);
  const good = M.score(model, hooks, { depth: 1 }, 1, "Curious Science");
  const bad = M.score(model, hooks, { depth: 1 }, 1, "Shock Lab");
  assert.ok(bad.worthIt < good.worthIt - 0.15, `bad=${bad.worthIt} good=${good.worthIt}`);
  assert.ok(bad.gap > good.gap + 1);
});

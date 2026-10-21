// Run: node --test test/hooks.test.js test/model.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../src/model.js");

// Rate n videos: teaches the model and the track record, like the store does.
let nextId = 0;
const rateN = (m, hooks, rating, n, channel) => {
  for (let i = 0; i < n; i++) {
    M.update(m, "like", M.features(hooks, {}), M.ratingTarget(rating), { channel });
    M.recordRating(m, { id: `v${nextId++}`, hooks, channel }, null, rating);
  }
};

test("priors: hooks lower the expected payoff, but no verdict without your own ratings", () => {
  const m = M.freshModel();
  const hooked = M.score(m, ["curiosity_gap", "shouting"], { depth: 1, lateNight: false }, 1);
  const plain = M.score(m, [], { depth: 1, lateNight: false }, 1);
  assert.ok(hooked.pull > 1 && plain.pull === 1);
  assert.ok(plain.worthIt > hooked.worthIt);
  assert.ok(plain.rank > hooked.rank);
  assert.ok(hooked.gap > 0, "the pull is there...");
  assert.equal(hooked.level, "none", "...but it isn't a verdict");
  assert.equal(hooked.basis, null);
});

test("a hook you keep regretting is junk food, from any channel", () => {
  const m = M.freshModel();
  for (const ch of ["A", "B", "C", "D", "E", "F"]) rateN(m, ["curiosity_gap"], 1, 1, ch);
  const s = M.score(m, ["curiosity_gap"], {}, 1, "Never Rated");
  assert.equal(s.level, "junk");
  assert.equal(s.basis.kind, "hook");
  assert.equal(s.basis.n, 6);
});

test("channel track record beats packaging: same hook, different channels", () => {
  const m = M.freshModel();
  rateN(m, ["curiosity_gap"], 5, 4, "Curious Science");   // hooky titles, great videos
  rateN(m, ["curiosity_gap"], 1, 4, "Drama Daily");       // hooky titles, regretted
  const good = M.score(m, ["curiosity_gap"], {}, 1, "Curious Science");
  const bad = M.score(m, ["curiosity_gap"], {}, 1, "drama daily");   // channel names are case-insensitive
  assert.ok(good.worthIt > bad.worthIt + 0.2, `good=${good.worthIt} bad=${bad.worthIt}`);
  assert.equal(good.level, "good");
  assert.equal(bad.level, "junk");
  assert.deepEqual([bad.basis.kind, bad.basis.n, bad.basis.neg], ["channel", 4, 4]);
});

test("no hook needed: a plain-titled channel you regret is junk food", () => {
  const m = M.freshModel();
  rateN(m, [], 1, 3, "Calm Titles");
  assert.equal(M.score(m, [], {}, 1, "Calm Titles").level, "junk");
});

test("how much evidence it takes: 1 bad rating is nothing, 2 risky, 3 of 3 or 4 of 5 junk", () => {
  const levels = (ratings) => {
    const m = M.freshModel();
    return ratings.map((r) => (rateN(m, [], r, 1, "C"), m.record.channels.c.level));
  };
  assert.deepEqual(levels([1, 1, 1]), ["none", "risky", "junk"]);
  assert.equal(levels([1, 1, 4, 1, 2]).pop(), "junk");
  assert.equal(levels([1, 1, 4, 1]).pop(), "risky");
  assert.deepEqual(levels([5, 5, 4]), ["none", "none", "good"]);
});

test("a verdict doesn't flip on one rating: leaving a level takes more than entering it", () => {
  const m = M.freshModel();
  rateN(m, [], 1, 3, "C");
  assert.equal(m.record.channels.c.level, "junk");
  rateN(m, [], 4, 1, "C");
  assert.equal(m.record.channels.c.level, "junk", "one good video doesn't undo three bad ones");
  // ...but the same evidence arrived at from scratch would only be risky: that's the buffer
  assert.ok(M.badChance(m.record.channels.c) < M.LEVELS.junk.enter);
  rateN(m, [], 5, 2, "C");
  assert.notEqual(m.record.channels.c.level, "junk", "a run of good ones does");
});

test("your own rating of a video always wins", () => {
  const m = M.freshModel();
  rateN(m, ["outrage"], 1, 4, "Drama Daily");
  M.recordRating(m, { id: "loved", hooks: ["outrage"], channel: "Drama Daily" }, null, 5);
  M.recordRating(m, { id: "hated", hooks: [], channel: "Lovely" }, null, 1);
  const loved = M.score(m, ["outrage"], {}, 1, "Drama Daily", { id: "loved" });
  const hated = M.score(m, [], {}, 1, "Lovely", { id: "hated" });
  assert.deepEqual([loved.level, loved.basis.kind], ["good", "you"]);
  assert.deepEqual([hated.level, hated.basis.kind], ["junk", "you"]);
});

test("changing your rating replaces it in the track record", () => {
  const m = M.freshModel();
  const w = { id: "x", hooks: [], channel: "C" };
  M.recordRating(m, w, null, 1);
  M.recordRating(m, w, 1, 5);
  const g = m.record.channels.c;
  assert.deepEqual([g.n, g.pos, g.neg, m.record.videos.x], [1, 1, 0, 5]);
  assert.ok(Math.abs(g.good - 1) < 1e-9 && Math.abs(g.bad) < 1e-9);
});

test("a hook alone doesn't blur a channel you've enjoyed before", () => {
  const m = M.freshModel();
  for (const ch of ["A", "B", "C", "D", "E", "F"]) rateN(m, ["fear"], 1, 1, ch);
  rateN(m, ["fear"], 5, 1, "Science Weekly");
  const s = M.score(m, ["fear"], {}, 1, "Science Weekly");
  assert.equal(s.level, "risky");
  assert.equal(s.capped, true);
});

test("minutes matter: long risky videos are junk food, tiny junk ones only risky", () => {
  const m = M.freshModel();
  rateN(m, [], 1, 2, "Risky");     // risky
  rateN(m, [], 1, 3, "Junk");      // junk food
  const long = M.score(m, [], {}, 1, "Risky", { id: "l", durationSec: 3 * 3600 });
  const short = M.score(m, [], {}, 1, "Junk", { id: "s", durationSec: 60 });
  assert.equal(long.level, "junk");
  assert.equal(long.long, true);
  assert.ok(long.regretMin > M.LONG_REGRET_MIN);
  assert.equal(short.level, "risky");
  assert.equal(short.short, true);
  assert.equal(M.score(m, [], {}, 1, "Risky", { durationSec: 600 }).level, "risky");
});

test("the Beta maths", () => {
  assert.ok(Math.abs(M.betaCdf(0.5, 2, 2) - 0.5) < 1e-6);
  assert.ok(Math.abs(M.betaCdf(0.5, 3, 1) - 0.125) < 1e-6);
  assert.ok(Math.abs(M.betaCdf(0.5, 2, 4) - 0.8125) < 1e-6);
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
  assert.equal(M.score(model, hooks, { depth: 1 }, 1, "Shock Lab").junk, true, "the regretted channel is flagged from its ratings");
  assert.ok(M.score(model, hooks, { depth: 1 }, 1, "Curious Science").worthIt > 0.85);
  const good = M.score(model, hooks, { depth: 1 }, 1, "Curious Science");
  const bad = M.score(model, hooks, { depth: 1 }, 1, "Shock Lab");
  assert.ok(bad.worthIt < good.worthIt - 0.15, `bad=${bad.worthIt} good=${good.worthIt}`);
  assert.ok(bad.gap > good.gap + 1);
});

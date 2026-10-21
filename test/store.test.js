// Run: node --test test/hooks.test.js test/model.test.js test/store.test.js
// Storage flows with an in-memory chrome.storage: return visits, "finishing later", "got what I needed".
const test = require("node:test");
const assert = require("node:assert/strict");

let data = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
      },
      set: async (obj) => Object.assign(data, structuredClone(obj)),
      clear: async () => (data = {}),
    },
  },
};
require("../src/model.js");
require("../src/store.js");
const S = globalThis.WorthItStore;
const W = globalThis.WorthIt;
const DAY = W.DAY_MS;

const find = (id) => data.watches.filter((w) => w.id === id);
const age = (id, days) => find(id).forEach((w) => { w.ts -= days * DAY; w.lastTs = (w.lastTs || w.ts) - days * DAY; });
async function view(id, watchedSec, durationSec = 900) {
  const c = await S.watchStart({ id });
  const ts = c.resume ? c.resume.ts : Date.now();
  await S.watchEnd({ id, title: id, channel: "Chan", hooks: [], ts, lastTs: Date.now(), depth: c.depth,
                     watchedSec: (c.resume ? c.resume.watchedSec : 0) + watchedSec, durationSec });
  return { ts, resumed: !!c.resume };
}

test("return visits continue the same viewing, and an early exit is never held against it", async () => {
  await S.reset();
  await S.init();
  const first = await view("v1", 60);                        // leave at ~7%
  await S.dismiss({ id: "v1" });
  assert.equal(data.model.nLike, 0, "early exit is not learned yet");
  age("v1", 1);                                              // come back the next day
  const second = await view("v1", 640);
  assert.equal(second.resumed, true);
  assert.equal(second.ts, first.ts - DAY, "same viewing key (shifted by the simulated day)");
  const [w] = find("v1");
  assert.equal(find("v1").length, 1, "one viewing, not two");
  assert.equal(w.visits, 2);
  assert.equal(w.watchedSec, 700);
  await S.dismiss({ id: "v1" });                   // skip the prompt: 78% watched -> weak "liked it"
  assert.equal(data.model.nLike, 1);
  assert.ok(data.model.channels.chan.like > 0);
});

test("an early exit with no return counts as a weak negative after 3 days", async () => {
  await S.reset();
  await S.init();
  const { ts } = await view("v2", 30);
  await S.dismiss({ id: "v2", ts });
  age("v2", 4);
  await view("other", 20);                                   // any later watch settles old viewings
  assert.equal(find("v2")[0].learned, true);
  assert.ok(data.model.channels.chan.like < 0);
});

test("'Finishing later' learns nothing, isn't asked about again, and resumes", async () => {
  await S.reset();
  await S.init();
  const { ts } = await view("v3", 45);
  await S.later({ id: "v3", ts });
  assert.equal(await S.pendingRating(), null, "not asked again while waiting");
  age("v3", 5);
  await view("other", 20);
  assert.equal(find("v3")[0].learned, undefined, "still waiting for you after 5 days");
  const back = await view("v3", 600);
  assert.equal(back.resumed, true);
  assert.equal(find("v3")[0].later, false);
  age("v3", 20);
  await view("other2", 20);
  assert.equal(data.model.nLike, 1, "only the finished viewing taught it anything");
});

test("'Finishing later' that you never finish is dropped, not counted against it", async () => {
  await S.reset();
  await S.init();
  const { ts } = await view("v4", 45);
  await S.later({ id: "v4", ts });
  age("v4", 15);
  await view("other", 20);
  assert.equal(find("v4")[0].learned, true);
  assert.equal(data.model.nLike, 0);
});

test("'Got what I needed' counts as worth it without finishing", async () => {
  await S.reset();
  await S.init();
  const { ts } = await view("v5", 120);
  await S.rate({ id: "v5", ts, rating: 4, partial: true });
  const [w] = find("v5");
  assert.equal(w.partial, true);
  assert.equal(w.rating, 4);
  assert.equal(data.stats.none.worth, 1);
  assert.ok(data.model.channels.chan.like > 0);
});

test("watching a rated video again keeps one entry, and rating it again replaces the rating", async () => {
  await S.reset();
  await S.init();
  const { ts } = await view("v6", 800);
  await S.rate({ id: "v6", rating: 2 });
  age("v6", 2);
  const again = await view("v6", 100);
  assert.equal(again.resumed, true);
  assert.equal(find("v6").length, 1, "one entry per video");
  assert.equal(find("v6")[0].watchedSec, 900, "watch time adds up");
  assert.equal(find("v6")[0].visits, 2);
  await S.rate({ id: "v6", rating: 5 });
  const [w] = find("v6");
  assert.equal(w.rating, 5);
  assert.equal(w.ts, ts - 2 * DAY, "same key");
  assert.equal(data.stats.none.rated, 1, "counted once in the stats");
  assert.equal(data.stats.none.ratingSum, 5);
  assert.equal(data.stats.none.worth, 1);
  assert.equal(data.stats.none.watched, 1);
});

test("rating again with the same answer doesn't teach the model twice", async () => {
  await S.reset();
  await S.init();
  await view("v8", 800);
  await S.rate({ id: "v8", rating: 4 });
  await view("v8", 100);
  await S.rate({ id: "v8", rating: 4 });
  assert.equal(data.model.nLike, 1);
});

test("duplicate entries saved by older versions are merged once", async () => {
  await S.reset();
  await S.init();
  await view("v9", 300);
  await S.rate({ id: "v9", rating: 2 });
  // what older versions saved for a second viewing: a separate entry and stats counted twice
  const dup = { ...find("v9")[0], ts: Date.now() + 1, watchedSec: 200, rating: 5 };
  data.watches.push(dup);
  Object.assign(data.stats.none, { watched: 2, rated: 2, ratingSum: 7, worth: 1 });
  S.__resetForTest();
  await S.init();
  assert.equal(find("v9").length, 1);
  assert.equal(find("v9")[0].watchedSec, 500);
  assert.equal(find("v9")[0].rating, 5, "the latest answer wins");
  assert.deepEqual([data.stats.none.watched, data.stats.none.rated, data.stats.none.ratingSum, data.stats.none.worth], [1, 1, 5, 1]);
});

test("only a video you left in the last few minutes, and weren't asked about, is brought up later", async () => {
  await S.reset();
  await S.init();
  const c = await S.watchStart({ id: "v7" });
  const w = { id: "v7", title: "v7", channel: "Chan", hooks: [], ts: Date.now(), depth: c.depth, watchedSec: 90, durationSec: 900 };
  await S.watchEnd({ ...w, ended: false });                  // checkpoint: still playing, maybe in another tab
  assert.equal(await S.pendingRating(), null, "never asks about a video that's still playing");
  await S.watchEnd({ ...w, ended: true });
  assert.equal((await S.pendingRating()).id, "v7");
  find("v7")[0].endTs -= 11 * 60 * 1000;
  assert.equal(await S.pendingRating(), null, "too long ago to ask about now");
  find("v7")[0].endTs += 11 * 60 * 1000;
  await S.skip({ id: "v7", ts: w.ts });
  assert.equal(await S.pendingRating(), null, "skipped by the 'Sometimes' limit: not brought up later");
  assert.equal(data.model.nLike, 0, "skipping learns nothing by itself");
});

test("ratings feed the track record; re-rating replaces, and old saved data is rebuilt", async () => {
  await S.reset();
  await S.init();
  for (const id of ["a", "b", "c"]) {
    await view(id, 300);
    await S.rate({ id, rating: 1 });
  }
  assert.equal(data.model.record.channels.chan.level, "junk");
  await S.rate({ id: "c", rating: 5 });                       // changed my mind about one
  assert.deepEqual([data.model.record.channels.chan.n, data.model.record.channels.chan.pos], [3, 1]);
  assert.equal(data.model.record.videos.c, 5);
  delete data.model.record;                                   // saved by an older version
  S.__resetForTest();
  await S.init();
  assert.deepEqual([data.model.record.channels.chan.n, data.model.record.channels.chan.neg], [3, 2]);
});

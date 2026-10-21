// Run: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectHooks, thumbnailArousal } = require("../src/hooks.js");

const CASES = [
  ["You WON'T Believe What Happened Next...", ["curiosity_gap", "shouting"]],
  ["The Truth About Seed Oils Nobody Tells You", ["curiosity_gap"]],
  ["This Streamer Got EXPOSED Live 😳😳😳", ["outrage", "shouting"]],
  ["STOP Doing This Before It's Too Late!!", ["fear", "shouting"]],
  ["I Spent $100,000 On The World's Biggest Pizza", ["hype"]],
  ["Everyone Is Talking About This New Phone", ["social_proof"]],
  ["Leaked Footage Before It's Deleted", ["urgency"]],
  ["He DESTROYED Them In 30 Seconds", ["outrage"]],
  ["Warning: Your Phone Is Doing This Right Now", ["fear", "urgency"]],
  ["You're Using Your Air Fryer Wrong", ["fear"]],
  ["The Most Insane Plot Twist Of All Time", ["hype"]],
  // From a real YouTube feed (October 2026):
  ["these 59 seconds will change your life", ["hype"]],
  ["how to be insanely more fun to talk to", ["hype"]],
  ["I’m begging you to write essays", ["urgency"]],
  ["This Video is Different at 360p", ["curiosity_gap"]],
  ["Are you creative or analytical? Find out in 5 seconds.", ["curiosity_gap"]],
  ["Never share your plans ! 175 year old Chinese philosophy 🪨", ["fear"]],
];

// Ordinary titles that should come back clean.
const CLEAN = [
  "How Transformers Work, Explained Visually",
  "A Quiet Morning Hike in the Dolomites",
  "Lecture 4: Bayesian Inference",
  "Cooking Dal Makhani From Scratch",
  "Lakers vs Celtics Full Game Highlights",
  "Learning Jazz Piano: Week 12",
  "NASA Artemis II Mission Overview",
  // Real titles that were wrongly flagged before:
  "I deleted my Instagram and life got peaceful",
  "You Are Solving The Impossible | Interstellar Soundtrack",
  "Sam Altman's Method for Clear Thinking",
  "The Science Of Beauty, Explained",
];

for (const [title, expected] of CASES) {
  test(`flags hooks: ${title}`, () => {
    const got = detectHooks(title);
    for (const h of expected) assert.ok(got.includes(h), `expected ${h} in [${got}]`);
  });
}

for (const title of CLEAN) {
  test(`no hooks: ${title}`, () => assert.deepEqual(detectHooks(title), []));
}

test("loud thumbnail only flagged above the threshold", () => {
  assert.ok(detectHooks("Plain title", 0.9).includes("loud_thumbnail"));
  assert.ok(!detectHooks("Plain title", 0.2).includes("loud_thumbnail"));
  assert.ok(!detectHooks("Plain title").includes("loud_thumbnail"));
});

test("thumbnail arousal: vivid image scores higher than a grey one", () => {
  const n = 64 * 36;
  const grey = new Uint8ClampedArray(n * 4).map((_, i) => (i % 4 === 3 ? 255 : 120));
  const vivid = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const red = i % 2 === 0;
    vivid.set(red ? [250, 20, 20, 255] : [255, 230, 0, 255], i * 4);
  }
  assert.ok(thumbnailArousal(grey) < 0.15, `grey=${thumbnailArousal(grey)}`);
  assert.ok(thumbnailArousal(vivid) > 0.7, `vivid=${thumbnailArousal(vivid)}`);
});

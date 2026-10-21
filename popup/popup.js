// Toolbar popup: settings + today at a glance.
const $ = (id) => document.getElementById(id);
const STRICTNESS = ["gentle", "medium", "strict"];
const STRICT_WHAT = {
  gentle: "Flags a channel after 3 bad ratings (risky), 4 for junk food. Long videos count from an hour of likely regret.",
  medium: "Flags a channel after 2 bad ratings (risky), 3 for junk food. Long videos count from 30 min of likely regret.",
  strict: "Flags a channel after 1 bad rating (risky), 2 for junk food. Long videos count from 15 min of likely regret.",
};
function showStrictness(name) {
  $("strictVal").textContent = name;
  $("strictWhat").textContent = STRICT_WHAT[name];
}

async function load() {
  const { settings = {}, watches = [], demo } = await chrome.storage.local.get(["settings", "watches", "demo"]);
  for (const k of ["blur", "badges"]) $(k).checked = settings[k] !== false;
  $("askMode").value = settings.askRating === false ? "never" : settings.askMode || "bar";
  const strict = STRICTNESS.includes(settings.strictness) ? settings.strictness : "medium";
  $("strictness").value = STRICTNESS.indexOf(strict);
  showStrictness(strict);

  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = demo ? watches.slice(-12) : watches.filter((w) => (w.lastTs || w.ts) >= midnight);
  const rated = today.filter((w) => w.rating != null);
  const worth = rated.length ? Math.round((100 * rated.filter((w) => w.rating >= 4).length) / rated.length) + "%" : "–";
  const mins = Math.round(today.reduce((s, w) => s + w.watchedSec, 0) / 60);
  $("today").innerHTML = `
    <div class="tile"><b>${today.length}</b><span>videos ${demo ? "(demo)" : "today"}</span></div>
    <div class="tile"><b>${mins}</b><span>minutes</span></div>
    <div class="tile"><b>${worth}</b><span>worth it</span></div>
    ${today.length ? "" : '<div class="note">Watch something on YouTube and rate it to start learning.</div>'}`;
}

async function save(patch) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, ...patch } });
}

for (const k of ["blur", "badges"]) $(k).addEventListener("change", (e) => save({ [k]: e.target.checked }));
$("askMode").addEventListener("change", (e) => save({ askMode: e.target.value, askRating: e.target.value !== "never" }));
$("strictness").addEventListener("input", (e) => showStrictness(STRICTNESS[+e.target.value]));
$("strictness").addEventListener("change", (e) => save({ strictness: STRICTNESS[+e.target.value] }));
$("report").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

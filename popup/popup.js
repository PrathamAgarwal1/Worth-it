// Toolbar popup: settings + today at a glance.
const $ = (id) => document.getElementById(id);
const STRICTNESS = ["off", "gentle", "gentle", "medium", "medium", "strict", "strict", "very strict", "very strict"];

async function load() {
  const { settings = {}, watches = [], demo } = await chrome.storage.local.get(["settings", "watches", "demo"]);
  for (const k of ["blur", "badges"]) $(k).checked = settings[k] !== false;
  $("askMode").value = settings.askRating === false ? "never" : settings.askMode || "sometimes";
  $("lambda").value = settings.lambda ?? 1;
  $("lambdaVal").textContent = STRICTNESS[Math.round(($("lambda").value) * 4)];

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
$("lambda").addEventListener("input", (e) => {
  $("lambdaVal").textContent = STRICTNESS[Math.round(e.target.value * 4)];
  save({ lambda: +e.target.value });
});
$("report").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();

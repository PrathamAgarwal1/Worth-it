// "Your Brain on YouTube": turns your clicks and ratings into a wanting-vs-liking report.
const W = globalThis.WorthIt;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (p) => (p == null ? "–" : `${Math.round(100 * p)}%`);
const MIN_SHOWN = 20;      // impressions needed before a click rate is shown
const MIN_RATED = 3;       // ratings needed before a worth-it rate is shown
const MIN_INSIGHT = 5;     // ratings per group needed for an insight

const ctr = (c) => (c && c.shown >= MIN_SHOWN ? c.clicked / c.shown : null);
const worth = (c, min = MIN_RATED) => (c && c.rated >= min ? c.worth / c.rated : null);

function duration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

// ---- Summary tiles ----------------------------------------------------------------------
function renderTiles(watches) {
  const rated = watches.filter((w) => w.rating != null);
  const good = rated.filter((w) => w.rating >= 4).length;
  const total = watches.reduce((s, w) => s + w.watchedSec, 0);
  const regret = rated.filter((w) => w.rating <= 2).reduce((s, w) => s + w.watchedSec, 0);
  $("tiles").innerHTML = [
    [watches.length, "videos tracked"],
    [duration(total), "watched"],
    [rated.length ? pct(good / rated.length) : "–", `worth it (${rated.length} rated)`],
    [duration(regret), "on videos you regretted"],
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");
  $("range").textContent = watches.length
    ? `${new Date(watches[0].ts).toLocaleDateString()} – ${new Date(watches[watches.length - 1].ts).toLocaleDateString()}`
    : "No videos tracked yet: watch something on YouTube and rate it.";
}

// ---- Hooks table -------------------------------------------------------------------------
function hookRows(stats) {
  const base = { ctr: ctr(stats.none), worth: worth(stats.none) };
  const rows = W.HOOKS.map((h) => {
    const c = stats.hooks[h.id];
    const r = { hook: h, ctr: ctr(c), worth: worth(c), shown: c.shown, rated: c.rated };
    if (r.ctr == null || r.worth == null || base.ctr == null || base.worth == null) r.verdict = "na";
    else if (r.ctr >= base.ctr * 1.15 && r.worth <= base.worth - 0.1) r.verdict = "junk";
    else if (r.worth >= base.worth - 0.05) r.verdict = "ok";
    else r.verdict = "mixed";
    r.gap = r.verdict === "na" ? -Infinity : (r.ctr / base.ctr - 1) + (base.worth - r.worth) * 2;
    return r;
  });
  rows.sort((a, b) => b.gap - a.gap);
  return { rows, base };
}

function renderHooks(stats) {
  const { rows, base } = hookRows(stats);
  const maxCtr = Math.max(0.01, base.ctr || 0, ...rows.map((r) => r.ctr || 0)) * 1.1;
  const bar = (v, max, color, b) => `
    <div class="bar">${v == null ? "" : `<i style="width:${(100 * v) / max}%;background:var(${color})"></i>`}
      ${b == null ? "" : `<span class="base" style="left:${(100 * b) / max}%"></span>`}</div>`;
  const tag = { junk: ["junk", "junk-food trigger"], ok: ["ok", "pays off"], mixed: ["na", "pulls, mixed payoff"], na: ["na", "not enough data"] };
  $("hooks").innerHTML = `<div class="table-wrap"><table class="hooks">
    <thead><tr><th>Hook</th><th>Click rate when shown <span class="want">(wanting)</span></th><th>Worth it when watched <span class="like">(liking)</span></th><th>Verdict</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr title="${esc(r.hook.explain)}">
        <td><div class="hook-name">${r.hook.emoji} ${esc(r.hook.label)}</div><div class="hook-theory">${esc(r.hook.theory)}</div></td>
        <td class="barcell">${bar(r.ctr, maxCtr, "--want", base.ctr)}<div class="val">${r.ctr == null ? `${r.shown} seen so far` : `${pct(r.ctr)} · ${r.shown} seen`}</div></td>
        <td class="barcell">${bar(r.worth, 1, "--like", base.worth)}<div class="val">${r.worth == null ? `${r.rated} rated so far` : `${pct(r.worth)} · ${r.rated} rated`}</div></td>
        <td><span class="tag ${tag[r.verdict][0]}">${tag[r.verdict][1]}</span></td>
      </tr>`).join("")}
      <tr><td><div class="hook-name">— No hook</div><div class="hook-theory">Plain titles: your baseline</div></td>
        <td class="barcell">${bar(base.ctr, maxCtr, "--muted")}<div class="val">${pct(base.ctr)} · ${stats.none.shown} seen</div></td>
        <td class="barcell">${bar(base.worth, 1, "--muted")}<div class="val">${pct(base.worth)} · ${stats.none.rated} rated</div></td><td></td></tr>
    </tbody></table></div>`;
  return { rows, base };
}

// ---- Insights ----------------------------------------------------------------------------
function split(watches, pred) {
  const rated = watches.filter((w) => w.rating != null);
  const a = rated.filter(pred), b = rated.filter((w) => !pred(w));
  const r = (xs) => (xs.length >= MIN_INSIGHT ? xs.filter((w) => w.rating >= 4).length / xs.length : null);
  return [r(a), r(b), a.length, b.length];
}

function renderInsights(watches, stats, hooks) {
  const out = [];
  const top = hooks.rows.find((r) => r.verdict === "junk");
  if (top) {
    out.push(["warn", `${top.hook.emoji} <b>${esc(top.hook.label)}</b> is your biggest junk-food trigger: you click it
      <b>${(top.ctr / hooks.base.ctr).toFixed(1)}×</b> as often as plain videos, but only <b>${pct(top.worth)}</b> were worth it
      (plain videos: ${pct(hooks.base.worth)}). <i>${esc(top.hook.explain)}</i>`]);
  }
  // Packaging isn't everything: channels that use hooks but that you rate highly anyway.
  const byChannel = {};
  for (const w of watches) if (w.rating != null && w.channel) (byChannel[w.channel] = byChannel[w.channel] || []).push(w);
  const exception = Object.entries(byChannel)
    .map(([c, ws]) => ({ c, n: ws.length, hooked: ws.filter((w) => w.hooks.length).length / ws.length,
                         avg: ws.reduce((s, w) => s + w.rating, 0) / ws.length }))
    .filter((x) => x.n >= 3 && x.hooked >= 0.6 && x.avg >= 4)
    .sort((a, b) => b.avg - a.avg)[0];
  if (exception) {
    out.push(["", `✨ <b>${esc(exception.c)}</b> uses hooky titles and thumbnails, but you rate it ${exception.avg.toFixed(1)}/5.
      Its track record wins, so Worth It? doesn't hold the packaging against it.`]);
  }
  const best = hooks.rows.filter((r) => r.verdict === "ok").sort((a, b) => b.worth - a.worth)[0];
  if (best) out.push(["", `${best.hook.emoji} <b>${esc(best.hook.label)}</b> videos actually pay off for you: ${pct(best.worth)} worth it.`]);

  const [late, day] = split(watches, (w) => w.lateNight);
  if (late != null && day != null && day - late >= 0.1) {
    out.push(["warn", `🌙 <b>After 11pm</b>, only ${pct(late)} of what you watch is worth it, vs ${pct(day)} earlier in the day.
      Tiredness weakens self-control while the pull of the cue stays strong.`]);
  }
  const [deep, shallow] = split(watches, (w) => w.depth >= W.DEEP_SESSION);
  if (deep != null && shallow != null && shallow - deep >= 0.1) {
    out.push(["warn", `🔁 <b>Rabbit holes</b>: from the ${W.DEEP_SESSION}th video of a session onward, ${pct(deep)} are worth it
      (vs ${pct(shallow)} for the first few). Each extra video is easier to start and less rewarding.`]);
  }
  const moods = Object.entries(stats.moods).map(([m, c]) => [m, worth(c, MIN_INSIGHT)]).filter(([, v]) => v != null);
  if (moods.length >= 2) {
    moods.sort((a, b) => a[1] - b[1]);
    const [m, v] = moods[0];
    out.push(["", `😣 When you feel <b>${esc(m)}</b>, ${pct(v)} of videos are worth it, your lowest of any mood.`]);
  }
  const regret = watches.filter((w) => w.rating != null && w.rating <= 2).reduce((s, w) => s + w.watchedSec, 0);
  if (regret > 600) out.push(["", `⏳ You've spent <b>${duration(regret)}</b> on videos you later rated 1–2.`]);

  const nRated = watches.filter((w) => w.rating != null).length;
  $("insights").innerHTML = out.length
    ? out.map(([cls, html]) => `<li class="${cls}">${html}</li>`).join("")
    : `<li class="empty">Rate a few more videos to unlock insights (${nRated} rated so far). Hooks need ${MIN_RATED}+ ratings each.</li>`;
}

// ---- Bar charts (SVG; one measure, one axis) ---------------------------------------------
function barChart(el, items, { band = [], bandLabel = "" } = {}) {
  if (!items.some((d) => d.value != null)) {
    el.innerHTML = `<div class="chart"><div class="empty">Not enough ratings yet.</div></div>`;
    return;
  }
  const w = 460, h = 190, l = 34, r = 8, t = 14, b = 26;
  const bw = (w - l - r) / items.length;
  const y = (v) => t + (h - t - b) * (1 - v);
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
  band.forEach(([from, to], k) => {   // shaded index ranges, e.g. late-night hours
    svg += `<rect x="${l + from * bw}" y="${t}" width="${(to - from + 1) * bw}" height="${h - t - b}" fill="var(--want)" opacity="0.08"/>`;
    if (k === 0) svg += `<text x="${l + from * bw + 4}" y="${t + 10}">${bandLabel}</text>`;
  });
  for (const v of [0, 0.5, 1]) {
    svg += `<line class="gridline" x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  }
  const every = items.length > 12 ? 3 : 1;
  items.forEach((d, i) => {
    const x = l + i * bw;
    const tip = `${d.label}: ${d.value == null ? "not enough ratings" : `${pct(d.value)} worth it`} (${d.n} rated)`;
    if (d.value != null) {
      const hh = Math.max(2, y(0) - y(d.value)), top = y(0) - hh;   // 2px stub so 0% reads as a value, not missing
      svg += `<rect class="b" x="${x + bw * 0.18}" y="${top}" width="${bw * 0.64}" height="${hh}" rx="3" fill="var(--like)"><title>${esc(tip)}</title></rect>`;
    }
    svg += `<rect class="hit" x="${x}" y="${t}" width="${bw}" height="${h - t - b}"><title>${esc(tip)}</title></rect>`;
    if (i % every === 0) svg += `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(d.short ?? d.label)}</text>`;
  });
  el.innerHTML = `<div class="chart">${svg}</svg></div>`;
}

function renderCharts(stats) {
  barChart($("byHour"), stats.hours.map((c, hr) => ({ label: `${hr}:00`, short: String(hr), value: worth(c, 2), n: c.rated })),
           { band: [[0, 4], [23, 23]], bandLabel: "late night" });
  const buckets = Object.keys(stats.depth);
  barChart($("byDepth"), buckets.map((k) => ({ label: `video ${k} of session`, short: k, value: worth(stats.depth[k], 2), n: stats.depth[k].rated })));
  const moods = ["calm", "good", "tired", "stressed"];
  barChart($("byMood"), moods.map((m) => ({ label: m, value: worth(stats.moods[m], 2), n: stats.moods[m] ? stats.moods[m].rated : 0 })));
}

// ---- Channels and recent -----------------------------------------------------------------
function renderChannels(watches) {
  const by = {};
  for (const w of watches) {
    if (w.rating == null || !w.channel) continue;
    (by[w.channel] = by[w.channel] || []).push(w.rating);
  }
  const rows = Object.entries(by).filter(([, r]) => r.length >= 2)
    .map(([c, r]) => ({ c, avg: r.reduce((a, b) => a + b, 0) / r.length, n: r.length }));
  if (!rows.length) {
    $("channels").innerHTML = `<div class="list"><div class="empty">Rate two videos from the same channel to see it here.</div></div>`;
    return;
  }
  const list = (xs) => xs.map((x) => `<div class="item"><div class="grow title">${esc(x.c)}</div><div class="meta">${x.n} rated</div><div class="stars">${x.avg.toFixed(1)} / 5</div></div>`).join("");
  const best = [...rows].sort((a, b) => b.avg - a.avg).slice(0, 4);
  const worst = [...rows].sort((a, b) => a.avg - b.avg).filter((x) => !best.includes(x)).slice(0, 4);
  $("channels").innerHTML = `
    <div class="chan"><h3>Worth your time</h3><div class="list">${list(best)}</div></div>
    ${worst.length ? `<div class="chan"><h3>Pulls you in, rarely pays off</h3><div class="list">${list(worst)}</div></div>` : ""}`;
}

function renderRecent(watches) {
  const faces = ["", "😩", "😕", "😐", "🙂", "🤩"];
  const recent = watches.slice(-15).reverse();
  const answer = (w) =>
    w.partial ? "✂️ got what I needed"
      : w.rating ? faces[w.rating] + " " + w.rating
      : w.later ? '<span class="meta">⏸ finishing later</span>'
      : '<span class="meta">not rated</span>';
  $("recent").innerHTML = recent.length
    ? `<div class="list">${recent.map((w) => `
        <div class="item">
          <div class="grow"><div class="title">${esc(w.title || w.id)}</div>
            <div class="meta">${esc(w.channel || "")} · ${ago(w.lastTs || w.ts)} · watched ${duration(w.watchedSec)}${w.visits > 1 ? ` over ${w.visits} visits` : ""}${w.hooks.length ? " · " + w.hooks.map((h) => W.BY_ID[h].emoji + " " + W.BY_ID[h].label).join(", ") : ""}</div></div>
          <div class="stars">${answer(w)}</div>
        </div>`).join("")}</div>`
    : `<div class="list"><div class="empty">Nothing yet.</div></div>`;
}

// ---- Wiring ------------------------------------------------------------------------------
async function render() {
  const { stats, watches = [], demo } = await chrome.storage.local.get(["stats", "watches", "demo"]);
  $("demoBanner").hidden = !demo;
  renderTiles(watches);
  if (!stats) return;
  const hooks = renderHooks(stats);
  renderInsights(watches, stats, hooks);
  renderCharts(stats);
  renderChannels(watches);
  renderRecent(watches);
}

const send = (type) => new Promise((res) => chrome.runtime.sendMessage({ type }, res));
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-action]");
  if (!a) return;
  const action = a.dataset.action;
  if (action === "export") {
    const data = await chrome.storage.local.get(null);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "worth-it-data.json" }).click();
    URL.revokeObjectURL(url);
  } else if (action === "demo") {
    if (confirm("Replace your data with three weeks of simulated demo data?")) await send("loadDemo");
  } else if (action === "reset") {
    if (confirm("Delete all Worth It? data on this computer? This can't be undone.")) await send("reset");
  }
});
chrome.storage.onChanged.addListener(() => render());
render();

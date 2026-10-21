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
// Verdicts come from the same track record as the badges on YouTube: your own ratings of videos with
// each hook, older ones counting less. The bars show what pulls you (clicks) and what pays off.
const LEVEL_TAG = { junk: ["junk", "junk food"], risky: ["risky", "risky"], good: ["ok", "pays off"], none: ["na", "no verdict yet"] };
const LEVEL_ORDER = { junk: 0, risky: 1, none: 2, good: 3 };
// The side of your ratings that explains the verdict: the good ones for "pays off", the rest otherwise.
const ratingsLine = (g, level) => (!g || !g.n ? "no ratings yet"
  : level === "good" ? `${g.pos} of your ${g.n} rating${g.n === 1 ? "" : "s"} Good or better`
  : `${g.neg} of your ${g.n} rating${g.n === 1 ? "" : "s"} OK or worse`);

function hookRows(stats, model) {
  const rec = (model && model.record && model.record.hooks) || {};
  const base = { ctr: ctr(stats.none), worth: worth(stats.none) };
  const rows = W.HOOKS.map((h) => {
    const c = stats.hooks[h.id], g = rec[h.id];
    return { hook: h, ctr: ctr(c), worth: worth(c), shown: c.shown, rated: c.rated, g,
             verdict: g ? g.level : "none", bad: g ? W.badChance(g) : 0.5 };
  });
  rows.sort((a, b) => LEVEL_ORDER[a.verdict] - LEVEL_ORDER[b.verdict] || b.bad - a.bad);
  return { rows, base };
}

function renderHooks(stats, model) {
  const { rows, base } = hookRows(stats, model);
  const maxCtr = Math.max(0.01, base.ctr || 0, ...rows.map((r) => r.ctr || 0)) * 1.1;
  const bar = (v, max, color, b) => `
    <div class="bar">${v == null ? "" : `<i style="width:${(100 * v) / max}%;background:var(${color})"></i>`}
      ${b == null ? "" : `<span class="base" style="left:${(100 * b) / max}%"></span>`}</div>`;
  $("hooks").innerHTML = `<div class="table-wrap"><table class="hooks">
    <thead><tr><th>Hook</th><th>Click rate when shown <span class="want">(wanting)</span></th><th>Worth it when watched <span class="like">(liking)</span></th><th>Verdict</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr title="${esc(r.hook.explain)}">
        <td><div class="hook-name">${r.hook.emoji} ${esc(r.hook.label)}</div><div class="hook-theory">${esc(r.hook.theory)}</div></td>
        <td class="barcell">${bar(r.ctr, maxCtr, "--want", base.ctr)}<div class="val">${r.ctr == null ? `${r.shown} seen so far` : `${pct(r.ctr)} · ${r.shown} seen`}</div></td>
        <td class="barcell">${bar(r.worth, 1, "--like", base.worth)}<div class="val">${r.worth == null ? `${r.rated} rated so far` : `${pct(r.worth)} · ${r.rated} rated`}</div></td>
        <td><span class="tag ${LEVEL_TAG[r.verdict][0]}">${LEVEL_TAG[r.verdict][1]}</span><div class="val">${ratingsLine(r.g, r.verdict)}</div></td>
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
    const pull = top.ctr != null && hooks.base.ctr ? `you click it <b>${(top.ctr / hooks.base.ctr).toFixed(1)}×</b> as often as plain videos, but ` : "";
    out.push(["warn", `${top.hook.emoji} <b>${esc(top.hook.label)}</b> is your biggest junk-food trigger: ${pull}<b>${top.g.neg} of your
      ${top.g.n}</b> ratings of videos with it were OK or worse. <i>${esc(top.hook.explain)}</i>`]);
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
  const best = hooks.rows.filter((r) => r.verdict === "good").sort((a, b) => a.bad - b.bad)[0];
  if (best) out.push(["", `${best.hook.emoji} <b>${esc(best.hook.label)}</b> videos actually pay off for you: ${best.g.pos} of your ${best.g.n} ratings were Good or better.`]);

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
function barChart(el, items, { band = [], bandLabel = "", max = 1, fmt = (v) => `${Math.round(v * 100)}%`, color = "var(--like)",
                                  tip = (d) => `${d.label}: ${d.value == null ? "not enough ratings" : `${pct(d.value)} worth it`} (${d.n} rated)`,
                                  empty = "Not enough ratings yet." } = {}) {
  if (!items.some((d) => d.value != null)) {
    el.innerHTML = `<div class="chart"><div class="empty">${empty}</div></div>`;
    return;
  }
  const w = 460, h = 190, l = 34, r = 8, t = 14, b = 26;
  const bw = (w - l - r) / items.length;
  const y = (v) => t + (h - t - b) * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
  band.forEach(([from, to], k) => {   // shaded index ranges, e.g. late-night hours
    svg += `<rect x="${l + from * bw}" y="${t}" width="${(to - from + 1) * bw}" height="${h - t - b}" fill="var(--want)" opacity="0.08"/>`;
    if (k === 0) svg += `<text x="${l + from * bw + 4}" y="${t + 10}">${bandLabel}</text>`;
  });
  for (const v of [0, max / 2, max]) {
    svg += `<line class="gridline" x1="${l}" x2="${w - r}" y1="${y(v)}" y2="${y(v)}"/><text x="${l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  const every = items.length > 12 ? 3 : items.length > 8 ? 2 : 1;
  items.forEach((d, i) => {
    const x = l + i * bw;
    const tipText = tip(d);
    if (d.value != null) {
      const hh = Math.max(2, y(0) - y(d.value)), top = y(0) - hh;   // 2px stub so 0% reads as a value, not missing
      svg += `<rect class="b" x="${x + bw * 0.18}" y="${top}" width="${bw * 0.64}" height="${hh}" rx="3" fill="${color}"><title>${esc(tipText)}</title></rect>`;
    }
    svg += `<rect class="hit" x="${x}" y="${t}" width="${bw}" height="${h - t - b}"><title>${esc(tipText)}</title></rect>`;
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

// ---- Week by week ---------------------------------------------------------------------------
const ratedAt = (w) => w.ratedTs || w.lastTs || w.ts;
function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // Monday
  return d;
}
/** A round top for a minutes axis: 10, 15, 30, 60, 90, 120, 180, ... */
const niceMinutes = (m) => [10, 15, 30, 60, 90, 120, 180, 240, 360, 480, 720].find((x) => x >= m) || Math.ceil(m / 240) * 240;
const minutesLabel = (m) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10}h` : `${Math.round(m)}m`);

function renderTrend(watches) {
  const rated = watches.filter((w) => w.rating != null);
  // From your first rating (at most 12 weeks back, at least 4 weeks shown) to this week.
  const thisWeek = weekStart(Date.now());
  const from = weekStart(Math.max(Math.min(...rated.map(ratedAt), Date.now()), thisWeek.getTime() - 11 * 7 * 86400000));
  const back4 = new Date(thisWeek);
  back4.setDate(back4.getDate() - 21);
  const weeks = [];
  for (const d = new Date(Math.min(from, back4)); d <= thisWeek; d.setDate(d.getDate() + 7)) {
    weeks.push({ start: new Date(d), rated: 0, worth: 0, regretSec: 0 });
  }
  for (const w of rated) {
    const k = weekStart(ratedAt(w)).getTime();
    const wk = weeks.find((x) => x.start.getTime() === k);
    if (!wk) continue;
    wk.rated++;
    if (w.rating >= 4) wk.worth++;
    if (w.rating <= 2) wk.regretSec += w.watchedSec;
  }
  const label = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const items = weeks.map((wk) => ({ label: `Week of ${label(wk.start)}`, short: label(wk.start), n: wk.rated,
                                     worth: wk.rated >= 2 ? wk.worth / wk.rated : null, regret: wk.regretSec / 60 }));
  barChart($("trendWorth"), items.map((d) => ({ ...d, value: d.worth })));
  const max = niceMinutes(Math.max(0, ...items.map((d) => d.regret)));
  barChart($("trendRegret"), items.map((d) => ({ ...d, value: rated.length ? d.regret : null })), {
    max, fmt: minutesLabel, color: "var(--want)", empty: "Rate a few videos to see this.",
    tip: (d) => `${d.label}: ${minutesLabel(d.value)} on videos you rated 1–2 (${d.n} rated that week)`,
  });
}

// ---- Channels and recent -----------------------------------------------------------------
function renderChannels(model) {
  const rec = (model && model.record && model.record.channels) || {};
  const ovs = (model && model.overrides && model.overrides.channels) || {};
  const rows = [...new Set([...Object.keys(rec), ...Object.keys(ovs)])].map((k) => {
    const g = rec[k], o = ovs[k];
    return { name: (g && g.name) || (o && o.name) || k, g, ov: o ? o.value : "",
             level: o ? (o.value === "always" ? "junk" : "none") : g ? g.level : "none", bad: g ? W.badChance(g) : 0.5 };
  });
  const judged = rows.filter((r) => r.level !== "none" || r.ov)
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.bad - a.bad);
  const rest = rows.filter((r) => !(r.level !== "none" || r.ov)).sort((a, b) => (b.g ? b.g.n : 0) - (a.g ? a.g.n : 0));
  const item = (r) => `
    <div class="item">
      <div class="grow"><div class="title">${esc(r.name)}</div>
        <div class="meta">${r.ov ? (r.ov === "always" ? "Your call: always flag" : "Your call: not junk") + " · " : ""}${ratingsLine(r.g, r.level)}</div></div>
      <span class="tag ${LEVEL_TAG[r.level][0]}">${r.ov === "never" ? "not junk" : LEVEL_TAG[r.level][1]}</span>
      <select data-ch="${esc(r.name)}" aria-label="Your call on ${esc(r.name)}">
        <option value=""${r.ov ? "" : " selected"}>From my ratings</option>
        <option value="never"${r.ov === "never" ? " selected" : ""}>Not junk for me</option>
        <option value="always"${r.ov === "always" ? " selected" : ""}>Always flag</option>
      </select>
    </div>`;
  $("channels").innerHTML = rows.length
    ? `${judged.length ? `<div class="list">${judged.map(item).join("")}</div>` : `<div class="list"><div class="empty">No channel has a verdict yet: rate two or three videos from one.</div></div>`}
       ${rest.length ? `<details class="more"><summary>${rest.length} more channel${rest.length === 1 ? "" : "s"}, not judged yet</summary><div class="list">${rest.map(item).join("")}</div></details>` : ""}`
    : `<div class="list"><div class="empty">Rate a few videos to see your channels here.</div></div>`;
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
  const { stats, watches = [], demo, model } = await chrome.storage.local.get(["stats", "watches", "demo", "model"]);
  $("demoBanner").hidden = !demo;
  renderTiles(watches);
  if (!stats) return;
  const hooks = renderHooks(stats, model);
  renderInsights(watches, stats, hooks);
  renderCharts(stats);
  renderChannels(model);
  renderTrend(watches);
  renderRecent(watches);
}

const send = (type, payload = {}) => new Promise((res) => chrome.runtime.sendMessage({ type, ...payload }, res));
document.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-ch]");
  if (sel) send("override", { channel: sel.dataset.ch, value: sel.value || null });
});
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

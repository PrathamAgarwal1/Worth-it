/*
 * Runs on youtube.com.
 *   1. Feed:  label every video card with its hooks and your personal "worth it?" score,
 *             blur likely junk food, and suggest the most worth-it picks on the page.
 *   2. Wanting: log which cards were on screen and which one you clicked.
 *   3. Liking:  time how long you actually watch, then ask "Was that worth it?".
 */
(() => {
  "use strict";
  const W = globalThis.WorthIt;
  const CARD = "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model";
  const THUMB = "ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, .yt-lockup-view-model__content-image, .yt-lockup-view-model-wiz__content-image";
  const TITLE = "#video-title, a#video-title-link, .yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model-wiz__title, h3 a, h3";
  const IMPRESSION_MS = 1000;
  const MIN_WATCH_SEC = 15;

  let settings = { blur: true, badges: true, askRating: true, askMode: "sometimes", lambda: 1 };
  let model = W.freshModel();
  let ctx = { depth: 0, lateNight: W.isLateNight(new Date()) };
  const thumbArousal = new Map();          // videoId -> arousal (or null while loading)
  const info = new Map();                  // videoId -> {title, hooks, s}
  const pending = new Map();               // impressions on this page view: videoId -> {hooks, ts, depth, clicked}

  const send = (type, payload = {}) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (r) => resolve(chrome.runtime.lastError ? null : r && r.result));
      } catch (e) {
        resolve(null); // extension was reloaded; this tab's script is orphaned
      }
    });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pct = (p) => `${Math.round(100 * p)}%`;
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  // Diagnostics: open DevTools on YouTube and filter the console by "Worth It".
  const log = (...args) => console.debug("[Worth It?]", ...args);

  // ---- Reading a video card -------------------------------------------------------------
  function cardInfo(card) {
    const a = card.querySelector('a[href*="/watch?v="]');
    if (!a) return null;
    const m = a.getAttribute("href").match(/[?&]v=([\w-]{11})/);
    if (!m) return null;
    const el = card.querySelector(TITLE);
    let title = el ? el.getAttribute("title") || el.textContent : "";
    title = (title || "").replace(/\s+/g, " ").trim() || (a.getAttribute("title") || a.getAttribute("aria-label") || "").trim();
    // Channel: the first channel link with visible text (the avatar link has none).
    const chEl = [...card.querySelectorAll('ytd-channel-name a, #channel-name a, a[href^="/@"], a[href^="/channel/"]')]
      .find((e) => e.textContent.trim());
    const channel = chEl ? chEl.textContent.replace(/\s+/g, " ").trim() : "";
    return title ? { id: m[1], title, channel } : null;
  }

  function evaluate(id, title, channel) {
    const arousal = thumbArousal.get(id);
    const hooks = W.detectHooks(title, arousal == null ? undefined : arousal);
    const s = W.score(model, hooks, ctx, settings.lambda, channel);
    const v = { id, title, channel, hooks, s };
    info.set(id, v);
    return v;
  }

  function tooltip(v) {
    const lines = v.hooks.map((h) => `${W.BY_ID[h].emoji} ${W.BY_ID[h].label}: ${W.BY_ID[h].explain}`);
    if (lines.length) lines.push("");
    lines.push(`Pull: ${v.s.pull.toFixed(1)}× your usual click odds`, `Worth it: ${pct(v.s.worthIt)} chance you'll be glad you watched`);
    const ev = v.s.evidence, ch = model.channels && model.channels[W.channelKey(v.channel)];
    lines.push("");
    if (ev.channelRated) lines.push(`Based on ${ev.channelRated} of your ratings of ${v.channel}${ev.hookRated ? ` and ${ev.hookRated} of videos with this hook` : ""}.`);
    else if (ev.hookRated) lines.push(`Based on ${ev.hookRated} of your ratings of videos with this hook.`);
    else lines.push("Based on research defaults: rate a few videos to make this about you.");
    if (v.hooks.length && ch && ch.nLike >= W.EVIDENCE.channel && ch.like > 0.3) {
      lines.push(`You usually enjoy ${v.channel}, so its hooks aren't held against it.`);
    }
    if (v.s.junk) lines.push("", "Junk food: pulls harder than it pays off, for you. Hover to unblur.");
    else if (v.hooks.length && v.s.gap >= W.JUNK_GAP && !v.s.evidence.enough) {
      lines.push("", "No verdict yet: the hook is noted, but there aren't enough of your own ratings to judge it.");
    }
    return lines.join("\n");
  }

  function render(card, v) {
    card.dataset.wiVid = v.id;
    card.classList.toggle("wi-junk", v.s.junk);
    card.classList.toggle("wi-blur", v.s.junk && settings.blur);
    const host = card.querySelector(THUMB) || card;
    host.classList.add("wi-host");
    let badge = host.querySelector(":scope > .wi-badge");
    // Quiet by default: only videos with something to say get a badge, and it's a small icon
    // whose words appear when you hover the video.
    const first = v.hooks[0] && W.BY_ID[v.hooks[0]];
    const more = v.hooks.length > 1 ? ` +${v.hooks.length - 1}` : "";
    const emojis = v.hooks.map((h) => W.BY_ID[h].emoji).join("");
    let cls = "wi-badge", icon = "", text = "";
    if (v.s.junk) {
      cls += " wi-badge-junk";
      icon = first.emoji;
      text = `junk food · ${first.label}${more}`;
    } else if (v.s.worthIt >= W.WORTH_OK && v.s.evidence.enough) {
      // A good track record (from your own ratings) wins over packaging.
      cls += " wi-badge-good";
      icon = `✓${emojis}`;
      text = `worth it ${pct(v.s.worthIt)}`;
    } else if (first) {
      icon = emojis;
      text = `${first.label}${more}`;
    }
    card.dataset.wiBadge = settings.badges && icon ? "1" : "0";
    if (card.dataset.wiBadge === "0") {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      host.appendChild(badge);
    }
    badge.className = cls;
    badge.innerHTML = `<span class="wi-b-icon">${esc(icon)}</span><span class="wi-b-text">${esc(text)}</span>`;
    badge.title = tooltip(v);
  }

  function processCard(card) {
    if (card.parentElement && card.parentElement.closest(CARD)) return;   // nested renderer; handled by outer card
    if (card.querySelector('a[href*="/shorts/"]')) return;
    const ci = cardInfo(card);
    if (!ci) return;
    const known = info.get(ci.id);
    const same = known && known.title === ci.title && known.channel === ci.channel;
    // Re-render only if the video changed, or YouTube re-drew the thumbnail and dropped our badge.
    const upToDate = same && card.dataset.wiVid === ci.id && (card.dataset.wiBadge !== "1" || card.querySelector(".wi-badge"));
    if (!upToDate) render(card, same ? known : evaluate(ci.id, ci.title, ci.channel));
    observer.observe(card);
    if (!thumbArousal.has(ci.id)) {
      thumbArousal.set(ci.id, null);
      send("thumb", { id: ci.id }).then((a) => {
        if (a == null) return;
        thumbArousal.set(ci.id, a);
        const card2 = document.querySelector(`[data-wi-vid="${ci.id}"]`);
        if (card2) render(card2, evaluate(ci.id, ci.title, ci.channel));
        schedulePanel();
      });
    }
  }

  // Throttled, not debounced: YouTube mutates the DOM non-stop while a video plays.
  let scanTimer = null;
  function scan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      document.querySelectorAll(CARD).forEach(processCard);
      schedulePanel();
    }, 250);
  }

  // ---- Wanting: impressions and clicks ---------------------------------------------------
  const visibleSince = new Map();
  const observer = new IntersectionObserver((entries) => {
    const now = Date.now();
    for (const e of entries) {
      const id = e.target.dataset.wiVid;
      if (!id) continue;
      if (e.isIntersecting) {
        visibleSince.set(e.target, now);
        setTimeout(() => {
          if (visibleSince.get(e.target) === now && e.target.dataset.wiVid === id) addImpression(id, false);
        }, IMPRESSION_MS);
      } else {
        visibleSince.delete(e.target);
      }
    }
  }, { threshold: 0.6 });

  function addImpression(id, clicked) {
    const v = info.get(id);
    if (!v) return;
    const p = pending.get(id) || { id, channel: v.channel, hooks: v.hooks, ts: Date.now(), depth: ctx.depth, clicked: false };
    p.clicked = p.clicked || clicked;
    pending.set(id, p);
  }

  function onClick(e) {
    const a = e.target.closest && e.target.closest('a[href*="/watch?v="]');
    const card = a && a.closest("[data-wi-vid]");
    if (card) addImpression(card.dataset.wiVid, true);
  }
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);

  function flushImpressions() {
    if (!pending.size) return;
    const items = [...pending.values()];
    pending.clear();
    send("impressions", { items });
  }

  // ---- Picks panel ---------------------------------------------------------------------
  let panel = null, panelOpen = false, panelTimer = null, panelHtml = "";
  function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(() => {
      panelTimer = null;
      renderPanel();
    }, 300);
  }
  function renderPanel() {
    const onPage = [...document.querySelectorAll("[data-wi-vid]")].map((c) => info.get(c.dataset.wiVid)).filter(Boolean);
    const uniq = [...new Map(onPage.map((v) => [v.id, v])).values()];
    if ((!uniq.length && !watch) || location.pathname.startsWith("/shorts")) {
      if (panel) panel.remove();
      panel = null;
      panelHtml = "";
      return;
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "wi-panel";
      panel.addEventListener("click", (e) => {
        const item = e.target.closest("[data-go]");
        if (item) {
          const link = document.querySelector(`[data-wi-vid="${item.dataset.go}"] a[href*="/watch?v="]`);
          if (link) link.click();
          else location.href = `/watch?v=${item.dataset.go}`;
        } else if (e.target.closest(".wi-panel-toggle")) {
          panelOpen = !panelOpen;
          renderPanel();
        }
      });
      document.body.appendChild(panel);
    }
    const junk = uniq.filter((v) => v.s.junk).length;
    const picks = uniq.filter((v) => !v.s.junk).sort((a, b) => b.s.rank - a.s.rank).slice(0, 5);
    const state = ctx.lateNight || ctx.depth >= W.DEEP_SESSION
      ? `<div class="wi-panel-state">${ctx.lateNight ? "🌙 Late night" : ""}${ctx.lateNight && ctx.depth >= W.DEEP_SESSION ? " · " : ""}${ctx.depth >= W.DEEP_SESSION ? `🔁 Video #${ctx.depth} this session` : ""}: hooks pull harder right now.</div>`
      : "";
    // Collapsed: a small, faded icon, with a quiet count only when there's junk food on the page.
    const html = `
      <button class="wi-panel-toggle" title="Worth It?">🧠${junk && !panelOpen ? `<span class="wi-dot">${junk}</span>` : ""}</button>
      ${panelOpen ? `<div class="wi-panel-body">${state}
        ${watch ? `<div class="wi-panel-state wi-counting">▶ This video: ${clock(watch.watchedSec)} watched so far.</div>` : ""}
        <div class="wi-panel-h">Most worth it on this page</div>
        ${picks.map((v) => `<div class="wi-pick" data-go="${esc(v.id)}"><b>${pct(v.s.worthIt)}</b><span>${esc(v.title)}</span></div>`).join("") || "<div class='wi-empty'>Scroll to load more videos.</div>"}
        <div class="wi-panel-foot">${junk} likely junk-food video${junk === 1 ? "" : "s"} ${settings.blur ? "blurred" : "flagged"} · hover a badge to see why</div>
      </div>` : ""}`;
    if (html !== panelHtml) panel.innerHTML = panelHtml = html;   // avoid re-triggering the observer
  }

  // ---- Liking: watch tracking and "Was that worth it?" ----------------------------------
  // Watch time is polled once a second from YouTube's *main* player. Polling (rather than
  // listening on one <video> found once) survives the player loading late or being swapped, and
  // the selector never matches the homepage hover-preview player, which reuses the same classes.
  const POLL_MS = 1000;
  let watch = null;   // {id, title, channel, hooks, ts, depth, watchedSec, durationSec}
  let tick = null, lastT = null, lastWall = null, checkpoint = null, metaTimer = null;

  const mainVideo = () => document.querySelector("#movie_player video") || document.querySelector("ytd-watch-flexy video");

  let missingPlayer = 0;
  function poll() {
    const v = mainVideo();
    const player = document.getElementById("movie_player");
    const now = Date.now();
    if (watch && !v && ++missingPlayer === 5) log("can't find YouTube's video player on this page");
    if (!watch || !v || v.paused || v.ended || (player && player.classList.contains("ad-showing"))) {
      lastT = v ? v.currentTime : null;
      lastWall = now;
      return;
    }
    missingPlayer = 0;
    const dt = v.currentTime - (lastT == null ? v.currentTime : lastT);
    const wall = (now - (lastWall == null ? now : lastWall)) / 1000;
    if (dt > 0 && dt <= wall * 2.5 + 1) watch.watchedSec += dt;   // real playback (≤2× speed), not a seek
    lastT = v.currentTime;
    lastWall = now;
    if (isFinite(v.duration) && v.duration > 0) watch.durationSec = Math.round(v.duration);
    if (panelOpen) schedulePanel();   // keep the "watched so far" line current while the panel is open
  }

  // Media events don't bubble, but a capturing listener on the document still sees them.
  document.addEventListener("ended", (e) => {
    if (watch && e.target === mainVideo()) endWatch();
  }, true);

  function readWatchMeta() {
    const h1 = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1");
    const title = (h1 && h1.textContent.trim()) || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").trim();
    const ch = document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, #channel-name a");
    return { title: title === "YouTube" ? "" : title, channel: ch ? ch.textContent.trim() : "" };
  }

  async function startWatch(id) {
    const c = await send("watchStart", { id });
    if (c) ctx = { depth: c.depth, lateNight: c.lateNight };
    // Coming back to a video you didn't finish continues the same viewing: same key, time adds up.
    const resume = c && c.resume;
    const now = Date.now();
    watch = { id, title: "", channel: "", hooks: [], ts: resume ? resume.ts : now, lastTs: now, depth: ctx.depth,
              watchedSec: resume ? resume.watchedSec : 0, durationSec: 0 };
    log("watching", id, resume ? `(continuing, ${resume.watchedSec}s so far)` : "", c ? "" : "(background not responding)");
    const mine = watch;
    let tries = 0;
    clearInterval(metaTimer);
    clearInterval(tick);
    lastT = lastWall = null;
    tick = setInterval(poll, POLL_MS);
    metaTimer = setInterval(async () => {   // the title renders a moment after navigation
      const m = readWatchMeta();
      if ((m.title && m.channel) || ++tries > 20) {
        clearInterval(metaTimer);
        if (watch !== mine) return;
        mine.title = m.title || info.get(id)?.title || "";
        mine.channel = m.channel;
        if (!thumbArousal.get(id)) {
          const a = await send("thumb", { id });
          if (a != null) thumbArousal.set(id, a);
        }
        mine.hooks = W.detectHooks(mine.title, thumbArousal.get(id) ?? undefined);
      }
    }, 500);
    clearInterval(checkpoint);
    checkpoint = setInterval(() => watch && watch.watchedSec >= MIN_WATCH_SEC && send("watchEnd", { watch: snapshot() }), 30000);
    schedulePanel();
  }

  const snapshot = () => ({ ...watch, watchedSec: Math.round(watch.watchedSec) });

  async function endWatch() {
    if (!watch) return;
    const w = snapshot();
    watch = null;
    clearInterval(tick);
    clearInterval(checkpoint);
    clearInterval(metaTimer);
    schedulePanel();
    log("left video", w.id, `${w.watchedSec}s watched`, w.watchedSec < MIN_WATCH_SEC ? `(under ${MIN_WATCH_SEC}s: not asking)` : "");
    if (w.watchedSec < MIN_WATCH_SEC) return;
    await send("watchEnd", { watch: w });
    if (await mayAsk(w)) showPrompt(w);
  }

  // How often to ask. Videos it doesn't ask about still teach it, from how much you watched.
  //   sometimes (default): after ≥ 1 minute of watching, at most once every 10 minutes
  //   often:               after every video watched ≥ 15 s
  const ASK = { often: { minSec: MIN_WATCH_SEC, gapMin: 0 }, sometimes: { minSec: 60, gapMin: 10 } };
  const askMode = () => (settings.askRating === false ? "never" : settings.askMode || "sometimes");
  async function mayAsk(w) {
    const rule = ASK[askMode()];
    if (!rule || prompt || w.watchedSec < rule.minSec) return false;
    const { lastAskTs = 0 } = await chrome.storage.local.get("lastAskTs");
    return Date.now() - lastAskTs >= rule.gapMin * 60000;
  }

  /** Ask about a recent unrated video, e.g. one whose tab you closed mid-watch. */
  async function askPending() {
    if (prompt || askMode() === "never") return;
    const p = await send("pendingRating");
    if (p && !prompt && (!watch || watch.id !== p.id) && (await mayAsk(p))) showPrompt(p);
  }

  let prompt = null;
  function showPrompt(w) {
    if (prompt) prompt.remove();
    let mood = null;
    chrome.storage.local.set({ lastAskTs: Date.now() });
    prompt = document.createElement("div");
    prompt.className = "wi-prompt";
    // Compact: one row of faces. Everything else is folded under "More".
    prompt.innerHTML = `
      <div class="wi-head"><div class="wi-q">Worth it?</div><button class="wi-x" title="Not now">×</button></div>
      <div class="wi-t">${esc(w.title || "That video")}</div>
      <div class="wi-rate">${[["😩", "Waste"], ["😕", "Meh"], ["😐", "OK"], ["🙂", "Good"], ["🤩", "Loved it"]]
        .map(([e, l], i) => `<button data-r="${i + 1}" title="${l}">${e}</button>`).join("")}</div>
      <button class="wi-more">More</button>
      <div class="wi-extra" hidden>
        <div class="wi-alt">
          <button data-a="partial" title="Counts as worth it, even though you didn't watch it all">✂️ Got what I needed</button>
          <button data-a="later" title="Nothing is learned now; I'll ask again when you finish it">⏸ Finishing later</button>
        </div>
        <div class="wi-mood"><span>Right now I feel</span>${[["calm", "😌"], ["good", "🙂"], ["tired", "😴"], ["stressed", "😣"]]
          .map(([m, e]) => `<button data-m="${m}">${e} ${m}</button>`).join("")}</div>
      </div>`;
    const close = (dismissed) => {
      if (!prompt) return;
      if (dismissed) send("dismiss", { id: w.id, ts: w.ts });
      prompt.remove();
      prompt = null;
    };
    let timer = setTimeout(() => close(true), 20000);
    prompt.addEventListener("click", (e) => {
      const m = e.target.closest("[data-m]");
      const r = e.target.closest("[data-r]");
      const a = e.target.closest("[data-a]");
      const thanks = (q) => {
        clearTimeout(timer);
        prompt.innerHTML = `<div class="wi-thanks">${q}</div>`;
        setTimeout(() => close(false), 1200);
      };
      if (e.target.closest(".wi-more")) {
        prompt.querySelector(".wi-extra").hidden = false;
        e.target.closest(".wi-more").remove();
        clearTimeout(timer);                          // opened the options: don't vanish mid-choice
        timer = setTimeout(() => close(true), 45000);
      } else if (m) {
        mood = mood === m.dataset.m ? null : m.dataset.m;
        prompt.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mood));
      } else if (r) {
        send("rate", { id: w.id, ts: w.ts, rating: +r.dataset.r, mood });
        thanks("Thanks");
      } else if (a && a.dataset.a === "partial") {
        send("rate", { id: w.id, ts: w.ts, rating: 4, mood, partial: true });
        thanks("Thanks");
      } else if (a && a.dataset.a === "later") {
        send("later", { id: w.id, ts: w.ts });
        thanks("OK, I'll ask when you finish it");
      } else if (e.target.closest(".wi-x")) {
        clearTimeout(timer);
        close(true);
      }
    });
    document.body.appendChild(prompt);
  }

  // ---- Page lifecycle --------------------------------------------------------------------
  async function onPage() {
    const c = await send("context");
    if (c) ctx = c;
    const id = location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
    if (id && (!watch || watch.id !== id)) {
      await endWatch();
      await startWatch(id);
    } else if (!id) {
      await endWatch();
    }
    scan();
    askPending();
  }

  // Navigation: YouTube is a single-page app, and its own navigation events aren't reliable from an
  // extension, so the URL is checked twice a second. Page changes run one at a time, in order.
  let lastUrl = null, pageQueue = Promise.resolve();
  function checkUrl() {
    if (location.href === lastUrl) return;
    const first = lastUrl === null;
    lastUrl = location.href;
    if (!first) flushImpressions();
    log("page", location.pathname + location.search);
    pageQueue = pageQueue.then(onPage, onPage);
  }
  for (const target of [window, document]) target.addEventListener("yt-navigate-finish", checkUrl);
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("pagehide", () => {
    flushImpressions();
    if (watch && watch.watchedSec >= MIN_WATCH_SEC) send("watchEnd", { watch: snapshot() });
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushImpressions());

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
    if (changes.model) model = changes.model.newValue || W.freshModel();
    if (changes.settings || changes.model) {
      info.clear();
      document.querySelectorAll("[data-wi-vid]").forEach((c) => delete c.dataset.wiVid);
      scan();
    }
  });

  (async () => {
    const s = await chrome.storage.local.get(["settings", "model"]);
    settings = { ...settings, ...(s.settings || {}) };
    model = s.model || model;
    checkUrl();
    setInterval(checkUrl, 500);
  })();
})();

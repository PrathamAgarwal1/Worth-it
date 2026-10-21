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

  let dead = false;   // set once the extension is reloaded and this copy of the script is orphaned
  let settings = { blur: true, badges: true, askRating: true, askMode: "bar", lambda: 1 };
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

  /** New context from the background; re-score the page if it changes any feature. */
  function setCtx(c) {
    if (!c) return;
    const changed = c.lateNight !== ctx.lateNight || (c.depth >= W.DEEP_SESSION) !== (ctx.depth >= W.DEEP_SESSION);
    ctx = { depth: c.depth, lateNight: c.lateNight };
    if (changed) rescore();
  }
  function rescore() {
    info.clear();
    document.querySelectorAll("[data-wi-vid]").forEach((c) => delete c.dataset.wiVid);
    scan();
  }

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
    // Every video gets a small chip with its worth-it %; the hook's name appears when you hover.
    const first = v.hooks[0] && W.BY_ID[v.hooks[0]];
    const more = v.hooks.length > 1 ? ` +${v.hooks.length - 1}` : "";
    const emojis = v.hooks.map((h) => W.BY_ID[h].emoji).join("");
    let cls = "wi-badge", icon = `${pct(v.s.worthIt)}${emojis ? ` ${emojis}` : ""}`, text = first ? `${first.label}${more}` : "";
    if (v.s.junk) {
      cls += " wi-badge-junk";
      text = `junk food · ${first.label}${more}`;
    } else if (v.s.worthIt >= W.WORTH_OK && v.s.evidence.enough) {
      // A good track record (from your own ratings) wins over packaging.
      cls += " wi-badge-good";
      icon = `✓ ${icon}`;
    }
    card.dataset.wiBadge = settings.badges ? "1" : "0";
    if (card.dataset.wiBadge === "0") {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      host.appendChild(badge);
    }
    badge.className = cls;
    badge.innerHTML = `<span class="wi-b-icon">${esc(icon)}</span>${text ? `<span class="wi-b-text">${esc(text)}</span>` : ""}`;
    badge.title = tooltip(v);
  }

  function processCard(card) {
    if (card.parentElement && card.parentElement.closest(CARD)) return;   // nested renderer; handled by outer card
    if (card.querySelector('a[href*="/shorts/"]')) return;
    const ci = cardInfo(card);
    if (!ci) {
      // YouTube recycles card elements; one that's emptied out mustn't keep the old video's marks.
      if (card.dataset.wiVid) {
        delete card.dataset.wiVid;
        card.classList.remove("wi-junk", "wi-blur");
        card.querySelectorAll(".wi-badge").forEach((b) => b.remove());
      }
      return;
    }
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
    if (scanTimer || dead) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      document.querySelectorAll(CARD).forEach(processCard);
      schedulePanel();
      ensureBar();   // YouTube re-renders the area under the player; put the bar back if it went
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

  // ---- Picks: a brain button in YouTube's top bar, opening a dropdown like YouTube's own menus -----
  // If the top bar can't be found, the button floats in the bottom-left corner instead.
  // Brain icon: Lucide (ISC licence), drawn in YouTube's icon style: 24 px, one colour, thin stroke.
  const BRAIN_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/>
    <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/>
    <path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>`;
  let btn = null, pop = null, panelOpen = false, panelTimer = null, popHtml = "";
  function schedulePanel() {
    if (panelTimer || dead) return;
    panelTimer = setTimeout(() => {
      panelTimer = null;
      renderPanel();
    }, 300);
  }

  function mastheadSlot() {
    const end = document.querySelector("ytd-masthead #end");
    if (!end || !isShown(end)) return null;
    const buttons = end.querySelector("#buttons");
    return buttons ? { parent: buttons, before: buttons.firstChild } : { parent: end, before: end.firstChild };
  }

  /** Put the button in the top bar (again, if YouTube re-drew it), or float it if there's no top bar. */
  function ensureButton() {
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wi-brain";
      btn.setAttribute("aria-label", "Worth It?");
      btn.setAttribute("aria-haspopup", "dialog");
      btn.setAttribute("aria-expanded", "false");
      btn.innerHTML = `${BRAIN_SVG}<span class="wi-count" hidden></span>`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();   // YouTube's top bar has its own click handling
        if (panelOpen) closePanel();
        else openPanel();
      });
    }
    const slot = mastheadSlot();
    btn.classList.toggle("wi-brain-float", !slot);
    if (slot && btn.parentElement !== slot.parent) slot.parent.insertBefore(btn, slot.before);
    else if (!slot && btn.parentElement !== document.body) document.body.appendChild(btn);
  }

  function openPanel() {
    panelOpen = true;
    renderPanel();
  }
  // An open dropdown closes when you click elsewhere, press Esc, or go to another page.
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    renderPanel();
  }
  document.addEventListener("click", (e) => {
    if (panelOpen && !(pop && pop.contains(e.target)) && !(btn && btn.contains(e.target))) closePanel();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !panelOpen) return;
    closePanel();
    btn.focus();
  }, true);
  window.addEventListener("resize", () => panelOpen && placePop());

  /** Under the button, right edges lined up (YouTube's menus do the same); above it when floating. */
  function placePop() {
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 16);
    const floating = btn.classList.contains("wi-brain-float");
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(floating ? r.left : r.right - w, innerWidth - w - 8))}px`;
    pop.style.top = floating ? "" : `${r.bottom + 4}px`;
    pop.style.bottom = floating ? `${innerHeight - r.top + 8}px` : "";
    pop.classList.toggle("wi-pop-up", floating);
  }

  const isShown = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  function renderPanel() {
    if (dead) return;
    ensureButton();
    // YouTube keeps the pages you came from (e.g. the home feed) in the DOM, hidden: skip those.
    const onPage = [...document.querySelectorAll("[data-wi-vid]")].filter(isShown).map((c) => info.get(c.dataset.wiVid)).filter(Boolean);
    const uniq = [...new Map(onPage.map((v) => [v.id, v])).values()];
    const junk = uniq.filter((v) => v.s.junk).length;

    // The button only changes what has to change, so it never flickers under the pointer.
    const count = btn.querySelector(".wi-count");
    const dot = junk && !panelOpen ? String(junk) : "";
    if (count.textContent !== dot) count.textContent = dot;
    count.hidden = !dot;
    const label = junk ? `Worth It? · ${junk} likely junk-food video${junk === 1 ? "" : "s"} on this page` : "Worth It?";
    if (btn.title !== label) btn.title = label;
    btn.setAttribute("aria-expanded", String(panelOpen));
    btn.classList.toggle("wi-on", panelOpen);

    if (!panelOpen) {
      if (pop) pop.classList.remove("wi-open");
      return;
    }
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "wi-pop";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", "Worth It?");
      pop.addEventListener("click", (e) => {
        const item = e.target.closest("[data-go]");
        if (item) {
          const link = document.querySelector(`[data-wi-vid="${item.dataset.go}"] a[href*="/watch?v="]`);
          closePanel();
          if (link) link.click();
          else location.href = `/watch?v=${item.dataset.go}`;
        } else if (e.target.closest("[data-report]")) {
          closePanel();
          send("openReport");
        }
      });
      document.body.appendChild(pop);
    }
    placePop();
    const picks = uniq.filter((v) => !v.s.junk).sort((a, b) => b.s.rank - a.s.rank).slice(0, 5);
    const state = ctx.lateNight || ctx.depth >= W.DEEP_SESSION
      ? `<div class="wi-pop-state">${ctx.lateNight ? "🌙 Late night" : ""}${ctx.lateNight && ctx.depth >= W.DEEP_SESSION ? " · " : ""}${ctx.depth >= W.DEEP_SESSION ? `🔁 Video #${ctx.depth} this session` : ""}: hooks pull harder right now.</div>`
      : "";
    const html = `
      <div class="wi-pop-head"><span>Most worth it on this page</span><button class="wi-pop-link" data-report>Your report</button></div>
      ${state}
      ${watch ? `<div class="wi-pop-state">▶ This video: ${clock(watch.watchedSec)} watched so far</div>` : ""}
      <div class="wi-pop-list">${picks.map((v) => `<button class="wi-pick" data-go="${esc(v.id)}"><b>${pct(v.s.worthIt)}</b><span>${esc(v.title)}</span></button>`).join("")
        || `<div class="wi-empty">${location.pathname.startsWith("/shorts") ? "Shorts aren't scored yet." : "No videos on this page yet. Scroll to load some."}</div>`}</div>
      ${junk ? `<div class="wi-pop-foot">${junk} likely junk-food video${junk === 1 ? "" : "s"} ${settings.blur ? "blurred" : "flagged"} · hover a badge to see why</div>` : ""}`;
    if (html !== popHtml) pop.innerHTML = popHtml = html;
    if (!pop.classList.contains("wi-open")) requestAnimationFrame(() => panelOpen && pop.classList.add("wi-open"));
  }

  // ---- Liking: watch tracking and "Was that worth it?" ----------------------------------
  // Watch time is polled once a second from YouTube's *main* player. Polling (rather than
  // listening on one <video> found once) survives the player loading late or being swapped, and
  // the selector never matches the homepage hover-preview player, which reuses the same classes.
  const POLL_MS = 1000;
  let watch = null;   // {id, title, channel, hooks, ts, depth, watchedSec, durationSec}
  let tick = null, lastT = null, lastWall = null, checkpoint = null, metaTimer = null;

  const mainVideo = () => document.querySelector("#movie_player video") || document.querySelector("ytd-watch-flexy video");

  let missingPlayer = 0, pausedSince = null;
  function poll() {
    const v = mainVideo();
    const player = document.getElementById("movie_player");
    const now = Date.now();
    if (watch && !v && ++missingPlayer === 5) log("can't find YouTube's video player on this page");
    if (watch && location.pathname !== "/watch" && miniplayerDone(v, now)) return endWatch();
    // Reached the end. YouTube's "ended" event doesn't always come (autoplay, end screens), so check here
    // too. visitSec guards the first moments of the next video, while the player still shows this one's end.
    if (watch && v && watch.visitSec >= 10 && (v.ended || (v.duration > 30 && v.currentTime >= v.duration - 1.5))) {
      return finishWatch();
    }
    if (!watch || !v || v.paused || v.ended || (player && player.classList.contains("ad-showing"))) {
      lastT = v ? v.currentTime : null;
      lastWall = now;
      return;
    }
    missingPlayer = 0;
    const dt = v.currentTime - (lastT == null ? v.currentTime : lastT);
    const wall = (now - (lastWall == null ? now : lastWall)) / 1000;
    if (dt > 0 && dt <= wall * 2.5 + 1) {   // real playback (≤2× speed), not a seek
      watch.watchedSec += dt;
      watch.visitSec += dt;
    }
    lastT = v.currentTime;
    lastWall = now;
    if (isFinite(v.duration) && v.duration > 0) watch.durationSec = Math.round(v.duration);
    if (panelOpen) schedulePanel();   // keep the "watched so far" line current while the panel is open
  }

  // Leaving the watch page while the video carries on in the miniplayer isn't leaving the video. It
  // ends when the miniplayer closes, or stays paused for a few seconds.
  const playingInMiniplayer = (v) => !!(v && !v.paused && !v.ended && isShown(v));
  function miniplayerDone(v, now) {
    if (!v || v.ended || !isShown(v)) return true;
    if (!v.paused) pausedSince = null;
    else if (pausedSince == null) pausedSince = now;
    return pausedSince != null && now - pausedSince >= 5000;
  }

  // Media events don't bubble, but a capturing listener on the document still sees them.
  // The video that ended on this page, and where: playing it again from earlier on is another visit.
  let endedId = null, endedAt = 0;
  function finishWatch() {
    const v = mainVideo();
    if (barState && barState.id === watch.id) {   // finished: the bar asks, quietly
      barState.ended = true;
      renderBar();
    }
    endedId = watch.id;
    endedAt = v ? v.currentTime : 0;
    endWatch();
  }
  document.addEventListener("ended", (e) => {
    if (watch && e.target === mainVideo()) finishWatch();
  }, true);
  function checkReplay() {
    const v = mainVideo();
    const id = location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
    if (watch || !endedId || id !== endedId || !v || v.paused || v.ended || v.currentTime > endedAt - 5) return;
    endedId = null;
    pageQueue = pageQueue.then(() => !watch && startWatch(id));
  }

  function readWatchMeta() {
    const h1 = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1");
    const title = (h1 && h1.textContent.trim()) || document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "").trim();
    const ch = document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, #channel-name a");
    const flexy = document.querySelector("ytd-watch-flexy");
    return { title: title === "YouTube" ? "" : title, channel: ch ? ch.textContent.trim() : "",
             videoId: flexy && flexy.getAttribute("video-id") };
  }
  let lastMeta = null;   // {id, title}: what the watch page showed for the previous video in this tab

  async function startWatch(id) {
    // The card you clicked already knows the title and channel, so the prompt is right even if you
    // leave at once. The watch page is used to confirm them, or when you came from a link.
    const card = info.get(id);
    const c = await send("watchStart", { id });
    setCtx(c);
    // Coming back to a video you didn't finish continues the same viewing: same key, time adds up.
    const resume = c && c.resume;
    const now = Date.now();
    watch = { id, title: "", channel: "", hooks: [], ts: resume ? resume.ts : now, lastTs: now, depth: ctx.depth,
              watchedSec: resume ? resume.watchedSec : 0, visitSec: 0, durationSec: 0,
              prevRating: resume && resume.rating != null ? resume.rating : null, prevPartial: !!(resume && resume.partial) };
    log("watching", id, resume ? `(continuing, ${resume.watchedSec}s so far)` : "", c ? "" : "(background not responding)");
    const mine = watch;
    endedId = null;
    pausedSince = null;
    if (card) Object.assign(mine, { title: card.title, channel: card.channel, hooks: card.hooks });
    barState = { id, rating: mine.prevRating, partial: mine.prevPartial, mood: (resume && resume.mood) || null, later: false, status: "",
                 pred: card ? card.s.worthIt : null, ended: false };
    renderBar();
    const prev = lastMeta;
    let tries = 0;
    clearInterval(metaTimer);
    clearInterval(tick);
    lastT = lastWall = null;
    tick = setInterval(poll, POLL_MS);
    metaTimer = setInterval(async () => {   // the title renders a moment after navigation
      const m = readWatchMeta();
      // After an in-app navigation YouTube shows the previous video's title for a moment.
      const stale = (m.videoId && m.videoId !== id) || (prev && prev.id !== id && m.title === prev.title);
      const done = m.title && m.channel && !stale;
      if (done || ++tries > 20) {
        clearInterval(metaTimer);
        if (watch !== mine) return;
        if (done) lastMeta = { id, title: m.title };
        mine.title = (done && m.title) || mine.title;
        mine.channel = (done && m.channel) || mine.channel;
        if (!mine.title) return;   // never found it: leave it untitled rather than guess
        if (!thumbArousal.get(id)) {
          const a = await send("thumb", { id });
          if (a != null) thumbArousal.set(id, a);
        }
        mine.hooks = W.detectHooks(mine.title, thumbArousal.get(id) ?? undefined);
        if (barState && barState.id === id) {
          barState.pred = W.score(model, mine.hooks, ctx, settings.lambda, mine.channel).worthIt;
          renderBar();
        }
      }
    }, 500);
    clearInterval(checkpoint);
    checkpoint = setInterval(() => watch && watch.watchedSec >= MIN_WATCH_SEC && send("watchEnd", { watch: snapshot(false) }), 30000);
    schedulePanel();
  }

  // ended: you left the video (vs. a checkpoint while it's still playing).
  const snapshot = (ended) => {
    const { visitSec, prevRating, prevPartial, answered, ...w } = watch;
    return { ...w, watchedSec: Math.round(watch.watchedSec), ended };
  };

  async function endWatch() {
    if (!watch) return;
    const w = snapshot(true);
    // What the popup needs to know beyond what's saved: your earlier answer, and whether you answered in the bar.
    const ask = { ...w, answered: watch.answered, prevRating: watch.prevRating, prevPartial: watch.prevPartial };
    watch = null;
    clearInterval(tick);
    clearInterval(checkpoint);
    clearInterval(metaTimer);
    schedulePanel();
    log("left video", w.id, `${w.watchedSec}s watched`, w.watchedSec < MIN_WATCH_SEC ? `(under ${MIN_WATCH_SEC}s: not asking)` : "");
    if (w.watchedSec < MIN_WATCH_SEC) return;
    await send("watchEnd", { watch: w });
    // The video you just left always wins over an older prompt still on screen.
    if (await mayAsk(ask, true)) showPrompt(ask);
    else send("skip", { id: w.id, ts: w.ts });   // not asking: don't bring it up later either
  }

  // How often to ask. Videos it doesn't ask about still teach it, from how much you watched.
  //   sometimes (default): after ≥ 1 minute of watching, at most once every 10 minutes
  //   often:               after every video watched ≥ 15 s
  const ASK = { often: { minSec: MIN_WATCH_SEC, gapMin: 0 }, sometimes: { minSec: 60, gapMin: 10 } };
  const askMode = () => (settings.askRating === false ? "never" : settings.askMode || "bar");
  async function mayAsk(w, replace = false) {
    const rule = ASK[askMode()];
    if (!rule || (prompt && !replace) || w.watchedSec < rule.minSec || w.answered) return false;
    try {
      const { lastAskTs = 0 } = await chrome.storage.local.get("lastAskTs");
      return Date.now() - lastAskTs >= rule.gapMin * 60000;
    } catch (e) {
      return false;   // extension was reloaded; this tab's script is orphaned
    }
  }

  /** Ask about a video you left in the last few minutes without being asked, e.g. by closing its tab. */
  async function askPending() {
    if (prompt || !ASK[askMode()]) return;
    const p = await send("pendingRating");
    if (p && !prompt && (!watch || watch.id !== p.id) && (await mayAsk(p))) showPrompt(p);
  }

  const FACES = [["😩", "Waste"], ["😕", "Meh"], ["😐", "OK"], ["🙂", "Good"], ["🤩", "Loved it"]];
  const MOODS = [["calm", "😌"], ["good", "🙂"], ["tired", "😴"], ["stressed", "😣"]];

  // ---- The bar under the video: rate any time, change your mind any time ---------------------
  let bar = null, barHtml = "";
  let barState = null;   // {id, rating, partial, mood, later, status, pred, ended} for the video on this page

  function barAnchor() {
    const below = document.querySelector("ytd-watch-flexy #below");
    if (below) return { parent: below, before: below.firstChild };
    const meta = document.querySelector("ytd-watch-flexy ytd-watch-metadata") || document.querySelector("ytd-watch-metadata");
    return meta && { parent: meta.parentElement, before: meta };
  }

  function ensureBar() {
    const want = !dead && barState && askMode() !== "never" && location.pathname === "/watch";
    const a = want && barAnchor();
    if (!a) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wi-bar";
      bar.addEventListener("click", onBarClick);
    }
    if (bar.parentElement !== a.parent || (a.before !== bar && bar.nextSibling !== a.before)) a.parent.insertBefore(bar, a.before);
  }

  function renderBar() {
    ensureBar();
    if (!bar || !barState) return;
    const b = barState;
    const face = (i) => `<button data-r="${i + 1}" title="${FACES[i][1]}" class="${!b.partial && b.rating === i + 1 ? "on" : ""}">${FACES[i][0]}</button>`;
    const status = b.status
      ? `<span class="wi-bar-ok">✓ ${esc(b.status)}</span>`
      : b.rating != null ? `<span class="wi-bar-note">Your rating from last time · tap to change</span>`
      : b.later ? `<span class="wi-bar-note">⏸ Finishing later</span>`
      : b.pred != null ? `<span class="wi-bar-note" title="Your personal model's guess: the chance you'll be glad you watched">Predicted for you: <b>${pct(b.pred)}</b></span>`
      : "";
    const html = `
      <div class="wi-bar-row">
        <span class="wi-bar-q">${b.ended && b.rating == null ? "Finished. Worth it?" : "Worth it?"}</span>
        <span class="wi-bar-faces">${FACES.map((_, i) => face(i)).join("")}</span>
        <button class="wi-bar-chip${b.partial ? " on" : ""}" data-a="partial" title="Counts as worth it, even though you didn't watch it all">✂️ Got what I needed</button>
        ${b.rating == null ? `<button class="wi-bar-chip${b.later ? " on" : ""}" data-a="later" title="Nothing is learned until you finish it">⏸ Finishing later</button>` : ""}
        <span class="wi-bar-status">${status}</span>
      </div>
      ${b.rating != null ? `<div class="wi-bar-row wi-bar-mood"><span>Right now I feel</span>${MOODS.map(([m, e]) =>
        `<button class="wi-bar-chip${b.mood === m ? " on" : ""}" data-m="${m}">${e} ${m}</button>`).join("")}</div>` : ""}`;
    bar.classList.toggle("wi-bar-nudge", b.ended && b.rating == null);
    if (html !== barHtml) bar.innerHTML = barHtml = html;
  }

  async function onBarClick(e) {
    const b = barState;
    const r = e.target.closest("[data-r]"), a = e.target.closest("[data-a]"), m = e.target.closest("[data-m]");
    if (!b || !(r || a || m)) return;
    const live = watch && watch.id === b.id ? snapshot(false) : null;   // lets it save a video not saved yet
    if (watch && watch.id === b.id) watch.answered = true;              // answered here: no popup for it
    if (prompt && closePrompt && promptId === b.id) closePrompt(false);
    if (r || (a && a.dataset.a === "partial")) {
      const had = b.rating != null;
      b.rating = r ? +r.dataset.r : 4;
      b.partial = !r;
      b.later = false;
      b.status = had ? "Updated" : "Saved";
      renderBar();
      await send("rate", { id: b.id, rating: b.rating, mood: b.mood, partial: b.partial, watch: live });
    } else if (a && a.dataset.a === "later") {
      b.later = true;
      renderBar();
      await send("later", { id: b.id, watch: live });
    } else if (m) {
      b.mood = b.mood === m.dataset.m ? null : m.dataset.m;
      b.status = "Saved";
      renderBar();
      await send("rate", { id: b.id, rating: b.rating, mood: b.mood, partial: b.partial, watch: live });
    }
  }

  const PROMPT_MS = 30000;
  let prompt = null, promptId = null;
  let closePrompt = null;
  function syncBar(id, patch) {
    if (!barState || barState.id !== id) return;
    Object.assign(barState, patch, { status: "Saved" });
    renderBar();
  }
  function showPrompt(w) {
    if (dead || !ASK[askMode()] || !alive()) return;
    if (closePrompt) closePrompt(true);
    promptId = w.id;
    let mood = null;
    chrome.storage.local.set({ lastAskTs: Date.now() });
    prompt = document.createElement("div");
    prompt.className = "wi-prompt";
    // Compact: one row of faces. Everything else is folded under "More".
    prompt.innerHTML = `
      <div class="wi-head"><div class="wi-q">Worth it?</div><button class="wi-x" title="Not now">×</button></div>
      <div class="wi-t">${esc(w.title || "That video")}</div>
      ${w.prevRating != null ? `<div class="wi-prev">Watched again · last time: ${w.prevPartial ? "✂️ got what I needed" : `${FACES[w.prevRating - 1][0]} ${FACES[w.prevRating - 1][1]}`}</div>` : ""}
      <div class="wi-rate">${FACES.map(([e, l], i) => `<button data-r="${i + 1}" title="${l}"${!w.prevPartial && w.prevRating === i + 1 ? ' class="on"' : ""}>${e}</button>`).join("")}</div>
      <button class="wi-more">More</button>
      <div class="wi-extra" hidden>
        <div class="wi-alt">
          <button data-a="partial" title="Counts as worth it, even though you didn't watch it all">✂️ Got what I needed</button>
          <button data-a="later" title="Nothing is learned now; I'll ask again when you finish it">⏸ Finishing later</button>
        </div>
        <div class="wi-mood"><span>Right now I feel</span>${[["calm", "😌"], ["good", "🙂"], ["tired", "😴"], ["stressed", "😣"]]
          .map(([m, e]) => `<button data-m="${m}">${e} ${m}</button>`).join("")}</div>
      </div>`;
    const el = prompt;
    const close = (dismissed) => {
      if (prompt !== el) return;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      if (dismissed) send("dismiss", { id: w.id, ts: w.ts });
      el.remove();
      prompt = closePrompt = null;
    };
    closePrompt = close;
    // Goes away on its own if ignored, but only while you can see it: never while the pointer is on it,
    // and not while the tab is in the background (it waits there until you come back).
    let timer = null, hovered = false;
    const arm = (ms) => {
      clearTimeout(timer);
      if (prompt === el && !hovered && document.visibilityState === "visible" && !el.querySelector(".wi-thanks")) {
        timer = setTimeout(() => close(true), ms);
      }
    };
    const onVisible = () => arm(PROMPT_MS);
    document.addEventListener("visibilitychange", onVisible);
    arm(PROMPT_MS);
    el.addEventListener("mouseenter", () => {
      hovered = true;
      clearTimeout(timer);
    });
    el.addEventListener("mouseleave", () => {
      hovered = false;
      arm(PROMPT_MS / 2);
    });
    prompt.addEventListener("click", (e) => {
      const m = e.target.closest("[data-m]");
      const r = e.target.closest("[data-r]");
      const a = e.target.closest("[data-a]");
      const thanks = (q) => {
        clearTimeout(timer);
        el.innerHTML = `<div class="wi-thanks">${q}</div>`;
        setTimeout(() => close(false), 1200);
      };
      if (e.target.closest(".wi-more")) {
        prompt.querySelector(".wi-extra").hidden = false;
        e.target.closest(".wi-more").remove();
        arm(PROMPT_MS * 2);                           // opened the options: don't vanish mid-choice
      } else if (m) {
        mood = mood === m.dataset.m ? null : m.dataset.m;
        prompt.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mood));
      } else if (r) {
        send("rate", { id: w.id, ts: w.ts, rating: +r.dataset.r, mood });
        syncBar(w.id, { rating: +r.dataset.r, partial: false, mood });
        thanks(w.prevRating != null ? "Updated" : "Thanks");
      } else if (a && a.dataset.a === "partial") {
        send("rate", { id: w.id, ts: w.ts, rating: 4, mood, partial: true });
        syncBar(w.id, { rating: 4, partial: true, mood });
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
    setCtx(await send("context"));
    const id = location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
    if (id && (!watch || watch.id !== id)) {
      await endWatch();
      await startWatch(id);
    } else if (!id && !playingInMiniplayer(mainVideo())) {
      await endWatch();
    }
    scan();
    askPending();
  }

  // Navigation: YouTube is a single-page app, and its own navigation events aren't reliable from an
  // extension, so the URL is checked twice a second. Page changes run one at a time, in order.
  let lastUrl = null, pageQueue = Promise.resolve();
  function checkUrl() {
    if (dead || location.href === lastUrl) return;
    const first = lastUrl === null;
    lastUrl = location.href;
    if (!first) {
      flushImpressions();
      closePanel();
    }
    log("page", location.pathname + location.search);
    pageQueue = pageQueue.then(onPage, onPage);
  }
  for (const target of [window, document]) target.addEventListener("yt-navigate-finish", checkUrl);
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("pagehide", () => {
    flushImpressions();
    if (watch && watch.watchedSec >= MIN_WATCH_SEC) send("watchEnd", { watch: snapshot(true) });
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushImpressions());

  const domObserver = new MutationObserver(scan);
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) settings = { ...settings, ...changes.settings.newValue };
    if (changes.model) model = changes.model.newValue || W.freshModel();
    if (changes.settings || changes.model) rescore();
    if (changes.settings) renderBar();
  });

  // After the extension is reloaded or updated, this copy of the script keeps running in open tabs
  // but can no longer read your settings. Shut it down so it can't act on stale ones.
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  let heartbeat = null;
  function shutDown() {
    dead = true;
    log("extension was reloaded: this tab's copy is stopping (refresh the tab to start the new one)");
    [heartbeat, tick, checkpoint, metaTimer].forEach(clearInterval);
    domObserver.disconnect();
    observer.disconnect();
    watch = null;
    for (const el of [prompt, btn, pop, bar]) if (el) el.remove();
    prompt = btn = pop = bar = null;
  }

  (async () => {
    const s = await chrome.storage.local.get(["settings", "model"]);
    settings = { ...settings, ...(s.settings || {}) };
    model = s.model || model;
    checkUrl();
    heartbeat = setInterval(() => {
      if (!alive()) return shutDown();
      checkUrl();
      checkReplay();
    }, 500);
  })();
})();

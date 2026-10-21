/*
 * Hook detector: finds the psychological "pull" cues in a YouTube title (and thumbnail).
 *
 * Each hook is a cue that research links to *wanting* (attention, clicking) more than to
 * *liking* (being glad you watched). Detection is rule-based and English-only by design:
 * it runs instantly, offline, and every flag can be explained to the user.
 */
(function (root) {
  "use strict";

  const HOOKS = [
    {
      id: "curiosity_gap",
      label: "Curiosity gap",
      emoji: "🕳️",
      theory: "Information-gap theory (Loewenstein, 1994)",
      explain: "Opens a gap in what you know and withholds the answer, so clicking feels like scratching an itch.",
      patterns: [
        /\byou won'?t believe\b/i,
        /\bwhat happen(s|ed)\b/i,
        /\bwhat (he|she|they|i|we) (found|saw|did|said)\b/i,
        /\bthe (truth|real reason|secret|reason why)\b/i,
        /\b(nobody|no one) (tells|talks|knows|expected|saw)\b/i,
        /\b(here'?s|this is|that'?s) (why|what|how)\b/i,
        /\b(revealed|reveals?|exposing the|mystery|hidden)\b/i,
        /\b(wait (for|until|till)|watch (until|till)) (it|the end)\b/i,
        /\b(guess what|find out|you'?ll never guess)\b/i,
        /\bthis video (is|will)\b/i,
        /\b(you need to|you have to) (see|know|watch)\b/i,
        /\bthis (one|thing|trick|changes everything|is crazy)\b/i,
        /\bi (tried|tested)\b.*\b(so you don'?t have to|for \d+ days)\b/i,
        /(\.\.\.|…)\s*$/,
      ],
    },
    {
      id: "outrage",
      label: "Outrage & conflict",
      emoji: "😡",
      theory: "Negativity bias; moral-emotional language spreads faster (Brady et al., 2017)",
      explain: "Anger and conflict grab attention automatically, but rarely leave you feeling better.",
      patterns: [
        /\b(destroy(s|ed)?|disgusting|exposed|scam(med)?|ruin(s|ed)?|cancel(l)?ed|betray(s|ed|al))\b/i,
        /\b(slam(s|med)?|owned|humiliat\w*|furious|outrage\w*|lied|lies|liar|fraud|hypocri\w*)\b/i,
        /\b(drama|feud|beef|called out|clap(s|ped)? back)\b/i,
        /\b(worst|toxic|pathetic|embarrassing|cringe)\b/i,
      ],
    },
    {
      id: "fear",
      label: "Fear & threat",
      emoji: "⚠️",
      theory: "Threat detection: the brain prioritises possible danger",
      explain: "Warnings and 'you're doing it wrong' frames trigger a protective urge to check.",
      patterns: [
        /\b(warning|danger(ous)?|terrifying|horrifying|scary|deadly|nightmare|disaster|collapse)\b/i,
        /\b(stop (doing|using|eating|buying)|don'?t (do|buy|use|eat|watch|make) (this|these|that))\b/i,
        /\bnever (share|tell|trust|do|say|buy|eat)\b/i,
        /\b(you'?re|you are|you'?ve been) \w+ing\b.{0,30}\bwrong\b/i,
        /\b(before it'?s too late|is coming for|will (kill|destroy|ruin))\b/i,
      ],
    },
    {
      id: "urgency",
      label: "Urgency & FOMO",
      emoji: "⏰",
      theory: "Scarcity principle (Cialdini); fear of missing out",
      explain: "Makes it feel like now-or-never, which short-circuits the 'do I actually want this?' check.",
      patterns: [
        /\b(before (it'?s|they) (deleted|removed|gone|banned))\b/i,
        /\b(breaking|just (happened|announced|dropped)|right now|last chance|hurry|urgent|finally)\b/i,
        /\b(leaked|banned)\b/i,                      // "deleted" alone is too common ("I deleted Instagram")
        /\b(i'?m begging you|you need this|watch (this )?before)\b/i,
        /\b(today only|limited time|ends (today|soon))\b/i,
      ],
    },
    {
      id: "social_proof",
      label: "Social proof",
      emoji: "👥",
      theory: "Social proof (Cialdini): we copy what others seem to be doing",
      explain: "'Everyone is watching' signals you're missing something the group already has.",
      patterns: [
        /\b(everyone|everybody|the internet|twitter|tiktok) (is|are) (talking|obsessed|losing|going)\b/i,
        /\b(viral|trending|went viral|broke the internet|million(s)? of people)\b/i,
        /\b(most (watched|viewed|popular)|#1)\b/i,
      ],
    },
    {
      id: "hype",
      label: "Hype & superlatives",
      emoji: "🚀",
      theory: "Novelty and arousal amplify incentive salience (Berridge & Robinson)",
      explain: "Extreme words and huge numbers promise a peak experience the video usually can't deliver.",
      patterns: [
        /\b(insane|insanely|craziest|crazy|unbelievable|mind[- ]?blowing|epic|ultimate|legendary|extreme)\b/i,
        /\b((will|could|might|is going to) change your (life|mind)|changed my life|life[- ]changing)\b/i,
        /\b(best (ever|in the world)|world'?s (best|biggest|first|most|largest|smallest|hardest)|of all time)\b/i,
        /\$\s?\d{1,3}(,\d{3})+|\$\s?\d+\s?(k|m|million|billion)\b/i,
        /\b(1,?000,?000|100,?000|\d+ (days|hours) (straight|in a row))\b/i,
        /\b100%\b/,
      ],
    },
    {
      id: "shouting",
      label: "Shouting (CAPS & !!!)",
      emoji: "📢",
      theory: "Perceptual salience: loud-looking text captures attention before meaning does",
      explain: "Capital letters, '!!!' and emoji walls are built to be noticed, not to inform.",
      test: (title) => {
        const words = (title.match(/[A-Za-z][A-Za-z']*/g) || []).map((w) => w.replace(/'/g, "")).filter((w) => w.length >= 3);
        const caps = words.filter((w) => w === w.toUpperCase() && !ACRONYMS.has(w));
        const emoji = (title.match(/\p{Extended_Pictographic}/gu) || []).length;
        return caps.some((w) => w.length >= 4) || (words.length >= 2 && caps.length / words.length >= 0.4) ||
          /[!?]{2,}/.test(title) || emoji >= 3;
      },
    },
    {
      id: "loud_thumbnail",
      label: "Loud thumbnail",
      emoji: "🎨",
      theory: "Cue reactivity: vivid, high-contrast cues trigger 'wanting' on sight",
      explain: "Saturated colours and harsh contrast are attention bait, measured from the thumbnail's pixels.",
    },
  ];

  // All-caps words that are names, not shouting.
  const ACRONYMS = new Set(["NASA", "NATO", "FIFA", "UEFA", "ASMR", "HTML", "JSON", "LEGO", "IKEA", "NBA", "NFL", "UFC", "USA",
                            "BBC", "CNN", "GTA", "API", "CEO", "DIY", "FAQ", "GPU", "CPU", "AMA", "NYC", "TED", "MIT", "AWS"]);

  const HOOK_IDS = HOOKS.map((h) => h.id);
  const BY_ID = Object.fromEntries(HOOKS.map((h) => [h.id, h]));
  const LOUD_THUMBNAIL_THRESHOLD = 0.55;

  /** Returns the ids of hooks present in a title (and thumbnail, if its arousal is known). */
  function detectHooks(title, thumbArousal) {
    const t = (title || "").replace(/[‘’]/g, "'").trim();   // YouTube titles often use curly quotes
    const found = [];
    for (const h of HOOKS) {
      if (h.patterns && h.patterns.some((re) => re.test(t))) found.push(h.id);
      else if (h.test && h.test(t)) found.push(h.id);
    }
    if (typeof thumbArousal === "number" && thumbArousal >= LOUD_THUMBNAIL_THRESHOLD) found.push("loud_thumbnail");
    return found;
  }

  /**
   * Thumbnail arousal in [0, 1] from RGBA pixels: share of vivid pixels, mean saturation and
   * luminance contrast. Computed on a tiny downscaled copy, so it is cheap.
   */
  function thumbnailArousal(rgba) {
    let n = 0, satSum = 0, vivid = 0, lumSum = 0, lumSq = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      satSum += sat;
      lumSum += lum;
      lumSq += lum * lum;
      if (sat > 0.6 && max > 0.55) vivid++;
      n++;
    }
    if (!n) return 0;
    const meanSat = satSum / n;
    const contrast = Math.sqrt(Math.max(0, lumSq / n - (lumSum / n) ** 2));
    const score = 0.5 * Math.min(1, (vivid / n) / 0.5) + 0.3 * Math.min(1, meanSat / 0.7) + 0.2 * Math.min(1, contrast / 0.3);
    return Math.round(score * 1000) / 1000;
  }

  const api = { HOOKS, HOOK_IDS, BY_ID, detectHooks, thumbnailArousal, LOUD_THUMBNAIL_THRESHOLD };
  root.WorthIt = Object.assign(root.WorthIt || {}, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

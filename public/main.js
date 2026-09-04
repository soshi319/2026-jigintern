import Hls from "hls.js";

const STREAM_URL = "https://intern-hls-server.tomaton.workers.dev/stream.m3u8";
const COMMENT_STREAM_URL = "https://intern-comment-server.intern-comment-server.deno.net/events";
const COMMENT_POST_URL = "https://intern-comment-server.intern-comment-server.deno.net/messages";
const ITEMS_URL = "https://intern-comment-server.intern-comment-server.deno.net/items";
const HLS_ORIGIN = new URL(STREAM_URL).origin;
const CHANNELS_URL = `${HLS_ORIGIN}/channels.json`;

// cost is one of 10 / 50 / 150 / 400 / 1000 across the whole catalog — five tiers, cheap (cool) to expensive (warm).
// bgItemOnly (light mode) is a solid color matching what rgba(rgb, 0.26) used to look like composited
// over the light surface — picked via a color picker against that old translucent rendering, then
// hardcoded so the look doesn't drift if the surface color ever changes. It's the fill for both the
// item-only Comment and the outer frame of an item-with-text Comment (see CONTEXT.md's Comment entry) —
// both read as "the Item's usual color," with only the nested text bubble in the latter breaking from it.
// Dark mode uses `rgb` itself (full saturation) for that same fill instead — favoring a strongly colored
// Item part over legibility of the item-only sentence against it.
// bgItemWithTextDark — `rgb` blended ~35% toward white — is the Item Ticker's resting (non-hover) tone;
// blending toward white less aggressively than the light-mode set keeps it standing out against a
// near-black surface instead of washing out.
const COST_TIERS = [
  { max: 10, rgb: "56, 189, 248", text: "#0369a1", flashAlpha: 0.25, bgItemOnly: "#CBEEFD", bgItemWithTextDark: "#7ED4FA" },
  { max: 50, rgb: "34, 197, 94", text: "#15803d", flashAlpha: 0.32, bgItemOnly: "#C6F0D5", bgItemWithTextDark: "#6FD996" },
  { max: 150, rgb: "234, 179, 8", text: "#a16207", flashAlpha: 0.4, bgItemOnly: "#FAEBBF", bgItemWithTextDark: "#F1CE5E" },
  { max: 400, rgb: "249, 115, 22", text: "#c2410c", flashAlpha: 0.48, bgItemOnly: "#FDDBC3", bgItemWithTextDark: "#FBA468" },
  { max: 1000, rgb: "236, 72, 153", text: "#be185d", flashAlpha: 0.58, bgItemOnly: "#FAD0E5", bgItemWithTextDark: "#F388BD" },
];

function tierForCost(cost) {
  return COST_TIERS.find((tier) => cost <= tier.max) ?? COST_TIERS[COST_TIERS.length - 1];
}

// duration grows linearly with cost, so newly-added items don't need a hardcoded entry.
const TICKER_BASE_MS = 10000;
const TICKER_MS_PER_COST = 15;

function tickerDurationForCost(cost) {
  return TICKER_BASE_MS + cost * TICKER_MS_PER_COST;
}

function initPlayer() {
  const video = document.getElementById("player");
  const playOverlay = document.getElementById("video-play-overlay");
  if (!video) return null;

  let hls = null;

  if (Hls.isSupported()) {
    // hls.js defaults to targeting a position 3 segments behind the
    // playlist's true edge, as a stall-avoidance buffer. Lowered here so
    // playback stays closer to the real live edge, at the cost of being more
    // likely to briefly buffer right after a seek/start.
    hls = new Hls({ liveSyncDurationCount: 1 });
    hls.loadSource(STREAM_URL);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          hls.destroy();
          break;
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = STREAM_URL;
  } else {
    video.replaceWith(
      Object.assign(document.createElement("p"), {
        textContent: "お使いのブラウザはこの配信の再生に対応していません。",
      }),
    );
    if (playOverlay) playOverlay.hidden = true;
    return null;
  }

  if (playOverlay) {
    // Mirrors the video's own play/pause state rather than a one-shot "first
    // play" prompt, so pausing (however it happens — the overlay, the native
    // controls, a keyboard shortcut) always brings the big center button back.
    playOverlay.addEventListener("click", () => playFromLive());
    video.addEventListener("play", () => {
      playOverlay.hidden = true;
    });
    video.addEventListener("pause", () => {
      playOverlay.hidden = false;
    });
  }

  // hls.js branch: hls.liveSyncPosition is the edge hls.js itself targets
  // (accounts for its own live-sync-duration config above). Native-Safari
  // HLS has no hls.js instance at all, so that branch falls back to the end
  // of the seekable range, the only edge signal a plain <video> exposes.
  const getLiveEdge = () => {
    if (hls && typeof hls.liveSyncPosition === "number") return hls.liveSyncPosition;
    if (video.seekable && video.seekable.length > 0) {
      return video.seekable.end(video.seekable.length - 1);
    }
    return null;
  };

  // Resuming playback always jumps to the live edge first. Without this,
  // clicking play again after a pause just resumes from wherever the video
  // was paused — for a live stream that spot only gets staler the longer
  // it's paused, and may already have fallen out of the buffer entirely.
  const playFromLive = () => {
    const edge = getLiveEdge();
    if (edge != null) video.currentTime = edge;
    // A channel switch (or another quick play/pause) can supersede this
    // play() with a new load before it resolves, rejecting it with an
    // AbortError — expected, not an error worth surfacing.
    video.play().catch(() => {});
  };

  initBufferingIndicator(video);
  initPictureInPicture(video);
  initPlayPauseControl(video, playFromLive);
  initVolumeControl(video);
  initFullscreenControl();
  initControlsBarVisibility(video);
  initPlayerKeyboardShortcuts(video, playFromLive);

  // Switches to a different channel's playlist on the same <video>/hls.js
  // instance, rather than tearing down and re-running initPlayer — keeps
  // volume, fullscreen, PiP, etc. untouched across the switch. Playback only
  // resumes automatically if it was already playing (a deliberate channel
  // change while watching, not the page's own autoplay-on-load).
  const switchChannel = (url) => {
    const wasPlaying = !video.paused;
    if (hls) {
      hls.loadSource(url);
      if (wasPlaying) {
        hls.once(Hls.Events.MANIFEST_PARSED, () => playFromLive());
      }
    } else {
      video.src = url;
      video.load();
      if (wasPlaying) playFromLive();
    }
  };

  return switchChannel;
}

function initPlayPauseControl(video, playFromLive) {
  const btn = document.getElementById("video-playpause-btn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    if (video.paused) playFromLive();
    else video.pause();
  });

  video.addEventListener("play", () => {
    btn.classList.add("is-playing");
    btn.setAttribute("aria-label", "一時停止");
  });
  video.addEventListener("pause", () => {
    btn.classList.remove("is-playing");
    btn.setAttribute("aria-label", "再生");
  });
}

function initVolumeControl(video) {
  const muteBtn = document.getElementById("video-mute-btn");
  const slider = document.getElementById("video-volume-slider");
  if (!muteBtn || !slider) return;

  const sync = () => {
    const effectivelyMuted = video.muted || video.volume === 0;
    const value = effectivelyMuted ? 0 : video.volume;
    slider.value = value;
    slider.style.setProperty("--volume-pct", `${value * 100}%`);
    muteBtn.classList.toggle("is-muted", effectivelyMuted);
    muteBtn.setAttribute("aria-label", effectivelyMuted ? "ミュート解除" : "ミュート");
  };

  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    // Unmuting a video whose volume was dragged to 0 would otherwise stay silent.
    if (!video.muted && video.volume === 0) video.volume = 1;
    sync();
  });

  slider.addEventListener("input", () => {
    video.volume = Number(slider.value);
    video.muted = video.volume === 0;
    sync();
  });

  video.addEventListener("volumechange", sync);
  sync();
}

function initFullscreenControl() {
  const area = document.getElementById("video-area");
  const btn = document.getElementById("video-fullscreen-btn");
  if (!area || !btn) return;

  if (!document.fullscreenEnabled) {
    btn.hidden = true;
    return;
  }

  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      // Fullscreening the container (not the bare <video>) keeps this whole
      // custom control bar — and the live badge, PiP button, etc. — usable
      // while fullscreen, instead of handing the OS a raw video surface.
      area.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener("fullscreenchange", () => {
    const isFullscreen = document.fullscreenElement === area;
    btn.classList.toggle("is-fullscreen", isFullscreen);
    btn.setAttribute("aria-label", isFullscreen ? "全画面表示を終了" : "全画面表示");
  });
}

// Auto-hides the bottom control bar after inactivity, matching the "controls
// fade away while watching" convention of native video players. Stays shown
// while paused (nothing to hide from) or while a control inside it has focus
// (e.g. dragging the volume slider). On touch, there's no hover to drive this,
// so tapping the bare video toggles the bar instead of pausing (see the click
// handler below) — this is also where clicking the bare video pauses
// playback on desktop, since both share the same "what does a click on the
// video itself do" decision and the touch/mouse distinction it depends on.
function initControlsBarVisibility(video) {
  const area = document.getElementById("video-area");
  const bar = document.getElementById("video-controls-bar");
  if (!area || !bar) return;

  const HIDE_DELAY_MS = 2500;
  let hideTimer = null;
  let isTouch = false;

  const show = () => {
    area.classList.add("show-controls");
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    if (video.paused || bar.contains(document.activeElement)) return;
    hideTimer = setTimeout(() => {
      area.classList.remove("show-controls");
    }, HIDE_DELAY_MS);
  };
  const bump = () => {
    show();
    scheduleHide();
  };

  area.addEventListener("mousemove", () => {
    if (isTouch) return;
    bump();
  });
  area.addEventListener("mouseleave", () => {
    if (isTouch || video.paused) return;
    area.classList.remove("show-controls");
  });

  area.addEventListener("touchstart", () => {
    isTouch = true;
  }, { passive: true });

  video.addEventListener("click", () => {
    if (isTouch) {
      area.classList.toggle("show-controls");
      if (area.classList.contains("show-controls")) scheduleHide();
      else clearTimeout(hideTimer);
      return;
    }
    // Desktop: clicking the bare video pauses playback, matching the common
    // click-to-pause convention. Resuming is via the center overlay button
    // or the bar's play/pause button, not a second click on the video.
    if (!video.paused) video.pause();
  });

  video.addEventListener("play", bump);
  video.addEventListener("pause", show);
  bar.addEventListener("focusin", show);
  bar.addEventListener("focusout", scheduleHide);

  show();
}

// Only acts while focus is inside the video area, so typing " " in the
// comment textarea elsewhere on the page is never hijacked into a play/pause.
function initPlayerKeyboardShortcuts(video, playFromLive) {
  const area = document.getElementById("video-area");
  const muteBtn = document.getElementById("video-mute-btn");
  const fullscreenBtn = document.getElementById("video-fullscreen-btn");
  if (!area) return;

  area.addEventListener("keydown", (event) => {
    // These are bare-key shortcuts, so a held modifier means the press belongs
    // to something else. Without this, Alt+M inside the video area would match
    // "m" here AND the Global Shortcut on document as the event bubbles up:
    // two muteBtn.click() calls for one press, toggling mute straight back off.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case " ":
      case "Enter":
        // A focused button already handles its own Enter/Space press;
        // only the bare area (nothing more specific focused) does it here.
        if (event.target !== area) return;
        event.preventDefault();
        if (video.paused) playFromLive();
        else video.pause();
        break;
      case "m":
      case "M":
        muteBtn?.click();
        break;
      case "f":
      case "F":
        fullscreenBtn?.click();
        break;
      case "ArrowUp":
        event.preventDefault();
        video.muted = false;
        video.volume = Math.min(1, video.volume + 0.05);
        break;
      case "ArrowDown":
        event.preventDefault();
        video.volume = Math.max(0, video.volume - 0.05);
        break;
      default:
        break;
    }
  });
}

// A Combo names a key by its physical position (event.code), not by the
// character it produces: holding Option on a Mac turns event.key for Option+T
// into "†", while event.code stays "KeyT" whatever the layout or modifiers
// (https://www.w3.org/TR/uievents/#dom-keyboardevent-code). Combos are matched
// and compared in that form ("Alt+KeyT") and converted to a viewer-facing
// label ("Option+T") only at render time — see formatCombo.
const IS_MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");

// Modifiers are always emitted in this order, so the same keypress always
// produces the same string and two Combos can be compared with ===.
const COMBO_MODIFIERS = [
  ["ctrlKey", "Ctrl"],
  ["altKey", "Alt"],
  ["shiftKey", "Shift"],
  ["metaKey", "Meta"],
];

const MODIFIER_LABELS = {
  Ctrl: () => (IS_MAC ? "Control" : "Ctrl"),
  Alt: () => (IS_MAC ? "Option" : "Alt"),
  Shift: () => "Shift",
  Meta: () => (IS_MAC ? "Command" : "Win"),
};

// Only codes whose label isn't already derivable by formatCombo's KeyX/DigitX rules.
const KEY_LABELS = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

function comboFromEvent(event) {
  const parts = COMBO_MODIFIERS.filter(([property]) => event[property]).map(([, name]) => name);
  parts.push(event.code);
  return parts.join("+");
}

function formatCombo(combo) {
  const parts = combo.split("+");
  const code = parts.pop();
  const labels = parts.map((name) => MODIFIER_LABELS[name]?.() ?? name);

  if (KEY_LABELS[code]) labels.push(KEY_LABELS[code]);
  else if (code.startsWith("Key")) labels.push(code.slice(3));
  else if (code.startsWith("Digit")) labels.push(code.slice(5));
  else labels.push(code);

  return labels.join(" + ");
}

// A Combo holding neither Alt nor Ctrl types a character, so firing it while
// the viewer is mid-sentence would both swallow the keystroke and trigger an
// unrelated action.
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

// The Shortcut Panel's own Combo is deliberately fixed — the panel is the only
// place a Combo can be reassigned, so losing the key that opens it would be
// hard to recover from — hence it sits here rather than in a reassignable set.
const PANEL_COMBO = "Shift+Slash";

// Global Shortcuts fire wherever focus happens to be, the comment textarea
// included — pausing the stream mid-sentence is precisely what this feature
// exists for. That makes the preventDefault in initGlobalShortcuts load-bearing
// rather than cosmetic: it stops macOS inserting the Option character
// (Option+T types "†"), and it suppresses the browsers' own Alt accelerators
// (Alt+D focuses the address bar, Alt+F opens the menu, in Chrome, Edge and
// Firefox alike). Those two are absent from every browser's reserved-key list,
// so a cancelled keydown really does suppress them.
const GLOBAL_SHORTCUTS = [
  // Alt+K, not the Alt+Space you'd expect: on Windows, Alt+Space is swallowed
  // before the page ever sees it (it's the window system menu) and measurably
  // opens the browser's own menu instead. K is the key YouTube uses for the
  // same action and appears in no browser's accelerator table.
  { id: "playPause", label: "再生 / 一時停止", defaultCombo: "Alt+KeyK" },
  { id: "focusComment", label: "コメント入力欄にフォーカス", defaultCombo: "Alt+KeyT" },
  { id: "toggleItems", label: "アイテムパネルの開閉", defaultCombo: "Alt+KeyI" },
  { id: "fullscreen", label: "全画面表示の切り替え", defaultCombo: "Alt+KeyF" },
  { id: "mute", label: "ミュート切り替え", defaultCombo: "Alt+KeyM" },
  { id: "theme", label: "ダークモード切り替え", defaultCombo: "Alt+KeyD" },
];

// Each action drives the very control a pointer would use, so the aria-label
// and class bookkeeping every init* function does for its own button stays in
// that one place and can't drift out of sync with the keyboard path.
// initPlayerKeyboardShortcuts already works this way.
const GLOBAL_SHORTCUT_ACTIONS = {
  playPause: () => document.getElementById("video-playpause-btn")?.click(),
  focusComment: () => document.getElementById("comment-input")?.focus(),
  toggleItems: () => document.getElementById("item-toggle-btn")?.click(),
  fullscreen: () => document.getElementById("video-fullscreen-btn")?.click(),
  mute: () => document.getElementById("video-mute-btn")?.click(),
  theme: () => document.getElementById("theme-toggle-btn")?.click(),
};

// Only shortcuts that actually work today, so this list never advertises a key
// that does nothing.
const PLAYER_SHORTCUTS = [
  { label: "再生 / 一時停止", combos: ["Space", "Enter"] },
  { label: "ミュート切り替え", combos: ["KeyM"] },
  { label: "全画面表示の切り替え", combos: ["KeyF"] },
  { label: "音量を上げる", combos: ["ArrowUp"] },
  { label: "音量を下げる", combos: ["ArrowDown"] },
];

// Combos a Global Shortcut may never take, mapped to whatever already owns
// them. Player Shortcuts belong in here because a single press would run both
// handlers — the Player one on #video-area, then the Global one on document as
// the event bubbles through — clicking the same button twice and undoing
// itself, which reads as the shortcut being broken rather than taken.
const RESERVED_COMBOS = new Map([
  ...PLAYER_SHORTCUTS.flatMap((shortcut) =>
    shortcut.combos.map((combo) => [combo, `${shortcut.label}（動画エリア選択中）`]),
  ),
  [PANEL_COMBO, "ショートカット一覧を開く / 閉じる"],
]);

const SHORTCUT_STORAGE_KEY = "shortcuts";

// A Combo carrying none of Alt/Ctrl/Meta produces a character, which means it
// can't fire while the viewer is typing without eating the keystroke. Assigning
// one is allowed — just warned about, in the panel and on the row itself.
function comboTypesCharacter(combo) {
  const modifiers = combo.split("+").slice(0, -1);
  return !modifiers.some((modifier) => modifier === "Alt" || modifier === "Ctrl" || modifier === "Meta");
}

// The viewer's own assignments claim their Combos first; the defaults then fill
// whatever gaps are left, and a default whose Combo is already spoken for
// leaves that action unassigned rather than taking it back. That only matters
// when a newly added action ships a default the viewer had already bound
// elsewhere — and silently overwriting their own choice is the worse outcome.
function loadShortcutAssignments() {
  let stored = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    // Corrupt or hand-edited: fall back to the defaults rather than break the page.
  }

  const assignments = {};
  const taken = new Set();

  for (const shortcut of GLOBAL_SHORTCUTS) {
    if (!(shortcut.id in stored)) continue;
    const combo = stored[shortcut.id];
    if (combo === null) {
      assignments[shortcut.id] = null;
    } else if (typeof combo === "string" && combo && !RESERVED_COMBOS.has(combo) && !taken.has(combo)) {
      assignments[shortcut.id] = combo;
      taken.add(combo);
    }
  }

  for (const shortcut of GLOBAL_SHORTCUTS) {
    if (shortcut.id in assignments) continue;
    const free = !taken.has(shortcut.defaultCombo);
    assignments[shortcut.id] = free ? shortcut.defaultCombo : null;
    if (free) taken.add(shortcut.defaultCombo);
  }

  return assignments;
}

const SHORTCUT_ASSIGNMENTS = loadShortcutAssignments();

function saveShortcutAssignments() {
  try {
    localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(SHORTCUT_ASSIGNMENTS));
  } catch {
    // Storage blocked or full (private browsing): the change still takes effect
    // for this session, it just won't survive a reload.
  }
}

// What already owns this Combo, or null when it's free to take.
function shortcutConflict(combo, exceptId) {
  const reserved = RESERVED_COMBOS.get(combo);
  if (reserved) return reserved;

  const clash = GLOBAL_SHORTCUTS.find(
    (shortcut) => shortcut.id !== exceptId && SHORTCUT_ASSIGNMENTS[shortcut.id] === combo,
  );
  return clash ? clash.label : null;
}

// Rebuilt on every render rather than held as a constant, since a row's Combo
// and its warning both change as the viewer reassigns keys.
function shortcutSections() {
  return [
    {
      title: "全体",
      note: "フォーカスがどこにあっても有効です。",
      rows: [
        ...GLOBAL_SHORTCUTS.map((shortcut) => {
          const combo = SHORTCUT_ASSIGNMENTS[shortcut.id];
          return {
            id: shortcut.id,
            label: shortcut.label,
            combos: combo ? [combo] : [],
            note:
              combo && comboTypesCharacter(combo)
                ? "Alt も Ctrl も含まないため、コメント入力中は効きません。"
                : null,
            editable: true,
          };
        }),
        // display overrides the derived "Shift + /", since a viewer thinks of
        // this key as "?" — the character printed on it — not as its two parts.
        {
          label: "ショートカット一覧を開く / 閉じる",
          combos: [PANEL_COMBO],
          display: ["?"],
          note: "文字を打ち込むキーなので、コメント入力中だけは効きません。このキーは変更できません。",
        },
      ],
    },
    {
      title: "動画エリア選択中のみ",
      note: "動画エリアをクリック、または Tab キーで選択している間だけ有効です。これらのキーは変更できません。",
      rows: PLAYER_SHORTCUTS,
    },
  ];
}

function initShortcutPanel() {
  const panel = document.getElementById("shortcut-panel");
  const body = document.getElementById("shortcut-panel-body");
  const message = document.getElementById("shortcut-panel-message");
  const resetButton = document.getElementById("shortcut-reset-btn");
  const openButton = document.getElementById("shortcut-help-btn");
  const closeButton = document.getElementById("shortcut-panel-close-btn");
  if (!panel || !body || !openButton) return;

  // Without <dialog> support the panel isn't hidden by the UA's own styles, so
  // it would render inline and permanently at the foot of the page. Dropping
  // the feature entirely beats that.
  if (typeof panel.showModal !== "function") {
    panel.hidden = true;
    openButton.hidden = true;
    return;
  }

  // Which Global Shortcut is currently waiting for its new key, or null.
  let capturingId = null;

  // Feedback about one row is rendered inside that row rather than down in the
  // footer: a refusal shown a whole table's height away from the key you just
  // pressed is easy to miss entirely. Only panel-wide messages (the reset) have
  // no row to belong to, and those fall back to the footer.
  let feedback = null;

  const setFeedback = (text, tone, id = null) => {
    feedback = text ? { text, tone, id } : null;
  };

  const renderFooterMessage = () => {
    if (!message) return;
    message.textContent = feedback?.text ?? "";
    message.hidden = !feedback;
    // A row-scoped message is already visible up in its row; this copy stays
    // only to carry the announcement, because an element inserted with its
    // text already in place never fires aria-live.
    message.classList.toggle("is-visually-hidden", Boolean(feedback?.id));
    message.classList.toggle("is-error", feedback?.tone === "error");
    message.classList.toggle("is-warning", feedback?.tone === "warning");
  };

  const render = () => {
    body.textContent = "";

    for (const section of shortcutSections()) {
      const sectionEl = document.createElement("section");
      sectionEl.className = "shortcut-section";

      const title = document.createElement("h3");
      title.className = "shortcut-section-title";
      title.textContent = section.title;
      sectionEl.appendChild(title);

      if (section.note) {
        const note = document.createElement("p");
        note.className = "shortcut-section-note";
        note.textContent = section.note;
        sectionEl.appendChild(note);
      }

      const table = document.createElement("table");
      table.className = "shortcut-table";
      const tbody = document.createElement("tbody");

      for (const row of section.rows) {
        const tr = document.createElement("tr");

        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = row.label;
        if (row.note) {
          const note = document.createElement("small");
          note.className = "shortcut-row-note";
          note.textContent = row.note;
          th.appendChild(note);
        }
        if (row.id && feedback?.id === row.id) {
          tr.classList.add("is-flagged");
          if (feedback.tone) tr.classList.add(`is-${feedback.tone}`);
          const rowMessage = document.createElement("p");
          rowMessage.className = "shortcut-row-message";
          rowMessage.textContent = feedback.text;
          th.appendChild(rowMessage);
        }
        tr.appendChild(th);

        const td = document.createElement("td");
        if (row.id && row.id === capturingId) {
          const waiting = document.createElement("span");
          waiting.className = "shortcut-capturing";
          waiting.textContent = "キーを押してください…";
          td.appendChild(waiting);
        } else if (row.combos.length === 0) {
          const none = document.createElement("span");
          none.className = "shortcut-unassigned";
          none.textContent = "未割り当て";
          td.appendChild(none);
        } else {
          row.combos.forEach((combo, index) => {
            if (index > 0) {
              const separator = document.createElement("span");
              separator.className = "shortcut-combo-sep";
              separator.textContent = "/";
              td.appendChild(separator);
            }
            const key = document.createElement("kbd");
            key.className = "shortcut-combo";
            key.textContent = row.display?.[index] ?? formatCombo(combo);
            td.appendChild(key);
          });
        }
        tr.appendChild(td);

        const actions = document.createElement("td");
        actions.className = "shortcut-actions";
        if (row.editable) {
          const change = document.createElement("button");
          change.type = "button";
          change.className = "shortcut-action-btn";
          change.textContent = capturingId === row.id ? "取消" : "変更";
          change.addEventListener("click", () => {
            if (capturingId === row.id) {
              setFeedback(null);
              stopCapture();
            } else {
              startCapture(row.id);
            }
          });
          actions.appendChild(change);

          if (row.combos.length > 0) {
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "shortcut-action-btn";
            clear.textContent = "解除";
            clear.addEventListener("click", () => {
              SHORTCUT_ASSIGNMENTS[row.id] = null;
              saveShortcutAssignments();
              setFeedback(`「${row.label}」のキーを解除しました。`, null, row.id);
              render();
            });
            actions.appendChild(clear);
          }
        }
        tr.appendChild(actions);

        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      sectionEl.appendChild(table);
      body.appendChild(sectionEl);
    }

    renderFooterMessage();
  };

  // Bound on window in the capture phase, so it runs ahead of both the Global
  // Shortcut listener on document and the browser's own Alt accelerators —
  // otherwise pressing Alt+D to assign it would focus the address bar instead.
  const onCaptureKey = (event) => {
    event.preventDefault();
    event.stopPropagation();

    // A modifier on its own is the viewer still reaching for the combination.
    if (/^(Alt|Control|Shift|Meta)(Left|Right)$/.test(event.code)) return;

    const id = capturingId;

    if (event.code === "Escape") {
      setFeedback("変更を取り消しました。", null, id);
      stopCapture();
      return;
    }

    const combo = comboFromEvent(event);
    const owner = shortcutConflict(combo, id);

    if (owner) {
      setFeedback(`${formatCombo(combo)} は「${owner}」に割り当て済みです。変更していません。`, "error", id);
      stopCapture();
      return;
    }

    SHORTCUT_ASSIGNMENTS[id] = combo;
    saveShortcutAssignments();
    // A refusal and a merely-inadvisable choice both land here, so the tone has
    // to carry the difference: one says nothing changed, the other says it did.
    setFeedback(
      comboTypesCharacter(combo)
        ? `${formatCombo(combo)} にしました。Alt か Ctrl を含めないと、コメント入力中は効きません。`
        : `${formatCombo(combo)} にしました。`,
      comboTypesCharacter(combo) ? "warning" : null,
      id,
    );
    stopCapture();
  };

  function startCapture(id) {
    capturingId = id;
    setFeedback("Esc で取り消します。", null, id);
    window.addEventListener("keydown", onCaptureKey, true);
    render();
  }

  function stopCapture() {
    capturingId = null;
    window.removeEventListener("keydown", onCaptureKey, true);
    render();
  }

  const open = () => {
    if (!panel.open) {
      setFeedback(null);
      render();
      panel.showModal();
    }
  };
  const close = () => {
    if (!panel.open) return;
    if (capturingId) stopCapture();
    panel.close();
  };

  // Esc during a capture cancels the capture, not the whole panel. The capture
  // listener above already swallows that keydown, but a <dialog> can also be
  // dismissed by the UA without one, so the cancel event is guarded too.
  panel.addEventListener("cancel", (event) => {
    if (capturingId) event.preventDefault();
  });

  resetButton?.addEventListener("click", () => {
    for (const shortcut of GLOBAL_SHORTCUTS) SHORTCUT_ASSIGNMENTS[shortcut.id] = shortcut.defaultCombo;
    saveShortcutAssignments();
    setFeedback("すべてデフォルトに戻しました。", null);
    render();
  });

  render();

  openButton.addEventListener("click", () => (panel.open ? close() : open()));
  closeButton?.addEventListener("click", close);

  // showModal() sizes the dialog's own box to fill the viewport in some
  // engines, so a click that lands on the element itself rather than on any of
  // its children is a click on the backdrop.
  panel.addEventListener("click", (event) => {
    if (event.target === panel) close();
  });

  document.addEventListener("keydown", (event) => {
    if (comboFromEvent(event) !== PANEL_COMBO) return;
    // Once the panel is open its own content holds focus, so this only ever
    // guards the "?" that opens it, never the one that closes it.
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    if (panel.open) close();
    else open();
  });
}

// Deliberately a second, independent listener rather than an extension of
// initPlayerKeyboardShortcuts: that one is bound to #video-area and fires only
// while focus is inside it, which is the opposite of what these need.
function initGlobalShortcuts() {
  document.addEventListener("keydown", (event) => {
    const combo = comboFromEvent(event);
    const shortcut = GLOBAL_SHORTCUTS.find((candidate) => SHORTCUT_ASSIGNMENTS[candidate.id] === combo);
    if (!shortcut) return;
    event.preventDefault();
    GLOBAL_SHORTCUT_ACTIONS[shortcut.id]?.();
  });
}

function initPictureInPicture(video) {
  const btn = document.getElementById("video-pip-btn");
  if (!btn) return;

  // Safari uses webkitSupportsPresentationMode instead of the standard API;
  // out of scope here, so the button just stays hidden there too.
  if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
    return;
  }
  btn.hidden = false;

  btn.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      // Rejected (e.g. video not ready yet) — nothing to recover from, the
      // button just stays in its current state for the viewer to retry.
    }
  });

  video.addEventListener("enterpictureinpicture", () => {
    btn.classList.add("active");
    btn.setAttribute("aria-label", "ピクチャーインピクチャーを終了");
  });
  video.addEventListener("leavepictureinpicture", () => {
    btn.classList.remove("active");
    btn.setAttribute("aria-label", "ピクチャーインピクチャーで再生");
  });
}

function initBufferingIndicator(video) {
  const overlay = document.getElementById("video-buffering-overlay");
  if (!overlay) return;

  video.addEventListener("waiting", () => {
    overlay.hidden = false;
  });
  // playing: normal resume after a stall. canplay: safety net for cases where
  // "waiting" fires but "playing" doesn't reliably follow (e.g. resuming from
  // a fully-paused state rather than a stall). pause: avoids a spinner left
  // on screen over the big center play button if playback stops mid-wait.
  video.addEventListener("playing", () => {
    overlay.hidden = true;
  });
  video.addEventListener("canplay", () => {
    overlay.hidden = true;
  });
  video.addEventListener("pause", () => {
    overlay.hidden = true;
  });
}

function initCommentStream() {
  const commentArea = document.getElementById("comment-area");
  const commentPanel = document.getElementById("comment-panel");
  const scrollWrap = document.getElementById("comment-scroll-wrap");
  const jumpButton = document.getElementById("comment-jump-btn");
  const unreadBadge = document.getElementById("comment-unread-badge");
  const ticker = document.getElementById("item-ticker");
  if (!commentArea || !scrollWrap || !jumpButton) return;
  commentArea.textContent = "";

  const flashPanel = (tier) => {
    if (!commentPanel) return;
    commentPanel.style.setProperty("--flash-rgb", tier.rgb);
    commentPanel.style.setProperty("--flash-alpha", String(tier.flashAlpha));
    commentPanel.classList.remove("flash");
    void commentPanel.offsetWidth;
    commentPanel.classList.add("flash");
  };

  const SCROLL_THRESHOLD = 20;
  const MAX_COMMENTS = 300;
  const tickerTimeouts = new Map();
  const tickerCounts = new Map();
  let unseenCount = 0;

  const isAtBottom = () =>
    commentArea.scrollTop + commentArea.clientHeight >= commentArea.scrollHeight - SCROLL_THRESHOLD;

  const trimComments = () => {
    while (commentArea.childElementCount > MAX_COMMENTS) {
      commentArea.firstElementChild.remove();
    }
  };

  const updateJumpButton = () => {
    if (isAtBottom()) {
      unseenCount = 0;
      jumpButton.hidden = true;
      return;
    }
    jumpButton.hidden = false;
    jumpButton.textContent = unseenCount > 0 ? `↓ ${unseenCount}件の新着` : "↓ 最新に戻る";
  };

  commentArea.addEventListener("scroll", updateJumpButton);
  jumpButton.addEventListener("click", () => {
    commentArea.scrollTop = commentArea.scrollHeight;
  });

  const insertByCost = (entry, cost) => {
    entry.dataset.cost = String(cost);
    const insertBefore = [...ticker.children].find((el) => Number(el.dataset.cost) <= cost);
    if (insertBefore) {
      ticker.insertBefore(entry, insertBefore);
    } else {
      ticker.appendChild(entry);
    }
  };

  const startCountdown = (entry, durationMs) => {
    entry.classList.remove("counting");
    void entry.offsetWidth;
    entry.style.setProperty("--ticker-duration", `${durationMs}ms`);
    entry.classList.add("counting");
  };

  const setTickerCount = (entry, count) => {
    const countEl = entry.querySelector(".ticker-count");
    countEl.textContent = `×${count}`;
    countEl.hidden = count <= 1;
  };

  const pushTicker = (item, targetId) => {
    if (!ticker) return;
    const tier = tierForCost(item.cost);
    const durationMs = tickerDurationForCost(item.cost);

    // The tag's visible lifetime (tickerTimeouts, below) resets on every arrival.
    // The count must NOT follow that reset — each arrival expires on its own clock,
    // independently of whether later arrivals keep the tag itself on screen.
    const activeCount = (tickerCounts.get(item.id) || 0) + 1;
    tickerCounts.set(item.id, activeCount);
    setTimeout(() => {
      const remaining = (tickerCounts.get(item.id) || 1) - 1;
      if (remaining <= 0) {
        tickerCounts.delete(item.id);
        return;
      }
      tickerCounts.set(item.id, remaining);
      const currentEntry = ticker.querySelector(`[data-item-id="${item.id}"]`);
      if (currentEntry) setTickerCount(currentEntry, remaining);
    }, durationMs);

    let entry = ticker.querySelector(`[data-item-id="${item.id}"]`);
    if (entry) {
      entry.dataset.targetId = targetId;
      insertByCost(entry, item.cost);
    } else {
      entry = document.createElement("button");
      entry.type = "button";
      entry.className = "ticker-item";
      entry.dataset.itemId = item.id;
      entry.dataset.targetId = targetId;
      entry.title = item.name;
      entry.style.setProperty("--cost-rgb", tier.rgb);
      entry.style.setProperty("--item-with-text-bg-dark", tier.bgItemWithTextDark);

      const icon = document.createElement("img");
      icon.src = item.iconUrl;
      icon.alt = item.name;
      icon.width = 24;
      icon.height = 24;
      entry.appendChild(icon);

      const countEl = document.createElement("span");
      countEl.className = "ticker-count";
      countEl.hidden = true;
      entry.appendChild(countEl);

      entry.addEventListener("click", () => {
        const target = commentArea.querySelector(`[data-id="${entry.dataset.targetId}"]`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      });

      insertByCost(entry, item.cost);
    }

    setTickerCount(entry, activeCount);
    startCountdown(entry, durationMs);

    clearTimeout(tickerTimeouts.get(item.id));
    tickerTimeouts.set(
      item.id,
      setTimeout(() => {
        entry.remove();
        tickerTimeouts.delete(item.id);
        tickerCounts.delete(item.id);
      }, durationMs),
    );
  };

  const eventSource = new EventSource(COMMENT_STREAM_URL);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const entry = document.createElement("li");
    entry.dataset.id = data.id;

    if (data.item) {
      const tier = tierForCost(data.item.cost);
      entry.style.setProperty("--cost-rgb", tier.rgb);
      entry.style.setProperty("--item-only-bg", tier.bgItemOnly);
      entry.classList.add("comment-has-item", data.text ? "comment-item-with-text" : "comment-item-only");

      const icon = document.createElement("img");
      icon.src = data.item.iconUrl;
      icon.title = data.item.name;
      icon.className = data.text ? "comment-item-icon-small" : "comment-item-icon";

      if (data.text) {
        icon.alt = "";
        entry.appendChild(icon);

        const bubble = document.createElement("span");
        bubble.className = "comment-text-bubble";
        const text = document.createElement("span");
        text.className = "comment-text";
        text.textContent = data.text;
        bubble.appendChild(text);
        entry.appendChild(bubble);
      } else {
        icon.alt = data.item.name;
        entry.appendChild(icon);

        const sentText = document.createElement("span");
        sentText.className = "comment-item-sent-text";
        sentText.textContent = `${data.item.name}を送りました。`;
        entry.appendChild(sentText);
      }

      pushTicker(data.item, data.id);
      flashPanel(tier);
    } else if (data.text) {
      const text = document.createElement("span");
      text.className = "comment-text";
      text.textContent = data.text;
      entry.appendChild(text);
    }

    if (scrollWrap.hidden) {
      // No "entering" class here: the panel is closed (display:none), so the
      // entrance animation can't play now anyway, and leaving the class on
      // would replay it for this entry once the panel reopens — exactly the
      // unwanted "items popping in again" effect this is meant to avoid.
      commentArea.appendChild(entry);
      trimComments();
      if (unreadBadge) {
        const count = Number(unreadBadge.dataset.count || "0") + 1;
        unreadBadge.dataset.count = String(count);
        unreadBadge.textContent = String(count);
        unreadBadge.hidden = false;
      }
      return;
    }

    entry.classList.add("entering");
    entry.addEventListener("animationend", () => entry.classList.remove("entering"), { once: true });

    const wasAtBottom = isAtBottom();
    commentArea.appendChild(entry);
    if (wasAtBottom) {
      commentArea.scrollTop = commentArea.scrollHeight;
      trimComments();
    } else {
      unseenCount += 1;
    }
    updateJumpButton();
  };
}

function initCommentPanel() {
  const header = document.getElementById("comment-header");
  const toggleButton = document.getElementById("comment-toggle-btn");
  const scrollWrap = document.getElementById("comment-scroll-wrap");
  const commentArea = document.getElementById("comment-area");
  const unreadBadge = document.getElementById("comment-unread-badge");
  if (!header || !toggleButton || !scrollWrap || !commentArea) return;

  header.addEventListener("click", (event) => {
    if (event.target.closest(".ticker-item")) return;

    scrollWrap.hidden = !scrollWrap.hidden;
    toggleButton.setAttribute("aria-expanded", String(!scrollWrap.hidden));

    if (scrollWrap.hidden) {
      // A comment's entrance animation (see initCommentStream's "entering"
      // class) may still be mid-flight when the panel closes, which pauses
      // it rather than firing animationend — strip the class now so it can't
      // replay from the start when the panel reopens.
      commentArea.querySelectorAll("li.entering").forEach((li) => li.classList.remove("entering"));
    } else {
      if (unreadBadge) {
        unreadBadge.hidden = true;
        unreadBadge.dataset.count = "0";
      }
      commentArea.scrollTop = commentArea.scrollHeight;
    }
  });
}

function initItemList() {
  const itemPanel = document.getElementById("item-panel");
  const itemList = document.getElementById("item-list");
  const groupTabs = document.getElementById("item-group-tabs");
  const toggleButton = document.getElementById("item-toggle-btn");
  const closeButton = document.getElementById("item-panel-close-btn");
  if (!itemPanel || !itemList || !groupTabs || !toggleButton) return;

  let lastFetchTime = 0;
  let activeGroup = null;

  const applyActiveGroup = () => {
    groupTabs.querySelectorAll(".item-group-tab").forEach((tab) => {
      const isActive = tab.dataset.group === activeGroup;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-pressed", String(isActive));
    });
    itemList.querySelectorAll(".item-box").forEach((box) => {
      box.hidden = box.dataset.group !== activeGroup;
    });
  };

  const selectGroup = (group) => {
    activeGroup = group;
    applyActiveGroup();
  };

  const ensureGroupTab = (group) => {
    if (groupTabs.querySelector(`[data-group="${group}"]`)) return;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "item-group-tab";
    tab.dataset.group = group;
    tab.textContent = group;
    tab.setAttribute("aria-pressed", "false");
    tab.addEventListener("click", () => selectGroup(group));
    groupTabs.appendChild(tab);

    if (activeGroup === null) selectGroup(group);
  };

  const loadItems = () => {
    if (Date.now() - lastFetchTime < 20000) return;

    fetch(ITEMS_URL)
      .then((response) => response.json())
      .then((data) => {
        const items = [...data.items].sort((a, b) => a.cost - b.cost);
        for (const item of items) {
          ensureGroupTab(item.group);

          if (itemList.querySelector(`[data-id="${item.id}"]`)) continue;

          const itemBox = document.createElement("button");
          itemBox.type = "button";
          itemBox.className = "item-box";

          itemBox.dataset.id = item.id;
          itemBox.dataset.group = item.group;
          itemBox.hidden = item.group !== activeGroup;
          const tier = tierForCost(item.cost);
          itemBox.style.setProperty("--cost-rgb", tier.rgb);
          itemBox.style.setProperty("--item-only-bg", tier.bgItemOnly);

          const icon = document.createElement("img");
          icon.dataset.id = item.id;
          icon.src = item.iconUrl;
          icon.title = item.name;
          icon.alt = item.name;
          icon.width = 40;
          icon.height = 40;
          icon.loading = "lazy";
          itemBox.appendChild(icon);

          const name = document.createElement("span");
          name.className = "item-name";
          name.textContent = item.name;
          name.title = item.name;
          // .text is tuned for light backgrounds; on dark backgrounds those same
          // shades read as near-black, so dark mode reuses the tier's own .rgb
          // (already a lighter tone, used elsewhere for tints/flashes) as text color.
          name.style.setProperty("--item-name-color", tier.text);
          name.style.setProperty("--item-name-color-dark", `rgb(${tier.rgb})`);
          itemBox.appendChild(name);

          itemList.appendChild(itemBox);
        }
        lastFetchTime = Date.now();
      });
  };

  const openPanel = () => {
    itemPanel.hidden = false;
    loadItems();
  };

  const closePanel = () => {
    itemPanel.hidden = true;
  };

  toggleButton.addEventListener("click", () => {
    if (itemPanel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  });

  if (closeButton) closeButton.addEventListener("click", closePanel);

  document.addEventListener("click", (event) => {
    if (itemPanel.hidden) return;
    if (itemPanel.contains(event.target) || toggleButton.contains(event.target)) return;
    closePanel();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !itemPanel.hidden) closePanel();
  });

  itemList.addEventListener("click", (event) => {
    const box = event.target.closest(".item-box");
    if (!box) return;

    const alreadySelected = box.classList.contains("selected");
    itemList.querySelectorAll(".item-box.selected").forEach((el) => el.classList.remove("selected"));
    if (!alreadySelected) {
      box.classList.add("selected");
      closePanel();
    }
  });
}

function initCommentSend() {
  const input = document.getElementById("comment-input");
  const button = document.getElementById("comment-send");
  const errorArea = document.getElementById("comment-error");
  const itemList = document.getElementById("item-list");
  const itemPanel = document.getElementById("item-panel");
  if (!input || !button || !errorArea) return;

  const showError = (message) => {
    errorArea.textContent = message;
    errorArea.hidden = false;
  };
  const clearError = () => {
    errorArea.hidden = true;
  };
  const resizeInput = () => {
    input.style.height = "auto";
    // overflow stays hidden below max-height so a 1px scrollHeight/clientHeight
    // rounding mismatch (line-height fractions) doesn't leave a spurious
    // scrollbar on a single line; the +1 tolerance absorbs that rounding.
    const maxHeight = parseFloat(getComputedStyle(input).maxHeight) || Infinity;
    input.style.overflowY = input.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
    input.style.height = `${input.scrollHeight}px`;
  };
  // Corner radius is fixed to half the natural one-line height (measured once,
  // while the textarea is still empty) instead of the relative 999px pill,
  // so it stays a constant curve at the top/bottom corners as the box grows
  // taller, with straight sides in between, rather than re-inflating into a
  // bigger semicircle at every height.
  input.style.height = "auto";
  input.style.setProperty("--textarea-radius", `${input.scrollHeight / 2}px`);
  resizeInput();
  const checkLimits = () => {
    const text = input.value;
    if (text.length > 200) {
      showError("コメントは200文字以内で入力してください。");
    } else if (text.split("\n").length > 4) {
      showError("コメントは4行以内で入力してください。");
    } else {
      clearError();
    }
  };

  const send = () => {
    const text = input.value;
    const selectedBox = itemList ? itemList.querySelector(".item-box.selected") : null;
    const itemId = selectedBox ? selectedBox.dataset.id : null;

    if (!text.trim() && !itemId) {
      showError("コメントまたはアイテムを入力・選択してください。");
      errorArea.focus();
      return;
    }
    if (text.length > 200 || text.split("\n").length > 4) {
      checkLimits();
      errorArea.focus();
      return;
    }

    clearError();
    const payload = {};
    if (text.trim()) payload.text = text;
    if (itemId) payload.itemId = itemId;

    input.disabled = true;
    button.disabled = true;
    button.setAttribute("aria-label", "送信中");

    fetch(COMMENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) throw new Error("send failed");
        input.value = "";
        resizeInput();
        if (selectedBox) selectedBox.classList.remove("selected");
        if (itemPanel) itemPanel.hidden = true;
        input.focus();
      })
      .catch(() => {
        showError("送信に失敗しました。もう一度お試しください。");
        errorArea.focus();
      })
      .finally(() => {
        input.disabled = false;
        button.disabled = false;
        button.setAttribute("aria-label", "送信");
      });
  };

  input.addEventListener("input", () => {
    resizeInput();
    checkLimits();
  });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  button.addEventListener("click", send);
}

function initSelectedItemChip() {
  const itemPanel = document.getElementById("item-panel");
  const itemList = document.getElementById("item-list");
  const chip = document.getElementById("selected-item-chip");
  const chipIcon = document.getElementById("selected-item-chip-icon");
  if (!itemPanel || !itemList || !chip || !chipIcon) return;

  const update = () => {
    const selectedBox = itemList.querySelector(".item-box.selected");
    if (selectedBox && itemPanel.hidden) {
      const icon = selectedBox.querySelector("img");
      chipIcon.src = icon.src;
      chip.title = `${icon.title}(クリックで解除)`;
      chip.setAttribute("aria-label", `選択中のアイテム: ${icon.title}(クリックで解除)`);
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  };

  new MutationObserver(update).observe(itemPanel, {
    attributes: true,
    attributeFilter: ["class", "hidden"],
    subtree: true,
  });

  chip.addEventListener("click", () => {
    const selectedBox = itemList.querySelector(".item-box.selected");
    if (selectedBox) selectedBox.classList.remove("selected");
  });

  update();
}

function initSelectedItemPreview() {
  const itemPanel = document.getElementById("item-panel");
  const itemList = document.getElementById("item-list");
  const sendRow = document.querySelector(".send-row");
  const sendArea = document.getElementById("send-area");
  if (!itemPanel || !itemList || !sendRow) return;

  const update = () => {
    const selectedBox = itemList.querySelector(".item-box.selected");
    if (selectedBox) {
      const costRgb = selectedBox.style.getPropertyValue("--cost-rgb");
      const itemOnlyBg = selectedBox.style.getPropertyValue("--item-only-bg");
      sendRow.style.setProperty("--cost-rgb", costRgb);
      sendRow.style.setProperty("--item-only-bg", itemOnlyBg);
      sendRow.classList.add("item-selected");
      if (sendArea) {
        sendArea.style.setProperty("--cost-rgb", costRgb);
        sendArea.style.setProperty("--item-only-bg", itemOnlyBg);
        sendArea.classList.add("item-selected");
      }
    } else {
      sendRow.classList.remove("item-selected");
      if (sendArea) sendArea.classList.remove("item-selected");
    }
  };

  // Selection lives entirely as the .selected class on an .item-box (see
  // initItemList) — watch that, same as initSelectedItemChip, rather than a
  // separate selection variable.
  new MutationObserver(update).observe(itemPanel, {
    attributes: true,
    attributeFilter: ["class"],
    subtree: true,
  });

  update();
}

function initChannelList(switchChannel) {
  const listEl = document.getElementById("channel-list");
  const tabsEl = document.getElementById("channel-tabs");
  if (!listEl || !tabsEl) return;

  fetch(CHANNELS_URL)
    .then((response) => response.json())
    .then((channels) => {
      const liveChannels = channels.filter((channel) => !channel.retired);
      let activeId = liveChannels.find((channel) => channel.default)?.id ?? liveChannels[0]?.id ?? null;
      // Starts on whichever genre the active channel belongs to, so the
      // channel actually playing is visible without an extra tab click.
      let activeCategory =
        liveChannels.find((channel) => channel.id === activeId)?.category ?? liveChannels[0]?.category ?? null;

      const applyActiveChannel = () => {
        listEl.querySelectorAll(".channel-item").forEach((btn) => {
          const isActive = btn.dataset.id === activeId;
          btn.classList.toggle("active", isActive);
          btn.setAttribute("aria-pressed", String(isActive));
        });
      };

      const applyActiveCategory = () => {
        tabsEl.querySelectorAll(".channel-tab").forEach((tab) => {
          const isActive = tab.dataset.category === activeCategory;
          tab.classList.toggle("active", isActive);
          tab.setAttribute("aria-pressed", String(isActive));
        });
        listEl.querySelectorAll(".channel-item").forEach((btn) => {
          btn.hidden = btn.dataset.category !== activeCategory;
        });
      };

      const selectCategory = (category) => {
        activeCategory = category;
        applyActiveCategory();
      };

      const ensureCategoryTab = (category) => {
        if (tabsEl.querySelector(`[data-category="${category}"]`)) return;

        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "channel-tab";
        tab.dataset.category = category;
        tab.textContent = category;
        tab.setAttribute("aria-pressed", "false");
        tab.addEventListener("click", () => selectCategory(category));
        tabsEl.appendChild(tab);
      };

      for (const channel of liveChannels) {
        ensureCategoryTab(channel.category);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "channel-item";
        btn.dataset.id = channel.id;
        btn.dataset.category = channel.category;
        btn.hidden = channel.category !== activeCategory;
        btn.setAttribute("aria-pressed", "false");

        const title = document.createElement("span");
        title.className = "channel-item-title";
        title.textContent = channel.title;
        btn.appendChild(title);

        btn.addEventListener("click", () => {
          if (channel.id === activeId) return;
          activeId = channel.id;
          applyActiveChannel();
          switchChannel?.(`${HLS_ORIGIN}${channel.playlist}`);
        });

        listEl.appendChild(btn);
      }

      applyActiveChannel();
      applyActiveCategory();
    });
}

function initTheme() {
  const root = document.documentElement;
  const toggleButton = document.getElementById("theme-toggle-btn");
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (!toggleButton) return;

  const THEME_STORAGE_KEY = "theme";
  const THEME_COLORS = { light: "#f2f2f0", dark: "#15171a" };

  const applyTheme = (theme) => {
    root.dataset.theme = theme;
    toggleButton.setAttribute("aria-checked", String(theme === "dark"));
    toggleButton.setAttribute("aria-label", theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え");
    if (themeColorMeta) themeColorMeta.setAttribute("content", THEME_COLORS[theme]);
  };

  // The inline script in index.html's <head> already set root.dataset.theme
  // before first paint (avoids a flash of the wrong theme); this just syncs
  // the button/meta to whatever it picked.
  applyTheme(root.dataset.theme === "dark" ? "dark" : "light");

  toggleButton.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  });
}

function initLayoutFit() {
  const layout = document.querySelector(".layout");
  const videoArea = document.getElementById("video-area");
  const sidePanel = document.querySelector(".side-panel");
  if (!layout || !videoArea || !sidePanel) return;

  const MOBILE_QUERY = window.matchMedia("(max-width: 767px)");
  // Kept in sync with .video-area's aspect-ratio and max-height in styles.css.
  const VIDEO_ASPECT = 16 / 9;
  const VIDEO_MAX_HEIGHT_VH = 0.85;

  const update = () => {
    if (MOBILE_QUERY.matches) {
      videoArea.style.width = "";
      sidePanel.style.flexBasis = "";
      return;
    }

    // Reset both overrides first so the measurements below reflect CSS's own
    // defaults, not whatever we set on a previous call.
    videoArea.style.width = "";
    sidePanel.style.flexBasis = "";

    const layoutStyle = getComputedStyle(layout);
    const gapPx = parseFloat(layoutStyle.columnGap) || 0;
    const layoutWidth = layout.clientWidth;
    const sidebarWidth = sidePanel.getBoundingClientRect().width;
    const availableForVideo = layoutWidth - gapPx - sidebarWidth;
    const maxVideoWidthFromHeight = window.innerHeight * VIDEO_MAX_HEIGHT_VH * VIDEO_ASPECT;

    // Setting an explicit width (rather than leaving it to flex-grow) keeps the
    // box's true rendered shape at exactly 16:9 even once height-capped —
    // letting aspect-ratio alone interact with flex-grow + max-height could
    // leave the box wider than 16:9, letterboxing the actual video inside it.
    const videoWidth = Math.min(availableForVideo, maxVideoWidthFromHeight);
    videoArea.style.width = `${videoWidth}px`;

    const gapLeft = availableForVideo - videoWidth;
    if (gapLeft > 1) {
      sidePanel.style.flexBasis = `${sidebarWidth + gapLeft}px`;
    }
  };

  window.addEventListener("resize", update);
  MOBILE_QUERY.addEventListener("change", update);
  update();
}

const switchChannel = initPlayer();
initCommentStream();
initCommentPanel();
initChannelList(switchChannel);
initItemList();
initCommentSend();
initSelectedItemChip();
initSelectedItemPreview();
initTheme();
initShortcutPanel();
initGlobalShortcuts();
initLayoutFit();

import Hls from "hls.js";

const STREAM_URL = "https://intern-hls-server.tomaton.workers.dev/stream.m3u8";
const COMMENT_STREAM_URL = "https://intern-comment-server.intern-comment-server.deno.net/events";
const COMMENT_POST_URL = "https://intern-comment-server.intern-comment-server.deno.net/messages";
const ITEMS_URL = "https://intern-comment-server.intern-comment-server.deno.net/items";

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

// Hysteresis, not one shared threshold: a single cutoff flickered between
// "LIVE" and "LIVEに戻る" right after jumping to live, since liveSyncPosition
// jitters (new segments landing, buffer catching up) enough to cross a single
// boundary back and forth for a few seconds. Once at LIVE, only fall behind
// past the wider bound; once behind, only clear back to LIVE within the
// narrower one — a gap sitting between the two no longer flips either way.
const LIVE_EDGE_ENTER_BEHIND_SECONDS = 10;
const LIVE_EDGE_EXIT_BEHIND_SECONDS = 4;

function initPlayer() {
  const video = document.getElementById("player");
  const playOverlay = document.getElementById("video-play-overlay");
  if (!video) return;

  let hls = null;

  if (Hls.isSupported()) {
    // hls.js defaults liveSyncPosition (what the LIVE badge/button jump to) to
    // 3 segments behind the playlist's true edge, as a stall-avoidance buffer.
    // Lowered here so "LIVE" tracks closer to the real edge, at the cost of
    // being more likely to briefly buffer right after jumping to it.
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
    return;
  }

  if (playOverlay) {
    // Mirrors the video's own play/pause state rather than a one-shot "first
    // play" prompt, so pausing (however it happens — the overlay, the native
    // controls, a keyboard shortcut) always brings the big center button back.
    playOverlay.addEventListener("click", () => video.play());
    video.addEventListener("play", () => {
      playOverlay.hidden = true;
    });
    video.addEventListener("pause", () => {
      playOverlay.hidden = false;
    });
  }

  initLiveBadge(video, hls);
  initBufferingIndicator(video);
  initPictureInPicture(video);
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

function initLiveBadge(video, hls) {
  const badge = document.getElementById("video-live-badge");
  const label = badge ? badge.querySelector(".video-live-badge-label") : null;
  if (!badge || !label) return;

  // hls.js branch: hls.liveSyncPosition is the edge hls.js itself targets
  // (accounts for its own live-sync-duration config). Native-Safari HLS has
  // no hls.js instance at all, so that branch — and the hls.js branch before
  // liveSyncPosition is known — falls back to the end of the seekable range,
  // the only edge signal a plain <video> exposes.
  const getLiveEdge = () => {
    if (hls && typeof hls.liveSyncPosition === "number") return hls.liveSyncPosition;
    if (video.seekable && video.seekable.length > 0) {
      return video.seekable.end(video.seekable.length - 1);
    }
    return null;
  };

  const updateEdgeState = () => {
    const edge = getLiveEdge();
    // No edge info yet (stream just attached) — leave the badge in its
    // default "live" look rather than guessing.
    if (edge == null) return;

    const gap = edge - video.currentTime;
    const threshold = badge.classList.contains("behind")
      ? LIVE_EDGE_EXIT_BEHIND_SECONDS
      : LIVE_EDGE_ENTER_BEHIND_SECONDS;
    const behind = gap > threshold;
    badge.classList.toggle("behind", behind);
    badge.setAttribute("tabindex", behind ? "0" : "-1");
    badge.setAttribute("aria-label", behind ? "ライブに戻る" : "ライブ配信中");
    label.textContent = behind ? "LIVEに戻る" : "LIVE";
  };

  // seeked: fires right after the viewer finishes dragging the native seek
  // bar — the primary trigger for this feature. timeupdate: keeps the state
  // correct while simply watching. playing: recheck right after a stall/seek
  // resolves. The interval is a fallback for a paused video sitting exactly
  // at the edge, where the edge keeps advancing without the playhead moving.
  video.addEventListener("seeked", updateEdgeState);
  video.addEventListener("timeupdate", updateEdgeState);
  video.addEventListener("playing", updateEdgeState);
  setInterval(updateEdgeState, 2000);

  badge.addEventListener("click", () => {
    if (!badge.classList.contains("behind")) return;
    const edge = getLiveEdge();
    if (edge == null) return;
    video.currentTime = edge;
    if (video.paused) video.play();
  });

  // Reconnecting: hls.js only. A fatal NETWORK_ERROR here is the same event
  // initPlayer's own Hls.Events.ERROR listener reacts to by calling
  // hls.startLoad() — this is a second, independent listener on the same
  // event purely for the visual cue. Native Safari's built-in HLS engine
  // retries internally with no equivalent JS-visible signal, so there is
  // deliberately no reconnecting state in that branch.
  if (hls) {
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        badge.classList.add("reconnecting");
      }
    });
    video.addEventListener("playing", () => {
      badge.classList.remove("reconnecting");
    });
  }

  updateEdgeState();
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

    if (!scrollWrap.hidden) {
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

initPlayer();
initCommentStream();
initCommentPanel();
initItemList();
initCommentSend();
initSelectedItemChip();
initSelectedItemPreview();
initTheme();
initLayoutFit();

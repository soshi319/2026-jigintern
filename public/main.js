import Hls from "hls.js";

const STREAM_URL = "https://intern-hls-server.tomaton.workers.dev/stream.m3u8";
const COMMENT_STREAM_URL = "https://intern-comment-server.intern-comment-server.deno.net/events";
const COMMENT_POST_URL = "https://intern-comment-server.intern-comment-server.deno.net/messages";
const ITEMS_URL = "https://intern-comment-server.intern-comment-server.deno.net/items";

function initPlayer() {
  const video = document.getElementById("player");
  if (!video) return;

  if (Hls.isSupported()) {
    const hls = new Hls();
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
  }
}

function initCommentStream() {
  const commentArea = document.getElementById("comment-area");
  if (!commentArea) return;
  commentArea.textContent = "";

  const eventSource = new EventSource(COMMENT_STREAM_URL);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const entry = document.createElement("li");

    if (data.item) {
      const iconSlot = document.createElement("span");
      iconSlot.className = "comment-item-icon-slot";
      entry.appendChild(iconSlot);

      const icon = document.createElement("img");
      icon.src = data.item.iconUrl;
      icon.alt = data.item.name;
      icon.className = "comment-item-icon";
      iconSlot.appendChild(icon);

      const itemName = document.createElement("span");
      itemName.className = "comment-item-name";
      itemName.textContent = data.item.name;
      iconSlot.appendChild(itemName);
    }

    if (data.text) {
      const text = document.createElement("span");
      text.className = "comment-text";
      text.textContent = data.text;
      entry.appendChild(text);
    }

    commentArea.appendChild(entry);
    commentArea.scrollTop = commentArea.scrollHeight;
  };
}

function initItemList() {
  const itemList = document.getElementById("item-list");
  const toggleButton = document.getElementById("item-toggle-btn");
  if (!itemList || !toggleButton) return;

  let lastFetchTime = 0;

  const loadItems = () => {
    if (Date.now() - lastFetchTime < 20000) return;

    fetch(ITEMS_URL)
      .then((response) => response.json())
      .then((data) => {
        for (const item of data.items) {
          if (itemList.querySelector(`[data-id="${item.id}"]`)) continue;

          const itemBox = document.createElement("div");
          itemBox.className = "item-box";

          itemBox.dataset.id = item.id;

          const icon = document.createElement("img");
          icon.dataset.id = item.id;
          icon.src = item.iconUrl;
          icon.title = item.name;
          icon.alt = item.name;
          itemBox.appendChild(icon);

          const name = document.createElement("span");
          name.className = "item-name";
          name.textContent = item.name;
          itemBox.appendChild(name);

          itemList.appendChild(itemBox);
        }
        lastFetchTime = Date.now();
      });
  };

  toggleButton.addEventListener("click", () => {
    itemList.hidden = !itemList.hidden;
    if (!itemList.hidden) loadItems();
  });

  itemList.addEventListener("click", (event) => {
    const box = event.target.closest(".item-box");
    if (!box) return;

    const alreadySelected = box.classList.contains("selected");
    itemList.querySelectorAll(".item-box.selected").forEach((el) => el.classList.remove("selected"));
    if (!alreadySelected) box.classList.add("selected");
  });
}

function initCommentSend() {
  const input = document.getElementById("comment-input");
  const button = document.getElementById("comment-send");
  const errorArea = document.getElementById("comment-error");
  const itemList = document.getElementById("item-list");
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
    input.style.height = `${input.scrollHeight}px`;
  };
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
      return;
    }
    if (text.length > 200 || text.split("\n").length > 4) {
      checkLimits();
      return;
    }

    clearError();
    const payload = {};
    if (text.trim()) payload.text = text;
    if (itemId) payload.itemId = itemId;

    input.disabled = true;
    button.disabled = true;
    button.textContent = "送信中...";

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
        if (itemList) itemList.hidden = true;
      })
      .catch(() => {
        showError("送信に失敗しました。もう一度お試しください。");
      })
      .finally(() => {
        input.disabled = false;
        button.disabled = false;
        button.textContent = "送信";
        input.focus();
      });
  };

  input.addEventListener("input", () => {
    resizeInput();
    checkLimits();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  button.addEventListener("click", send);
}

function initSelectedItemChip() {
  const itemList = document.getElementById("item-list");
  const chip = document.getElementById("selected-item-chip");
  if (!itemList || !chip) return;

  const update = () => {
    const selectedBox = itemList.querySelector(".item-box.selected");
    if (selectedBox && itemList.hidden) {
      const icon = selectedBox.querySelector("img");
      chip.src = icon.src;
      chip.title = `${icon.title}(クリックで解除)`;
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  };

  new MutationObserver(update).observe(itemList, {
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

function initSendAreaHeight() {
  const sendArea = document.getElementById("send-area");
  if (!sendArea) return;

  const updateHeight = () => {
    document.documentElement.style.setProperty("--send-area-reserve", `${sendArea.offsetHeight}px`);
  };

  new ResizeObserver(updateHeight).observe(sendArea);
  updateHeight();
}

initPlayer();
initCommentStream();
initItemList();
initCommentSend();
initSelectedItemChip();
initSendAreaHeight();

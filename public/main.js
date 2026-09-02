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
    if (!text.trim()) {
      showError("コメントを入力してください。");
      return;
    }
    if (text.length > 200 || text.split("\n").length > 4) {
      checkLimits();
      return;
    }

    clearError();
    fetch(COMMENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    input.value = "";
    resizeInput();
    if (itemList) itemList.hidden = true;
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

initPlayer();
initCommentStream();
initItemList();
initCommentSend();

import Hls from "hls.js";

const STREAM_URL = "https://intern-hls-server.tomaton.workers.dev/stream.m3u8";

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

initPlayer();

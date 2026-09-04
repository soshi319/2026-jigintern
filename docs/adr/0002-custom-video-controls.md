# Custom video control bar instead of native `<video controls>`

The native `<video controls>` bar is rendered by the browser as a closed shadow UI — there's no way to insert our own button into it or control where the browser places its own buttons relative to each other. We wanted the Picture-in-Picture button positioned immediately to the left of the fullscreen button, which the native bar can't do, so we removed `controls` entirely and built our own bottom control bar (play/pause, mute + volume slider, PiP, fullscreen) in [public/index.html](../../public/index.html) and [public/main.js](../../public/main.js).

## Consequences

- Fullscreen is requested on `#video-area` (the container), not the bare `<video>` element — fullscreening the video element alone would hand the OS a raw video surface with none of our overlaid UI (control bar, live badge, PiP button) usable inside it.
- We lose the browser's built-in keyboard handling that comes with native controls, so `initPlayerKeyboardShortcuts` reimplements the common ones (space/enter, M, F, arrow up/down for volume) — scoped to only fire while focus is inside `#video-area`, so they never hijack keystrokes in the comment textarea elsewhere on the page.
- The big center `video-play-overlay` button stays, deliberately not consolidated into the bar's own play/pause button — this was a explicit choice to keep both.

# Live Stream Viewer

A single-page app for watching an HLS live stream alongside a real-time comment feed. Viewers can send a text comment, attach an Item, or send both together.

## Language

**Item**:
A decorative catalog entry (`id`, `name`, `iconUrl`) fetched from `/items` that a viewer can attach to a Message, e.g. a heart, star, or flower.
_Avoid_: gift, sticker

**Selected Item**:
The single Item a viewer has staged in the item list (shown highlighted) to go out with their next send. Clicking a different Item replaces it; clicking the same Item again, or a successful send, clears it back to none. Its existence stays visible even while the item list panel is closed, as a small clickable icon (clicking it also clears the selection) shown above the send controls.
_Avoid_: chosen item, active item, picked item

**Message**:
The unit of data POSTed to `/messages`: a `text` and/or an `itemId`, at least one of which must be present. The project's code and UI keep calling the send controls "comment" (`#comment-input`, `initCommentSend`) even though a Message can also carry only an Item, no text.
_Avoid_: post, submission

**Comment**:
A single entry rendered in the live comment feed (`#comment-area`), built from an incoming SSE event's `text` and/or `item`. Also the name this project keeps for the code/UI around composing and sending a Message (see Message) — kept deliberately for minimal-diff reasons, not because it's the most precise term.
_Avoid_: chat message (reserve "Message" for the POST payload concept above)

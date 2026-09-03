# Live Stream Viewer

A single-page app for watching an HLS live stream alongside a real-time comment feed. Viewers can send a text comment, attach an Item, or send both together.

## Language

**Item**:
A decorative catalog entry (`id`, `name`, `iconUrl`, `cost`, `group`, `animationUrl`) fetched from `/items` that a viewer can attach to a Message, e.g. a heart, star, or flower. `cost` places the Item in a Cost Tier (see Cost Tier). `group` is the Item's category (see Item Group) and is what the Item list panel pages by. `animationUrl` is still unused.
_Avoid_: gift, sticker

**Cost Tier**:
One of five bands an Item's `cost` falls into (10 / 50 / 150 / 400 / 1000 — the same five values recur across every Item Group), each carrying its own color running cool-to-warm as cost rises (sky blue → green → amber → orange → magenta, cheapest to priciest). Colors an Item's name in the Item list panel, an item-bearing Comment's background (full strength for an item-only Comment, lighter for one with text too), and a brief flash on the comment feed's frame when a new item-bearing Comment arrives.
_Avoid_: rarity, price tier

**Item Group**:
The category an Item belongs to (the `group` field, e.g. 気持ち, 自然, 食べ物, お祝い). The Item list panel is paged by Item Group — one page per group — rather than by an arbitrary item count, since the catalog is expected to grow mainly by adding more groups.
_Avoid_: category, tab (this project's term is "group", matching the API field)

**Selected Item**:
The single Item a viewer has staged in the item list (shown highlighted) to go out with their next send. Clicking a different Item replaces it; clicking the same Item again, or a successful send, clears it back to none. Its existence stays visible even while the item list panel is closed, as a small clickable icon (clicking it also clears the selection) shown above the send controls.
_Avoid_: chosen item, active item, picked item

**Message**:
The unit of data POSTed to `/messages`: a `text` and/or an `itemId`, at least one of which must be present. The project's code and UI keep calling the send controls "comment" (`#comment-input`, `initCommentSend`) even though a Message can also carry only an Item, no text.
_Avoid_: post, submission

**Comment**:
A single entry rendered in the live comment feed (`#comment-area`), built from an incoming SSE event's `text` and/or `item`. Also the name this project keeps for the code/UI around composing and sending a Message (see Message) — kept deliberately for minimal-diff reasons, not because it's the most precise term.
_Avoid_: chat message (reserve "Message" for the POST payload concept above)

A Comment carrying an Item is visually promoted over a plain text-only Comment via its Cost Tier background tint, so it reads as distinct while scrolling. An item-only Comment shows just the Item's icon (flush left) followed by a sentence — "ハートを送りました。" — that fades out on the right rather than wrapping if it overflows. A Comment with both an Item and text shows a smaller, name-less icon (hover it for the Item's name) on its own line above the text, with the text indented slightly past where a plain text-only Comment starts.

**Item Ticker**:
The row of recently-arrived Items pinned above the scrolling comment feed (`#item-ticker`), independent of and in addition to how each Comment already renders in the feed. Newest arrival is added at the left; older entries sit further right behind a fade, reachable by scrolling. A repeat of the same Item moves its entry back to the left, bumps its count (`×N`), and resets its 10-second lifetime instead of adding a second entry. Clicking an entry scrolls the feed to that Item's original Comment. Stays visible even when the comment feed itself is collapsed.
_Avoid_: super chat, pinned banner (this project's term is "ticker")

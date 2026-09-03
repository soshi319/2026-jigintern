# Item list is paged by Item Group, entirely client-side

The Item catalog (`GET /items`) is expected to grow to 100+ Items, mainly by adding more Item Groups over time. The `/items` API ignores `page`/`limit` query params and always returns every Item in one response with no pagination metadata, so paging has to happen entirely on the client. We page the Item list panel by Item Group (one tab per group, e.g. 気持ち/自然/食べ物/お祝い) rather than by an arbitrary item count per page, since the group is already how the catalog is organized and is expected to be the axis that grows.

## Considered options

- **Arbitrary count per page** (e.g. 20 items/page, numbered 1/2/3…): rejected — doesn't match how the catalog actually grows (more groups, not necessarily deeper existing groups), and a numbered-page boundary would cut a group in half.
- **Remove hidden-page Items from the DOM** (true virtualization): rejected in favor of keeping every Item in the DOM and toggling visibility per active group. This keeps the existing "selection lives entirely as a `.selected` class on one DOM node, no JS variable" convention intact — a page switch never destroys the selected node.

## Consequences

- The active group persists in memory for the page session (not localStorage), so reopening the Item panel restores the last-viewed group; a full page reload resets it to the first group encountered.
- Group tabs are created lazily as Items with a new `group` arrive from `/items`, so a newly-added group appears as a new tab without any code change.
- `.item-box[hidden] { display: none; }` had to be added explicitly — `.item-box`'s own `display: flex` sits at the same specificity as the UA stylesheet's `[hidden]` rule, and author styles win ties over UA styles, so the `hidden` attribute was silently being ignored before this rule was added.

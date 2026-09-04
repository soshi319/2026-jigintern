# Identify shortcut keys by physical position, not by the character they produce

Every Combo names its key with `event.code` (`"Alt+KeyT"`), never `event.key` (`"Alt+t"`), and only converts to a human-readable label at render time. The reason is macOS: Option is the Mac's Alt, and holding it while pressing T makes `event.key` the composed character `"†"`, so a `key`-based table silently matches nothing on half our target platforms — whereas [`event.code` is defined not to be affected by the keyboard layout or modifier state](https://www.w3.org/TR/uievents/#dom-keyboardevent-code). Combos are stored in `localStorage` in this same form, so this choice reaches the persisted data too.

## Considered Options

`event.key` reads far better (`"Alt+t"` needs no translation layer to display, and non-QWERTY users get the key their keycap shows). It was rejected purely because of the Mac Option behaviour above; without that, it would be the better choice. This is worth recording because the `code` form looks like needless ceremony until you hit the Mac case, and the obvious "cleanup" is to switch to `key`.

## Consequences

- A `formatCombo` translation layer is required to display a Combo, and it is platform-aware (`Alt` renders as `Option` on a Mac).
- Viewers on non-QWERTY layouts (Dvorak, AZERTY) get the key at the *QWERTY* position, not the one printed on their keycap. Accepted as out of scope: the app's audience is Japanese, where JIS and US layouts agree on letter positions.
- Because saved assignments are `code` strings, switching to `event.key` later would invalidate every viewer's stored Combos. Reversing this decision means shipping a migration, not just an edit.

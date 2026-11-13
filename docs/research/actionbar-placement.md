# Action bar placement: why roomFor() and onShow look the way they do

Design notes for `client/lib/ui/actionbar.js` (`snapTo`, `roomFor`, the `onShow` handler).

## Columns from width, rows by wrapping

The tiles wrap like text: columns come from the frame width, and height is a consequence. `windows.js` always calls
`onResize(state.w, state.h)`, so any branch that takes rows from a dragged height would pin a tall drag at nine rows
and refuse to wrap. `minW` is `widthFor(1)`: the east/west resize clamp in `windows.js` stops at `minW`, so a larger
minimum makes a one-column bar unreachable by drag.

## Opening width (unplaced bars only)

An unplaced bar opens at the width that fits beside the chrome sharing its y-band (`#dock`, `#micbtn`, `#earbtn`,
`#hudstatus`); otherwise a phone opens the default 352px bar in a 390px viewport under the mic/ear pair. A placed bar
(`_placed`: the owner dragged or resized it, persisted) keeps its saved size.

- **Anchor-aware cost.** `chromeCost()` charges each obstacle to the side it DECLARES. Taking `g.right` of everything is
  only true of left-anchored chrome. The anchor cannot be recovered from computed style: CSSOM resolves both `left` and
  `right` to used values for a positioned element, so a right-anchored card reports both and passes either test.
- **`.capnotice` is not in the list.** The bar places against the dock and its glyphs; the card is transient chrome with
  a dismiss button and lands under the bar afterwards. When the card was in the list and its top became computed, room
  went negative and the 9-across bar reflowed to a 48x350 column.
- **Floor at one column.** Frames cap at `Z_HI=25` and every element measured outranks them (`#dock` 27,
  `#micbtn`/`#earbtn` 45, `.capnotice` 60), so a bar left under them is unpressable; standing down (keeping 352) paints
  more of the bar under the glyphs. The floor is not a reachability guarantee: for `0 < room < 48` the bar is 48px in
  less clear space (fits down to innerWidth 166).
- **Finiteness guard.** `Math.max(48, NaN)` is NaN and `snapTo(NaN)` would paint it; `!Number.isFinite` also catches
  Infinity. Derived, not measured: no fixture sets innerWidth non-finite.
- **Re-derive, do not ratchet.** `Math.min(state.w, room)` can only shrink, and `state.w` is restored from storage, so
  one bad width would outlive its cause. An unplaced bar's width is always the room available now.

## Known gap: a placed bar on another surface

`_placed` also exempts a bar from `roomFor()`. Drag the bar to 352 at 1280x800, reload at 390x844, and it opens with
`sit` and `stand` under `#micbtn`/`#earbtn`. Local fixes are all worse:

- narrow it: discards the width the owner chose;
- slide it in x: 352 in 390 leaves 22px of slack and `fit()` already pins x;
- drop it in y: reachable, but below the vertical rail is mid-screen.

The real fix is a layout saved per surface (desktop vs mobile at minimum) at the persistence key in `windows.js`
(`const LS = ...`), so a desktop arrangement is never replayed onto a phone.

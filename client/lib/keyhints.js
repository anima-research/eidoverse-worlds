// keyhints — every modifier key and hidden gesture in edit mode, said where the hand is (R 10-04: "SOOOO much hidden
// knowledge in these programs that's nigh impossible to find"). Two tiers, her design:
//   before: in the control's tooltip (what you COULD do, on hover)
//   during: on the status line at the bottom while you're engaged (what the keys do RIGHT NOW)
// tools/keyhints-check.ts fails the build when code reads a modifier without a `// keys: <id>` tag naming an entry here,
// or when an entry is never shown. One import-free import (markup.js): panels.js and friends stay cycle-free; ui.js
// listens for the event. A `during` line is our own static markup, so it rides as markup (the bar shows plain text as text).
import { markup } from './markup.js';
export const KEYHINTS = {
  scrub:         { before: 'drag to change · Shift finer · Ctrl whole numbers · ↑/↓ step (Shift ×10) · click to type', during: '<kbd>Shift</kbd> finer · <kbd>Ctrl</kbd> whole numbers · <kbd>Esc</kbd> puts it back' },
  gizmo:         { before: 'drag a handle · hold Ctrl to snap (10 cm · 5° · 0.1×) · Esc cancels', during: 'hold <kbd>Ctrl</kbd> to snap (10 cm · 5° · 0.1×) · <kbd>Esc</kbd> cancels' },
  meshMove:      { before: 'drag the thing itself · Shift+drag raises and lowers · Esc cancels', during: '<kbd>Shift</kbd> raises and lowers · <kbd>Esc</kbd> cancels' },
  selectExtend:  { before: 'Ctrl- or Shift-click adds to the selection', during: null },
  undo:          { before: 'Ctrl+Z undo · Ctrl+Shift+Z or Ctrl+Y redo', during: null },
  jsonCommit:    { before: 'Ctrl+Enter commits · Esc reverts', during: null },
  duplicate:     { before: 'Ctrl+D (or Alt+D) duplicates the selection: an independent copy · Save as blueprint for copies that stay in step', during: null },
  editCamera:    { before: 'camera: drag bare space or Alt+drag to orbit · middle-drag pans · Alt+right-drag or the wheel dollies · F frames the selection', during: null },
  resetTransform: { before: 'Alt+G resets translate · Alt+E rotate · Alt+R scale · Ctrl+G all three (or right-click a channel)', during: null },
  toolKeys:      { before: 'Q select · G move · E rotate · R scale · P pivot · the same key again switches world/object axes', during: null },
  seatTurn:      { before: 'Q / E turn the seat (Shift: a little)', during: '<kbd>Q</kbd> / <kbd>E</kbd> turn · <kbd>Shift</kbd> a little · <kbd>Esc</kbd> done' },
  ghostKeys:     { before: 'while placing: Q / E turn it 15° · , / . size it (Shift: a little) · click places · Esc cancels', during: 'click places · <kbd>Q</kbd> / <kbd>E</kbd> turn · <kbd>,</kbd> / <kbd>.</kbd> size · <kbd>Shift</kbd> a little · <kbd>Esc</kbd> cancels' },
};
/** Put a gesture's keys on the status line while you're doing it. */
export function engage(id) { const h = KEYHINTS[id]?.during; if (h) dispatchEvent(new CustomEvent('ew-keyhint', { detail: markup(h) })); }
/** Give the status line back. */
export function release() { dispatchEvent(new CustomEvent('ew-keyhint', { detail: null })); }
/** A tooltip with the gesture's keys appended. */
export const withKeys = (title, id) => { const b = KEYHINTS[id]?.before; return !b ? title ?? '' : title ? `${title}\n${b}` : b; };

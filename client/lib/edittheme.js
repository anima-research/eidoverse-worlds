// edittheme — the ONE source of build mode's look (DESIGN-SPEC 2026-09-30, "Build mode: the look").
//
// Build mode is a dark-grey utilitarian editor (Blender / Godot / Resonite / Maya family): the chrome
// is grey and the WORLD is the only colour. Colour in the chrome means exactly one of: selection /
// focus (accent), an axis (x/y/z), danger, a driven value, or "only you" (mine). Nothing is coloured for decoration.
//
// Two surfaces read these values and must never drift:
//   - the desktop CSS (client/index.html, the `--e-*` block scoped to body.edit-workspace / .frame.edit)
//     carries them as literals — tools/edittheme-test.ts parses that block and fails on any difference;
//   - the VR canvas painter (panels.js renderCanvas, theme 'edit') imports them directly.
// Change a value HERE and in the CSS block together; the test tells you if you forgot one.

export const EDIT = Object.freeze({
  bg0: '#161618',        // rails, top bar, the outermost chrome
  bg1: '#1e1e21',        // panel body
  bg2: '#26262a',        // section header bars
  well: '#121214',       // input fields (sunken)
  line: '#2f2f35',       // separators, field edges
  hover: '#2c2c31',      // row / button hover
  press: '#36363c',      // pressed button, active tool
  text: '#d8d8dc',       // values, titles
  dim: '#8e8e96',        // labels
  faint: '#5e5e66',      // hints, placeholders, units
  accent: '#4d8ae0',     // selection, focus ring, active toggle, checked box (NOT the HUD's teal)
  accentBg: 'rgba(77,138,224,.18)',   // a selected row
  x: '#e06a62', y: '#82c45e', z: '#5f95e8',   // axis labels; the gizmo agrees
  danger: '#e07a72',     // destructive actions (quiet style)
  driven: '#c9a24a',     // a value a motion comp drives (the rest pose is shown): the ~ marker
  drivenEdge: 'rgba(201,162,74,.45)',   // …and the driven FIELD's edge — toned, so three driven axes don't out-shout their x/y/z labels
  mine: '#b08ad8',       // "only you": a view switch nobody else sees (the eye), never a shared state (research 10-12 R7)
});

/** The CSS custom property a token is written to: accentBg → --e-accent-bg. */
export const cssVar = (k) => `--e-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`;

/** The VR painter's floor (DESIGN-SPEC "VR affordances"): canvas px at 900 px/m. */
export const EDIT_VR = Object.freeze({
  rowH: 46,       // a painted row; every hit target inside it is >= minHit
  minHit: 34,     // ≈ 3.8 cm — a laser you can land
  minLine: 2,     // a 1-px line shimmers on a resampled quad
  minText: 17,    // ≈ 1.9 cm, ~1.3° at arm's length
  pad: 12,
  labelFrac: 0.38, labelMin: 72, labelMax: 170, gutter: 8,
});

/** Pictographs that edit chrome strings still carry (badges, a guard line from shared/editschema)
 *  → the icons.js glyph drawn in their place. The canvas emoji trap (a missing glyph paints
 *  NOTHING, silently, on the viewer's machine) makes this mandatory on the painter, and the DOM
 *  wears the same glyphs so the two surfaces agree. */
export const PICTO_ICON = Object.freeze({
  '🔒': 'lock', '🔓': 'lockOpen', '🛡': 'shield', '📜': 'scrollText', '🧍': 'personStanding',
  '🚪': 'doorOpen', '🪟': 'appWindow',
});
const PICTO_RE = /(\u{1F512}|\u{1F513}|\u{1F6E1}\u{FE0F}?|\u{1F4DC}|\u{1F9CD}|\u{1F6AA}|\u{1FA9F})/u;

/** Split text into runs: strings, and {icon} for a mapped pictograph. */
export function pictoRuns(s) {
  const out = [];
  for (const part of String(s ?? '').split(PICTO_RE)) {
    if (!part) continue;
    const icon = PICTO_ICON[part.replace('\u{FE0F}', '')];
    out.push(icon ? { icon } : part);
  }
  return out;
}
export const hasPicto = (s) => PICTO_RE.test(String(s ?? ''));

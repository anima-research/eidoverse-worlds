// platesize — how big a nameplate is and how visible, as a function of WORLD distance from the eye. Pure, so the
// test drives this very function (tools/platesize-test.ts); avatar.js applies it every frame.
//
// WHY this shape: nobody publishes a nameplate curve (BasisVR and Hubs keep plates world-fixed; VRChat hides names
// past 30 m), so the anchor is legibility. Microsoft's mixed-reality typography guidance puts the legible floor at
// ~0.4° of text height and comfortable reading at 0.6–0.75°. So: up close the plate is a world object (s = 1 — it
// doesn't balloon in your face); once its capitals would fall under 0.6° it holds 0.6° (grows with distance); past
// MAX_GROW it lets perspective shrink it again, so a far crowd recedes instead of becoming a wall of equal labels.
// OCCLUSION (owner, 09-30): a plate is hidden by scenery and by OTHER bodies, never by its owner's own — the sprite is
// depth-tested, but its depth is written as if it stood plateClear() metres nearer the eye than it is, and that
// clearance is the farthest its own body reaches from the plate's anchor (ownClearance: measured once per body, so a
// crown of tentacles through the plate doesn't cut it). The picture and its stereo depth stay where they are; only the
// depth TEST moves. Distance still thins the crowd.
//
// HOLD-TO-REVEAL (owner, 09-30): while the reveal key is held, every plate in range comes forward — drawn through
// everything (the clearance grows past the eye), at least the 0.6° size at any distance (no MAX_GROW shrink), and
// faded out only past REVEAL_FULL–REVEAL_GONE. `k` is the eased reveal level, 0..1 (revealLevel), so press and
// release both ease over REVEAL_EASE_MS instead of popping.

export const PLATE_W = 0.9;            // metres: the label sprite's width at s = 1 (a 512 px wide canvas; its height is plateBox's)
// Cap height of the 40 px name, MEASURED (canvas measureText + raster rows of 'H' in headless Chromium, 09-30: 30 px;
// Segoe UI Semibold is ~28). The sprite is 0.9 m per 512 px whatever the canvas height, so 30 px is 30 × 0.9/512 m.
export const PLATE_CAP_H = 30 * PLATE_W / 512;   // ≈ 0.0527 m
export const TEXT_DEG = 0.6;           // the comfortable-reading angle the caps hold at range
export const MAX_GROW = 3;             // the most a plate grows before perspective takes over again
export const PLATE_D0 = PLATE_CAP_H / Math.tan(TEXT_DEG * Math.PI / 180);   // ≈ 5.0 m: where 0.6° starts needing help
export const FADE_FULL = 20, FADE_GONE = 30;   // metres: full to 20, gone by 30 (VRChat's 30 m cut, softened)

export const REVEAL_FULL = 50, REVEAL_GONE = 60;   // metres: the held reveal's fade — 'every name within ~60 m'
export const REVEAL_EASE_MS = 120;                 // press and release both ease over this

const fade = (d, full, gone) => Math.min(1, Math.max(0, 1 - (d - full) / (gone - full)));

/** d = world distance eye→body (m); k = reveal level 0..1 (0 = normal). → { s: size factor, lw: sprite width (m),
 *  vis: opacity 0..1 } */
export function plateSize(d, k = 0) {
  const held = Math.max(1, d / PLATE_D0);   // 0.6° at any range, never under world size
  const s0 = Math.min(MAX_GROW, held);
  const s = s0 + (held - s0) * k;
  const vis = fade(d, FADE_FULL, FADE_GONE) + (fade(d, REVEAL_FULL, REVEAL_GONE) - fade(d, FADE_FULL, FADE_GONE)) * k;
  return { s, lw: PLATE_W * s, vis };
}

// ---- own-body clearance ------------------------------------------------------------------------------------------
// Only body points ABOVE (anchor − CLEAR_BAND) are counted: those are what stands between an eye and a plate floating
// at the head (head, hair, hat, horns, a raised hand); a torso or foot is only in front of it from directly beneath.
// MARGIN covers spring hair swinging past where it was measured. Clamped: never less than a head (a body not yet
// measured still clears its own skull), never more than a stride (past that the plate would show through a wall
// you're standing beside).
export const CLEAR_BAND = 0.5, CLEAR_MARGIN = 0.12, CLEAR_MIN = 0.35, CLEAR_MAX = 1.2;
/** reach = the farthest (m) any counted own-body point lies from the plate's anchor → the clearance to write. */
export const ownClearance = (reach) => Math.min(CLEAR_MAX, Math.max(CLEAR_MIN, (Number.isFinite(reach) ? reach : 0) + CLEAR_MARGIN));
/** Farthest counted point from the anchor, over a flat [x,y,z,…] list in the body's own frame (anchor at [0,ay,0]).
 *  Points under ay − CLEAR_BAND are skipped. */
export function reachAbove(xyz, ay) {
  let best = 0;
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const y = xyz[i + 1];
    if (y < ay - CLEAR_BAND) continue;
    const r = Math.hypot(xyz[i], y - ay, xyz[i + 2]);
    if (r > best) best = r;
  }
  return best;
}
/** The depth pull (m) a plate's sprite writes: its body's clearance, plus — while revealing — enough to pass the eye
 *  (the shader clamps to the near plane), so held plates draw through everything. At k ≥ 0.5 it is past the eye. */
export const plateClear = (own, d, k = 0) => own + 2 * Math.max(0, d) * k;

// ---- the reveal level ------------------------------------------------------------------------------------------
/** Linear ramp toward held (1) or released (0), from level k0 at time t0 (ms), at REVEAL_EASE_MS per full swing. */
export const revealRamp = (held, t0, k0, now) => Math.min(1, Math.max(0, k0 + (held ? 1 : -1) * (now - t0) / REVEAL_EASE_MS));
/** The eased level the plates use (smoothstep of the ramp): no velocity jump at either end. */
export const revealEase = (r) => r * r * (3 - 2 * r);


// ---- the plate's box ----------------------------------------------------------------------------------------
// avatar.js bakes the name onto a pill on a 512 px wide canvas. The pill is sized from the glyphs' MEASURED ink
// (canvas measureText actualBoundingBox*), not from the font size (owner, 10-01: descenders touched the pill's edge).
// Its height comes from the font's reference glyphs (a capital, the ascenders, the descenders), so "ggg" and "HHH" get
// the same plate; a name whose own ink reaches further (Å, an emoji) grows its pill instead of touching the edge. Not
// fontBoundingBox*: that box carries the font's line gap and sits well above the capitals, so the text would look low.
export const PLATE_TEX_W = 512, PLATE_PAD_Y = 12, PLATE_PAD_X = 24, PLATE_MARGIN = 6;
/** ink = the name's {asc, desc, width}; ref = the reference glyphs' {asc, desc} (px, at the bake font) →
 *  { w, h: the canvas; pillW, pillH; top: the pill's top; baseline: where the name is drawn } (integer px) */
export function plateBox(ink, ref) {
  const asc = Math.ceil(Math.max(ink.asc || 0, ref.asc || 0)), desc = Math.ceil(Math.max(ink.desc || 0, ref.desc || 0));
  const pillH = asc + desc + 2 * PLATE_PAD_Y;
  const pillW = Math.min(PLATE_TEX_W - 2 * PLATE_MARGIN, Math.ceil(ink.width || 0) + 2 * PLATE_PAD_X);
  return { w: PLATE_TEX_W, h: pillH + 2 * PLATE_MARGIN, pillW, pillH, top: PLATE_MARGIN, baseline: PLATE_MARGIN + PLATE_PAD_Y + asc };
}

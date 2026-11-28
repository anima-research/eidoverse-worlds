// xrringpaint — the VR ring's repaint, apart from xr.js so it runs headless (test/client/xr-ring-repaint-test.mjs).
// A slot's art is a texture drawn from its entry; a repaint disposes the old one and draws anew.

/** Does this entry draw a live glyph (its `svg` is a function, read on every repaint: the mic, the headphones)? */
export const liveGlyph = (e) => typeof e?.svg === 'function';

/** Redraw the ring's slots, or only those whose entry `only` picks. */
export function repaintSlots(radial, texture, only = null) {
  if (!radial) return;
  radial.slots.forEach((m, i) => {
    if (only && !only(radial.entries[i])) return;
    m.material.map?.dispose(); m.material.map = texture(radial.entries[i], i === radial.sel); m.material.needsUpdate = true;
  });
}

/** The mic's glyph changes with no selection or act (gold, a mute): redraw the live-glyph slots of the open ring as it does,
 *  and nothing else (a wheel without one rebuilds nothing). `openRing()` is the ring while it is open, else null. */
export const followMicIndicator = (bus, openRing, texture) =>
  bus.on('mic:indicator', () => repaintSlots(openRing(), texture, liveGlyph));

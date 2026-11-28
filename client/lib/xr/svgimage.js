// svgimage — an SVG reaches a canvas through an Image, and an Image never loads in the turn its src is set: a glyph
// asked for and drawn that way leaves one uploaded frame of its disc with nothing on it. So each SVG text keeps its
// loaded Image, and from its second asking it is drawn in the turn (the VR mic icon and the ring's slots, whose glyphs
// are a small fixed set per ink).
import { warnRarely } from '../base.js';
const _loaded = new Map();   // the SVG's text → its loaded Image

/** Draw `svg` through `draw(img)`: now if it has loaded before (returns true), else once it loads (returns false).
 *  An image that fails to load draws nothing and keeps nothing, so the next asking tries again; the console is told
 *  (once a minute, base.js warnRarely), because what it leaves is a disc or a slot with nothing on it. */
export function svgImage(svg, draw) {
  const hit = _loaded.get(svg);
  if (hit) { draw(hit); return true; }
  const img = new Image();
  img.onload = () => { _loaded.set(svg, img); draw(img); };
  // a standalone SVG is XML: one malformed attribute and it never loads (the start of the text is enough to find it)
  img.onerror = (e) => warnRarely('svg-image', `[svgimage] an SVG glyph failed to load, and is not drawn: ${svg.slice(0, 120)}`, e);
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  return false;
}

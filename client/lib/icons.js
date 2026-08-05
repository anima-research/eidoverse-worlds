// icons — one Lucide registry, three renderers, no font dependency anywhere.
//
// WHY THIS EXISTS (R, 00:19: "replace all the icons if you can"): canvas
// `fillText` of an emoji silently paints NOTHING when the platform lacks that
// glyph. No error, no fallback, no warning — just a UI element that means
// something and shows nothing. It happened live on a Windows 11 desktop with
// two different codepoints, BOTH of which rasterized correctly in headless
// Chromium, so the fault was invisible to the tests as well as to me. Any
// emoji that carries meaning in this UI is a silent-failure risk.
//
// Path data is verbatim from lucide-icons/lucide (ISC licence), 24x24 viewBox.
// Same technique as porch-old's PORCH_ICONS: store the `d` strings, build
// Path2D lazily, and let each surface render them its own way.
//
//   stroke(ctx, name, size)  → canvas / 3D sprite (Path2D, cached)
//   svg(name, size)          → inline <svg> markup for DOM chrome
//   has(name)                → registry probe
//
// Adding an icon: curl the SVG from
// raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg and
// paste its path `d` strings here. Do NOT hand-draw replacements — that was
// tried first and read as blobs at 26px.

const P = {
  ear: ['M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0',
        'M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4'],
  // message-circle-more: Lucide has no literal thought-cloud, and `brain` is
  // mush at pill size. A bubble with an ellipsis IS the composing idiom.
  think: ['M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719',
          'M8 12h.01', 'M12 12h.01', 'M16 12h.01'],
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z'],
  mic: ['M12 19v3', 'M19 10v2a7 7 0 0 1-14 0v-2'],
  messageSquare: ['M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'],
  boxes: ['M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z',
          'm7 16.5-4.74-2.85', 'm7 16.5 5-3', 'M7 16.5v5.17',
          'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
          'M16 3.128a4 4 0 0 1 0 7.744', 'M22 21v-2a4 4 0 0 0-3-3.87',
          'M10 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
  hand: ['M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2', 'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2',
         'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8',
         'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'],
  bug: ['M12 20v-9', 'M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z',
        'M14.12 3.88 16 2', 'M21 21a4 4 0 0 0-3.81-4', 'M21 5a4 4 0 0 1-3.55 3.97',
        'M22 13h-4', 'M3 21a4 4 0 0 1 3.81-4', 'M3 5a4 4 0 0 0 3.55 3.97', 'M6 13H2'],
};

// rounded-rect ops that some icons need beyond their paths: [x,y,w,h,rx]
const RECT = { mic: [9, 2, 6, 13, 3] };

const _cache = new Map();
function paths(name) {
  if (!_cache.has(name)) {
    const list = (P[name] ?? []).map((d) => new Path2D(d));
    const r = RECT[name];
    if (r) { const q = new Path2D(); q.roundRect(...r); list.push(q); }
    _cache.set(name, list);
  }
  return _cache.get(name);
}

export const has = (name) => !!P[name];

/** Stroke a Lucide icon centred on the current origin, sized to `size` px. */
export function stroke(ctx, name, size = 26) {
  if (!P[name]) return false;
  const k = size / 24;
  ctx.save();
  ctx.scale(k, k);
  ctx.translate(-12, -12);
  ctx.lineWidth = 2 / k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of paths(name)) ctx.stroke(path);
  ctx.restore();
  return true;
}

/** Inline SVG markup for DOM chrome — same registry, different surface. */
export function svg(name, size = 18) {
  const d = P[name];
  if (!d) return '';
  const r = RECT[name];
  const rect = r ? `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="${r[4]}"/>` : '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${d.map((p) => `<path d="${p}"/>`).join('')}${rect}</svg>`;
}

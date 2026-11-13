// ?mintthumbs — render a portrait for every body on the roster, post them back, then stop. Contribution-as-you-wear
// keeps the roster fresh but cannot seed it; this is the one-time (and after-adding-VRMs) baseline pass.
// Dynamically imported by main.js, so the normal boot never loads this file.

import { CONFIG } from './base.js';
import { contributeThumbnail } from './avatar/avatar.js';

export async function mintThumbnails() {
  const { loadVRM } = await import('./assets.js');
  const list = await fetch('/avatars').then((r) => r.json());
  const out = [];
  for (const a of list) {
    try {
      const vrm = await loadVRM(a.path);
      const ok = await contributeThumbnail(a.name, vrm, CONFIG.token, { force: true, path: a.path });
      out.push(ok ? `ok ${a.name}` : `skip ${a.name}`);   // skip: a blank readback or a refused POST (avatar.js says which on the tee)
    } catch (e) { out.push(`FAIL ${a.name}: ${e.message}`); }
    console.log(`[mint] ${out[out.length - 1]}  (${out.length}/${list.length})`);
  }
  console.log(`[mint] done ${out.filter((s) => s.startsWith('ok')).length}/${list.length}`);
  globalThis.__mintDone = out;
}

// ?mintthumbs — render a portrait for every body on the roster and post them
// back, then stop. Contribution-as-you-wear keeps the roster fresh, but it
// cannot SEED it: a first visitor met one portrait and seventeen blank cards.
// This is the one-time (and after-adding-VRMs) pass that gives it a baseline.
//
// Dynamically imported by main.js — the normal boot never pays for this file,
// and this file never starts the normal boot.

import { CONFIG } from './base.js';
import { contributeThumbnail } from './avatar.js';

export async function mintThumbnails() {
  const { loadVRM } = await import('./assets.js');
  const list = await fetch('/avatars').then((r) => r.json());
  const out = [];
  for (const a of list) {
    try {
      const vrm = await loadVRM(a.path);
      await contributeThumbnail(a.name, vrm, CONFIG.token, { force: true });
      out.push(`ok ${a.name}`);
    } catch (e) { out.push(`FAIL ${a.name}: ${e.message}`); }
    console.log(`[mint] ${out[out.length - 1]}  (${out.length}/${list.length})`);
  }
  console.log(`[mint] done ${out.filter((s) => s.startsWith('ok')).length}/${list.length}`);
  globalThis.__mintDone = out;
}

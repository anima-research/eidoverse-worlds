// xr-ring-probe — every slot on the VR ring draws its glyph (debug/world/chat drew blank discs: the ring read only
// entry.icon, the rail also its id/emoji fallbacks), and the focus label draws over the slots, in the ring's centre.
// Every pinned panel's ring entry has an icon (dockPins, the rail's id/emoji fallbacks included). Real client + IWER.
//   bun test/client/xr-ring-probe.mjs
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR, drawn } from '../harness/probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg);
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=ringprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await enterVR(pg);
  await drawn(pg, 60);   // the panels' first frames in the headset
  const r = await pg.evaluate(async () => {
    const xr = await import('./lib/xr/xr.js'); const ui = await import('./lib/ui.js');
    const pins = ui.dockPins().map((p) => ({ id: p.id, icon: p.icon ?? null }));
    const entries = xr.radialEntries(); const ring = xr.makeRadial(entries);
    await Promise.all(ring.slots.map((m) => m.material?.map?.ready ?? null));   // svg glyphs load async
    for (let i = 0; i < 60; i++) await new Promise((r) => requestAnimationFrame(r));
    // a slot "draws its glyph" when its canvas has ink INSIDE the disc beyond the plain panel fill: count pixels that
    // differ from the disc colour in the central 60x60 (the glyph box)
    const ink = ring.slots.map((m, i) => {
      const e = entries[i]; if (e.spacer) return null;
      const c = m.material.map.image, g = c.getContext('2d'), d = g.getImageData(34, 34, 60, 60).data;
      let n = 0; for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - 5) + Math.abs(d[k + 1] - 20) + Math.abs(d[k + 2] - 20) > 60) n++;
      return { label: e.label, n };
    }).filter(Boolean);
    const maxSlot = Math.max(...ring.slots.map((m) => m.renderOrder));
    return { pins, ink, labelOrder: ring.label.mesh.renderOrder, maxSlot, labelPos: ring.label.mesh.position.toArray().map((v) => +v.toFixed(3)) };
  });
  console.log('  ·', JSON.stringify(r));
  const blank = r.ink.filter((s) => s.n < 30).map((s) => s.label);
  check('every ring slot draws a glyph (no blank discs)', blank.length === 0, `blank: ${blank.join(', ') || 'none'}`);
  check('(setup) the ring has pins beyond debug/world/chat', r.pins.some((p) => !['debug', 'world', 'chat'].includes(p.id)), JSON.stringify(r.pins.map((p) => p.id)));
  for (const p of r.pins) check(`the ring's ${p.id} pin has an icon`, !!p.icon, JSON.stringify(p));
  check('the focus label draws after every slot', r.labelOrder > r.maxSlot, `${r.labelOrder} vs ${r.maxSlot}`);
  check('…from the ring\'s centre, clear of the 6 o\'clock icon', Math.abs(r.labelPos[0]) < 1e-3 && Math.abs(r.labelPos[1]) < 1e-3, JSON.stringify(r.labelPos));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();

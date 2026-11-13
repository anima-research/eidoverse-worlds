// xr-ring-probe — every slot on the VR ring draws its glyph (debug/world/chat drew blank discs: the ring read only
// entry.icon, the rail also its id/emoji fallbacks), and the focus label draws over the slots, in the ring's centre.
// (was: xr-panel-drag-probe — a trigger on EMPTY panel space is a press: drag it and the panel scrolls with the laser, release
// without dragging and it clicks; a trigger on a control (a checkbox) still acts at once, exactly once. The owner
// couldn't scroll the debug panel in a headset (09-27): the stick scrolled only while a button held the laser up.
// Real client + IWER; the rays go through the same domQuadsPress/Drag/Release path xr.js drives from the trigger.
//   bun tools/xr-panel-drag-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await pg.addInitScript(IWER);
await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=ringprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(async () => {
    const xr = await import('./lib/xr.js'); const ui = await import('./lib/ui.js');
    const pins = ui.dockPins().map((p) => ({ id: p.id, icon: p.icon ?? null }));
    const entries = xr.radialEntries(); const ring = xr.makeRadial(entries);
    await new Promise((res) => setTimeout(res, 800));   // svg glyphs load async
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
  for (const id of ['debug', 'world', 'chat']) { const p = r.pins.find((x) => x.id === id); if (p) check(`the ring's ${id} pin has an icon`, !!p.icon, JSON.stringify(p)); }
  check('the focus label draws after every slot', r.labelOrder > r.maxSlot, `${r.labelOrder} vs ${r.maxSlot}`);
  check('…from the ring\'s centre, clear of the 6 o\'clock icon', Math.abs(r.labelPos[0]) < 1e-3 && Math.abs(r.labelPos[1]) < 1e-3, JSON.stringify(r.labelPos));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();

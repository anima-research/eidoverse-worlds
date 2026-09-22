// sound-probe — the owned browser receipt for the `sound` component: a real
// sequencer, a real model, a real WAV through the audio door.
//
//   bun tools/sound-probe.ts          (EIDOVERSE_DIR must point at the library)
//
// What must hold, in order:
//   A. a sound comp on a placed entity builds ONE graph on the page's shared
//      AudioContext: <audio> → gain → panner → destination, panner following
//      the entity's world position;
//   B. it PLAYS after the first gesture (the shared unlock queue), and with a
//      t0 in the past it seeks to the shared playhead, not the top;
//   C. a replace with the same src adjusts in place (volume), no second graph;
//   D. playing:false pauses; data:null tears the graph down;
//   E. a URL source realizes nothing;
//   F. the LISTENER's world volume (the audio panel's slider, voiceconsent
//      volumeFor('world')) is what a sound is heard at, composed with the
//      authored volume and never replacing it: the page boots with the
//      preference at 0 and the authored 0.5 is silent; the slider moving to
//      1 is heard live; a partial 0.5 under an authored 0.9 is 0.45; a
//      same-source update to 0.6 under it is 0.3; the sound gone and back
//      (entity removed, respawned, re-authored) comes back under the same
//      preference (Mica, #192 review, blocker 1: the slider had promised
//      "ambience and place-sound" since 2026-08-16 and the first placed
//      sound ignored it).
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wavBytes } from './wav-fixture.ts';

const LIB = 'eidoverse/assets/models/crate_large_red.glb';
const { check, done } = checker();
const OPT = mkdtempSync(join(tmpdir(), 'soundprobe-opt-'));
const world = await ownedWorld({ env: { EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), OPT_DIR: OPT } });
const { page, close } = await launchBrowser();
const errs: string[] = [];
const state = (pg: any) => pg.evaluate(async () => {
  const { _playing, _worldBus, effectiveGain } = await import('/lib/sounds.js');
  const { audioContextState } = await import('/lib/audioctx.js');
  const { entities } = await import('/lib/world.js');
  const h = _playing.get('box1');
  const root = entities.get('box1');
  const pos = root ? (() => { const v = root.getWorldPosition(new (root.position.constructor)()); return [v.x, v.y, v.z]; })() : null;
  return {
    entity: !!root, graphs: _playing.size, has: !!h,
    src: h?.el?.currentSrc ?? h?.el?.src ?? null, paused: h?.el?.paused ?? null, t: h?.el?.currentTime ?? null, dur: h?.el?.duration ?? null,
    gain: h?.gain?.gain?.value ?? null, world: _worldBus()?.gain?.value ?? null, eff: effectiveGain('box1'), panner: h ? [h.panner.positionX?.value ?? null, h.panner.positionY?.value ?? null, h.panner.positionZ?.value ?? null] : null,
    ctx: audioContextState(), entityPos: pos,
  };
});
const until = async (pg: any, pred: (s: any) => boolean, ms = 30000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(pg); if (pred(s)) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
try {
  // a 30 s WAV so the seek is measurable
  const up = await fetch(`${world.origin}/upload?as=audio&name=probe%20tone&token=${world.key}`, { method: 'POST', body: wavBytes(30) });
  const src = (await up.json()).path as string;
  check('a WAV went through the audio door', /^store\/audio\/[a-f0-9]{16}\.wav$/.test(src), src);
  const pg = await page();
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { const t = m.text(); if (/\[sounds\]/.test(t)) console.log('   console:', t.slice(0, 200)); });
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  // F. the listener arrives with world volume at 0 — set before any page
  // script runs, exactly as a saved preference would be
  await pg.addInitScript(() => { try { localStorage.setItem('eido.audio.prefs', JSON.stringify({ volWorld: 0 })); } catch { /* private mode */ } });
  await pg.goto(`${world.origin}/?world=soundprobe&key=${world.key}&name=listener`, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#micbtn, #mictoggle', { timeout: 30000 });
  await pg.evaluate((lib) => import('/lib/net.js').then((n: any) => n.sendVerb('spawn', { id: 'box1', lib, pos: [2, 0, -3], yaw: 0 })), LIB);
  let s = await until(pg, (x) => x.entity, 90_000);
  check('the model spawned', s.entity, JSON.stringify(s));
  const t0 = Date.now() - 10_000;   // started ten seconds ago
  await pg.evaluate(({ src, t0 }) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src, t0, look: 'a probe tone', volume: 0.5, radius: 20 } })), { src, t0 });
  s = await until(pg, (x) => x.has && x.dur > 0);
  check('A. one graph on the shared context, sourced from the store path', s.has && s.graphs === 1 && String(s.src).includes(src.split('/').pop()!) && s.ctx !== 'none', JSON.stringify(s));
  check('A. the gain carries the volume', s.gain === 0.5, JSON.stringify(s.gain));
  check('F. …and with the listener\'s world volume at 0 it is heard at 0, the authored 0.5 preserved', s.world === 0 && s.eff === 0 && s.gain === 0.5, JSON.stringify({ gain: s.gain, world: s.world, eff: s.eff }));
  await pg.evaluate(() => import('/lib/voiceconsent.js').then((v: any) => v.setVolume('world', 1)));
  s = await until(pg, (x) => x.eff != null && Math.abs(x.eff - 0.5) < 1e-3, 3000);
  check('F. the slider moving to 1 is heard live: 0.5', Math.abs((s.eff ?? 0) - 0.5) < 1e-3 && s.world === 1, JSON.stringify({ world: s.world, eff: s.eff }));
  s = await until(pg, (x) => x.panner && Math.abs(x.panner[0] - x.entityPos[0]) < 0.05 && Math.abs(x.panner[2] - x.entityPos[2]) < 0.05, 8000);
  check('A. the panner sits where the entity is', !!s.panner && Math.abs(s.panner[0] - 2) < 0.1 && Math.abs(s.panner[2] + 3) < 0.1, JSON.stringify({ panner: s.panner, entity: s.entityPos }));
  // B. a gesture unlocks playback
  await pg.mouse.click(640, 200);
  await pg.keyboard.press('Shift');
  s = await until(pg, (x) => x.paused === false && x.t > 0, 15000);
  check('B. it plays after a gesture', s.paused === false && s.t > 0, JSON.stringify({ paused: s.paused, t: s.t, ctx: s.ctx }));
  // the shared playhead is a function of the clock, not of when we looked:
  // (now - t0) mod duration, measured at the moment of the read
  const expected = ((Date.now() - t0) / 1000) % 30;
  check('B. …from the shared playhead ((now - t0) mod duration), not the top', Math.abs(s.t - expected) < 2.5 && s.t > 5, `currentTime=${s.t.toFixed(2)} expected≈${expected.toFixed(2)}`);
  // C. same src, new volume: in place
  await pg.evaluate(({ src, t0 }) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src, t0, look: 'a probe tone', volume: 0.9, radius: 20 } })), { src, t0 });
  s = await until(pg, (x) => Math.abs((x.gain ?? 0) - 0.9) < 1e-3, 5000);   // AudioParam holds float32
  check('C. a same-src replace adjusts in place: volume 0.9, still one graph, still playing', Math.abs(s.gain - 0.9) < 1e-3 && s.graphs === 1 && s.paused === false, JSON.stringify(s));
  // F. a partial preference composes with the authored volume, and follows a same-source update
  await pg.evaluate(() => import('/lib/voiceconsent.js').then((v: any) => v.setVolume('world', 0.5)));
  s = await until(pg, (x) => x.eff != null && Math.abs(x.eff - 0.45) < 1e-3, 3000);
  check('F. world 0.5 under authored 0.9 is heard at 0.45, authored kept at 0.9', Math.abs((s.eff ?? 0) - 0.45) < 1e-3 && Math.abs(s.gain - 0.9) < 1e-3, JSON.stringify({ gain: s.gain, world: s.world, eff: s.eff }));
  await pg.evaluate(({ src, t0 }) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src, t0, look: 'a probe tone', volume: 0.6, radius: 20 } })), { src, t0 });
  s = await until(pg, (x) => x.eff != null && Math.abs(x.eff - 0.3) < 1e-3, 5000);
  check('F. a same-src update to 0.6 under world 0.5 is heard at 0.3, one graph', Math.abs((s.eff ?? 0) - 0.3) < 1e-3 && s.graphs === 1, JSON.stringify({ gain: s.gain, world: s.world, eff: s.eff, graphs: s.graphs }));
  // F. gone and back: the entity removed takes its graph; respawned and re-authored, it is heard under the same preference
  await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.sendVerb('remove', { id: 'box1' })));
  s = await until(pg, (x) => !x.has && !x.entity, 8000);
  check('F. the entity removed: no graph', !s.has && s.graphs === 0, JSON.stringify({ has: s.has, graphs: s.graphs, entity: s.entity }));
  await pg.evaluate((lib) => import('/lib/net.js').then((n: any) => n.sendVerb('spawn', { id: 'box1', lib, pos: [2, 0, -3], yaw: 0 })), LIB);
  s = await until(pg, (x) => x.entity, 90_000);
  await pg.evaluate(({ src, t0 }) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src, t0, look: 'a probe tone', volume: 0.9, radius: 20 } })), { src, t0 });
  s = await until(pg, (x) => x.has && x.eff != null && Math.abs(x.eff - 0.45) < 1e-3, 15000);
  check('F. …respawned and re-authored at 0.9, heard at 0.45 under the listener\'s 0.5 that never changed', s.has && Math.abs((s.eff ?? 0) - 0.45) < 1e-3 && s.world === 0.5, JSON.stringify({ gain: s.gain, world: s.world, eff: s.eff }));
  await pg.evaluate(() => import('/lib/voiceconsent.js').then((v: any) => v.setVolume('world', 1)));
  // D. pause, then silence
  await pg.evaluate(({ src }) => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src, look: 'a probe tone', playing: false } })), { src });
  s = await until(pg, (x) => x.paused === true, 5000);
  check('D. playing:false pauses', s.paused === true, JSON.stringify(s));
  await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: null })));
  s = await until(pg, (x) => !x.has, 5000);
  check('D. data:null tears the graph down', !s.has && s.graphs === 0, JSON.stringify(s));
  // E. a URL source
  await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.sendVerb('comp', { id: 'box1', type: 'sound', data: { src: 'https://example.com/x.mp3', look: 'smuggled' } })));
  await new Promise((r) => setTimeout(r, 1200));
  s = await state(pg);
  check('E. a URL source realizes nothing', !s.has && s.graphs === 0, JSON.stringify(s));
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} catch (e: any) {
  console.log('probe aborted:', e?.message ?? e); if (errs.length) console.log('page errors:', errs.join(' | '));
  check('the probe ran to the end', false, e?.message ?? String(e));
} finally { await close(); await world.close(); }
done();

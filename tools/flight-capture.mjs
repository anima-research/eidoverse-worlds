// flight-capture — deterministic evidence, one screenshot per fixed step.
//
//   bun tools/flight-capture.mjs                 # both takes
//   bun tools/flight-capture.mjs --take A        # just the leaf
//   bun tools/flight-capture.mjs --fps 30 --out /tmp/clips
//
// mica's path, and the reasoning is theirs: do NOT reuse render-watchdog (it
// owns production renderer liveness, not evidence), and do NOT record with
// rAF/MediaRecorder, because a dropped frame is then indistinguishable from a
// slow one and the clip stops being measurable. Instead:
//
//   1. the bench page exposes window.__flightBench.step(dt) and does NOTHING
//      on its own -- no rAF loop exists to drop a frame from;
//   2. this advances exactly 1/fps per frame and screenshots after each;
//   3. ffmpeg encodes the PNG sequence at a CONSTANT rate;
//   4. the overlay is burned into the page before the screenshot, so the
//      numbers on screen are the numbers that state actually held.
//
// Two matched takes from IDENTICAL initial state and config:
//   A -- >=15m falling leaf through honest ground contact. No flare, no
//        autoland, no last-metre mercy hover.
//   B -- the same drop with RECOVER injected mid-descent: finish the beat,
//        reload the wings, resume glide. Non-instant, <= one 3.4s cycle.
//
// OWNERSHIP: this owns its server, its browser and its frame directory, and
// tears all three down on success AND on failure. A capture that leaves a
// chromium behind has failed even if the file is fine.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, extname, resolve } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FPS = +arg('--fps', 60);
const OUT = resolve(arg('--out', 'tools/flightbench/out'));
const ONLY = arg('--take', null);
const ROOT = resolve('.');
const DT = 1 / FPS;

// The rig the bench flies. Derived from the shipped asset by
// tools/flight-fixture.ts -- a hand-typed list could not go stale against the
// file, so it would prove nothing about the file.
const FIX = JSON.parse(readFileSync('spec/fixtures/mythos-wings-rig.json', 'utf8'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.mjs': 'text/javascript' };

/** A scratch static server over the repo. Its own port, torn down by the
 *  caller -- never an ambient one, so a capture cannot silently record
 *  whatever else happens to be listening. */
function serve() {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream',
                         'cache-control': 'no-store' });
    res.end(readFileSync(f));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

const encode = (dir, out, fps) => new Promise((res, rej) => {
  const ff = spawn('ffmpeg', ['-y', '-framerate', String(fps), '-i', join(dir, 'f%06d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
    '-vf', `fps=${fps}`, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', d => { err += d; });
  ff.on('close', c => c === 0 ? res() : rej(new Error(`ffmpeg ${c}\n${err.slice(-1500)}`)));
});

async function take(page, { name, seconds, injectRecoverAt }) {
  const frames = join(OUT, `frames-${name}`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  // IDENTICAL initial state and config for both takes -- that is what makes
  // them matched, and matched is what lets Mythos attribute the difference to
  // the recovery rather than to the drop.
  // 30 m, so BOTH takes are legible: A has room for several full oscillations
  // before contact, and B's recovery finishes with real air underneath rather
  // than skimming the dirt -- a recovery that completes at 0.2 m is correct and
  // unmeasurable, which is not what the take is for.
  const START_Y = 30;
  const r = await page.evaluate(({ bones, startY }) => {
    window.__flightBench.setTop(startY);
    return window.__flightBench.enableFlight({
      identity: 'mythos', bones, startY,
      config: { bounds: { ceiling: 100000, radius: 100000 } },  // the fence is not the subject
    });
  }, { bones: FIX.bones, startY: START_Y });
  if (!r?.enabled) throw new Error(`bench refused to enable: ${r?.reason}`);

  // Cut immediately: the take is about the leaf, not the glide before it.
  await page.evaluate(() => {
    window.__flightBench.setKeys([]);
    window.__flightBench.down('take-cut');
  });

  const total = Math.round(seconds * FPS);
  const telemetry = [];
  let injected = false, landedAt = null;
  for (let i = 0; i < total; i++) {
    if (injectRecoverAt != null && !injected) {
      const s = await page.evaluate(() => window.__flightBench.snapshot());
      if (s && s.t >= injectRecoverAt) {
        await page.evaluate(() => window.__flightBench.recover('take-recover', 'gen-1'));
        injected = true;
      }
    }
    const snap = await page.evaluate((dt) => window.__flightBench.step(dt), DT);
    await page.screenshot({ path: join(frames, `f${String(i).padStart(6, '0')}.png`) });
    if (snap) {
      telemetry.push(snap);
      if (snap.phase === 'RAGDOLL' && landedAt === null) landedAt = snap.t;
    }
  }

  const mp4 = join(OUT, `take-${name}.mp4`);
  await encode(frames, mp4, FPS);
  rmSync(frames, { recursive: true, force: true });     // frames are scaffolding

  const events = await page.evaluate(() => window.__flightBench.events());
  const config = await page.evaluate(() => window.__flightBench.config());
  return { name, mp4, frames: total, fps: FPS, seconds, landedAt, injectRecoverAt,
           events, config, telemetry };
}

let srv = null, browser = null, code = 0;
try {
  mkdirSync(OUT, { recursive: true });
  const s = await serve(); srv = s.srv;
  browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => { throw e; });
  await page.goto(`http://127.0.0.1:${s.port}/tools/flightbench/bench.html`);
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 20000 });

  const takes = [];
  if (ONLY !== 'B') takes.push(await take(page, { name: 'A', seconds: 15 }));
  if (ONLY !== 'A') takes.push(await take(page, { name: 'B', seconds: 15, injectRecoverAt: 2.4 }));

  // The RECEIPT. A clip without one is a video; with one it is evidence.
  const receipt = {
    generatedFor: 'flight-spec-v0 Stage 1, takes A/B',
    fps: FPS,
    fixedTimestep: DT,
    body: { source: FIX.source, bytes: FIX.bytes, sha256: FIX.sha256, boneCount: FIX.boneCount },
    specs: {
      'flight-spec-v0.md': '641da611754c7097142e16b355a6dd79b4d431646e0c1d890759884f86fbe805',
      'down-spec-v0.1.md': '71e4fff28fbc6145f452df9a8b7a03b3fbbcd0bf9eba471f207edbd3435c0a91',
    },
    takes: takes.map(t => ({
      name: t.name, mp4: t.mp4, frames: t.frames, seconds: t.seconds,
      landedAt: t.landedAt, injectRecoverAt: t.injectRecoverAt,
      sha256: createHash('sha256').update(readFileSync(t.mp4)).digest('hex'),
      events: t.events.map(e => ({ frame: e.frame, t: e.t, kind: e.kind,
        eventId: e.eventId ?? null, altitude: e.altitude ?? null, impactV: e.impactV ?? null })),
    })),
    config: takes[0]?.config ?? null,
  };
  writeFileSync(join(OUT, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  for (const t of takes) {
    writeFileSync(join(OUT, `telemetry-${t.name}.json`), JSON.stringify(t.telemetry) + '\n');
    console.log(`  ${t.name}: ${t.mp4}  ${t.frames} frames @ ${FPS}fps` +
                (t.landedAt != null ? `, ground at t=${t.landedAt.toFixed(2)}s` : ', still airborne'));
    for (const e of t.events) console.log(`      f${String(e.frame).padStart(5)} ${e.kind}`);
  }
  console.log(`  receipt: ${join(OUT, 'receipt.json')}`);
} catch (e) {
  console.error('CAPTURE FAILED:', e?.message ?? e);
  code = 1;
} finally {
  // Own the teardown on BOTH paths. A capture that leaves a chromium running
  // has failed even when the file is fine.
  try { await browser?.close(); } catch {}
  try { srv?.close(); } catch {}
}
process.exit(code);

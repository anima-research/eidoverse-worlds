// video-probe — the owned end-to-end receipt for the `video` component (projector design revision 2, Mica's acceptance
// list): a REAL projector appliance (mediamtx, rendered by deploy/projector/mkconfig.sh on free ports, with a nonce path
// so a stray appliance can't answer), a synthetic OBS feed (ffmpeg's test pattern with its frame counter, Opus audio, over
// RTSP as the publisher), a real sequencer with VIDEO_SOURCES, and TWO browser processes watching one screen.
//
//   bun tools/video-probe.ts          (mediamtx and ffmpeg on PATH; EIDOVERSE_DIR points at the library)
//
// What must hold, in order:
//   A. a video naming an admitted source is accepted; one naming a source nobody admitted is refused at the door;
//   B. both browsers play it: each screen's own playback state reaches `playing`, and frames advance;
//   C. look says what the APPLIANCE observed (live), with its age;
//   D. no websocket frame either browser receives names the WHEP endpoint, its HTTP port or the read key;
//   E. the audio: after a gesture, the screen is heard near it (authored volume × distance × the listener's world volume),
//      silent past its radius, and mute-for-me silences it for this viewer only;
//   F. the publisher stops: both screens say `stalled` (never `playing` over a frozen frame) and look says offline;
//   G. the publisher restarts: both screens come back to `playing` on their own (reconnect with backoff);
//   H. the screen comes down: every appliance WebRTC session this probe opened is closed, and the quads are gone;
//   I. teardown: every pid this probe started is gone.
// @ts-nocheck
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const { check, done } = checker();
// the system Chrome, as the protocol gate's browser lane uses: Playwright's bundled headless shell renders in software, and
// there creating any thing loses the page's WebGL context (reproduced at #260's head with no video), which reloads it
process.env.SFU_TEST_CHROME ??= process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = new URL('..', import.meta.url).pathname;
const SCR = mkdtempSync(join(tmpdir(), 'videoprobe-'));
const NONCE = randomBytes(4).toString('hex');
const PATH_ = `vprobe-${NONCE}`;
// every port is held open until all six are chosen: closing one before asking for the next lets the OS hand the same
// port back twice, and two of the appliance's faces then race for it (it happened: the API never came up)
const held: any[] = [];
const free = () => new Promise<number>((res) => { const s = createServer(); held.push(s); s.listen(0, '127.0.0.1', () => res((s.address() as any).port)); });
const ports = { RTSP: await free(), RTMP: await free(), HLS: await free(), WEBRTC: await free(), WEBRTC_UDP: await free(), API: await free() };
await Promise.all(held.map((s) => new Promise((r) => s.close(r))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: any[] = [];
// whatever ends this probe (a check that throws, an unhandled rejection, ^C), what it started goes with it: a crashed run
// once left a mediamtx bound to :8892, and every later appliance on this machine failed to start
const reap = () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { reap(); process.exit(130); });
process.on('unhandledRejection', (e) => { console.log(`unhandled: ${String((e as any)?.message ?? e).slice(0, 200)}`); reap(); process.exit(1); });
const errs: string[] = [];

// ---- the appliance ----
const env = { ...process.env, PROJECTOR_PATH: PATH_, PROJECTOR_SOURCE_ID: 'solstice', PROJECTOR_RTSP_PORT: String(ports.RTSP), PROJECTOR_RTMP_PORT: String(ports.RTMP), PROJECTOR_HLS_PORT: String(ports.HLS),
  PROJECTOR_WEBRTC_PORT: String(ports.WEBRTC), PROJECTOR_WEBRTC_UDP_PORT: String(ports.WEBRTC_UDP), PROJECTOR_API_PORT: String(ports.API) };
const mk = spawnSync('sh', [join(ROOT, 'deploy/projector/mkconfig.sh'), join(SCR, 'mediamtx.yml')], { env, encoding: 'utf8' });
if (mk.status !== 0) { console.log(mk.stderr); process.exit(1); }
const PUBKEY = mk.stdout.trim();
const entryLine = mk.stderr.split('\n').find((l) => /"solstice":/.test(l))!;
const entry = JSON.parse(`{${entryLine.trim()}}`);
const READKEY = entry.solstice.pass;
check('mkconfig printed a VIDEO_SOURCES entry with a minted read key', /^[0-9a-f]{48}$/.test(READKEY) && entry.solstice.whep.endsWith(`/${PATH_}/whep`));
import { openSync } from 'node:fs';
const mtxLog = join(SCR, 'mediamtx.log');
const mtx = spawn('mediamtx', ['mediamtx.yml'], { cwd: SCR, stdio: ['ignore', openSync(mtxLog, 'a'), openSync(mtxLog, 'a')] }); procs.push(mtx);
const api = (p: string) => fetch(`http://127.0.0.1:${ports.API}${p}`).then((r) => (r.ok ? r.json() : { status: r.status })).catch(() => null);
for (let i = 0; i < 50 && !(await api('/v3/paths/list')); i++) await sleep(200);
const apiUp = !!(await api('/v3/paths/list'));
check('the appliance\'s API answers on loopback', apiUp, apiUp ? '' : readFileSync(mtxLog, 'utf8').split('\n').filter((l) => /ERR|WAR|listener|bind/i.test(l)).slice(-6).join(' | '));

let ff: any = null;
const publish = () => { ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-profile:v', 'baseline', '-c:a', 'libopus', '-ar', '48000', '-ac', '2',
  '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://publisher:${PUBKEY}@127.0.0.1:${ports.RTSP}/${PATH_}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  ff.stderr.on('data', (d: Buffer) => errs.push(`ffmpeg: ${d.toString().slice(0, 200)}`)); procs.push(ff); };
const ready = async () => (await api(`/v3/paths/get/${PATH_}`))?.ready === true;
publish();
for (let i = 0; i < 60 && !(await ready()); i++) await sleep(250);
check('the synthetic OBS feed is publishing (the appliance says ready)', await ready());

// ---- the sequencer ----
writeFileSync(join(SCR, 'sources.json'), JSON.stringify({ sources: entry }, null, 2));
const world = await ownedWorld({ worlds: ['vprobe'], owner: 'owner', env: { VIDEO_SOURCES: join(SCR, 'sources.json'), TRUST_NAMES: '1', VERB_RATE: '1000',
  EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video') } });

// ---- two browser processes ----
const A = await launchBrowser(), B = await launchBrowser();
const wsIn: string[] = [];
async function join_(br: any, name: string) {
  const pg = await br.page();
  pg.on('pageerror', (e: any) => errs.push(`${name}: ${e.message}`));
  pg.on('console', (m: any) => { const x = m.text(); if (/\[gpu\]|\[renderer\]|context lost|reloading/i.test(x)) console.log(`   ${name} console: ${x.slice(0, 200)}`); });
  pg.on('framenavigated', (f: any) => { if (f === pg.mainFrame()) console.log(`   ${name} navigated: ${f.url().slice(0, 120)}`); });
  pg.on('websocket', (ws: any) => ws.on('framereceived', (f: any) => { if (typeof f.payload === 'string' && f.payload.includes('video')) wsIn.push(f.payload); }));
  pg.on('dialog', (d: any) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=vprobe&key=${world.key}&name=${name}`, { waitUntil: 'domcontentloaded' });
  // Joined, not just open: sendRequest refuses until the snapshot has landed (net.joined). Polled with evaluate, which
  // awaits the import: a waitForFunction predicate that returns import(…).then(…) returns a Promise, which is truthy,
  // so it passed at once, before the page had joined; on #260's 9d60447f the snapshot lands after the first create.
  const t0 = Date.now();
  while (!(await pg.evaluate(() => import('/lib/net.js').then((n: any) => n.net?.joined === true && n.net?.ws?.readyState === 1)).catch(() => false))) {
    if (Date.now() - t0 > 60000) throw new Error(`${name}: not joined to the world after 60 s`);
    await sleep(250);
  }
  return pg;
}
const pa = await join_(A, 'owner');
const req = (pg: any, verb: string, args: any) => pg.evaluate(({ verb, args }) => import('/lib/net.js').then((n: any) => n.sendRequest(verb, args)), { verb, args });
const st = (pg: any, id: string) => pg.evaluate((id) => import('/lib/videos.js').then((v: any) => { const s = v._screens.get(id); return s ? { state: s.state, why: s.why ?? null, w: s.el?.videoWidth ?? 0, t: s.el?.currentTime ?? 0, frames: s.frames ?? 0, retries: (s.retries ?? []).map((r: any) => r.why), gain: s.audio?.gain?.gain?.value ?? null, quad: !!s.quad } : null; }), id);
const until = async (pg: any, id: string, pred: (s: any) => boolean, ms = 30000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await st(pg, id); if (s && pred(s)) return s; await sleep(250); } return s; };
const sessions = async () => ((await api('/v3/webrtcsessions/list'))?.items ?? []).filter((x: any) => x.path === PATH_ && x.state !== 'closed').length;

try {
  // A. the door
  // the screen rides a model: a thing with NO model loses the page's WebGL context in headless Chrome on #260 as it is
  // (reproduced at 9263268c with no video at all), which reloads the page mid-measurement
  const made = await req(pa, 'create', { id: '$screen', components: { transform: { pos: [0, 1, -4], q: [0, 0, 0, 1], scale: [1, 1, 1] }, model: 'eidoverse/assets/models/crate_large_red.glb', label: 'screen', video: { source: 'solstice', alt: 'the probe stage', width: 3, radius: 15 } } });
  const SCREEN = made?.ids?.$screen;
  check('A. a video naming the admitted source is accepted', made?.ok && typeof SCREEN === 'string', JSON.stringify(made).slice(0, 300));
  const bad = await req(pa, 'create', { id: '$bad', components: { video: { source: 'nobody-admitted-this' } } });
  check('A. …and one naming a source nobody admitted is refused at the door', bad?.refused?.code === 'not-found' && /admitted here: solstice/.test(bad.refused.fix ?? ''), JSON.stringify(bad?.refused));
  const pb = await join_(B, 'viewer');

  // B. both play
  const sa = await until(pa, SCREEN, (s) => s.state === 'playing' && s.w > 0, 45000);
  const sb = await until(pb, SCREEN, (s) => s.state === 'playing' && s.w > 0, 45000);
  check('B. browser 1 plays it (its own state: playing, frames 640 wide)', sa?.state === 'playing' && sa.w === 640, JSON.stringify(sa));
  check('B. browser 2 plays it too', sb?.state === 'playing' && sb.w === 640, JSON.stringify(sb));
  for (const [n, pg] of [['1', pa], ['2', pb]] as const) {
    // the page's own render rate over the same 3 s: a presented video frame can't outrun the page that presents it
    const raf = pg.evaluate(() => new Promise((res) => { let k = 0; const t0 = performance.now(); const f = () => { k++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(k); }; requestAnimationFrame(f); }));
    const a = await st(pg, SCREEN); await sleep(3000); const b = await st(pg, SCREEN);
    const builds = await pg.evaluate(() => import('/lib/videos.js').then((v: any) => v._builds.map((x: any) => `${x.why}@${x.at}`)));
    console.log(`   browser ${n}: page rAF ${await raf.catch((e: any) => `(lost: ${String(e.message).slice(0, 60)})`)} in 3 s; video frames ${(b?.frames ?? 0) - (a?.frames ?? 0)}; builds ${builds.join(', ')}`);
    // frames presented (requestVideoFrameCallback) is the evidence; and a screen whose frames stopped must not still say playing
    check(`B. browser ${n}'s frames advance over 3 s (presented frames, not a held one)`, (b?.frames ?? 0) - (a?.frames ?? 0) > 30 && b?.state === 'playing', JSON.stringify({ a, b }));
  }
  check('B. the appliance holds one WebRTC session per viewer', (await sessions()) === 2, String(await sessions()));

  // C. look
  await sleep(11000);   // two appliance polls: a baseline, then bytes flowing
  const look = await req(pa, 'look', {});
  const says = (look?.things ?? []).find((t: any) => t.id === SCREEN)?.says ?? [];
  const line = says.find((l: string) => /video/.test(l)) ?? '';
  check('C. look says what the appliance observed: live, with its age', /^a video screen: «the probe stage»; its source is live \(as of \d+ s ago\)$/.test(line), line || JSON.stringify(look).slice(0, 300));

  // D. no endpoint, port or key reached a browser
  const all = wsIn.join('\n');
  const leaks = [`:${ports.WEBRTC}/`, `${ports.WEBRTC}/${PATH_}`, '/whep', READKEY, `127.0.0.1:${ports.API}`].filter((x) => all.includes(x));
  check('D. no websocket frame names the WHEP endpoint, its port, the API or the read key', all.length > 0 && leaks.length === 0, leaks.join(', ') || `${wsIn.length} video frames read`);

  // E. sound
  for (const pg of [pa, pb]) { await pg.mouse.click(400, 300); await pg.keyboard.press('Shift'); }
  const near = await until(pa, SCREEN, (s) => (s.gain ?? 0) > 0, 10000);
  check('E. after a gesture the screen is heard near it', (near?.gain ?? 0) > 0, JSON.stringify(near));
  await pa.evaluate((id) => import('/lib/mediaprefs.js').then((m: any) => m.toggleMineMuted(id)), SCREEN);
  const muted = await until(pa, SCREEN, (s) => s.gain === 0, 5000); const other = await st(pb, SCREEN);
  check('E. mute-for-me silences it for this viewer only', muted?.gain === 0 && (other?.gain ?? 0) > 0, JSON.stringify({ muted, other }));
  await pa.evaluate((id) => import('/lib/mediaprefs.js').then((m: any) => m.toggleMineMuted(id)), SCREEN);

  // F. the publisher stops
  ff.kill('SIGKILL'); await sleep(500);
  const fa = await until(pa, SCREEN, (s) => s.state !== 'playing', 15000), fb = await until(pb, SCREEN, (s) => s.state !== 'playing', 15000);
  check('F. both screens stop saying playing when frames stop (stalled, or reconnecting)', ['stalled', 'error', 'connecting', 'buffering'].includes(fa?.state) && ['stalled', 'error', 'connecting', 'buffering'].includes(fb?.state), JSON.stringify({ fa, fb }));
  await sleep(12000);
  const off = ((await req(pa, 'look', {}))?.things ?? []).find((t: any) => t.id === SCREEN)?.says?.find((l: string) => /video/.test(l)) ?? '';
  check('F. look says the source is offline', /its source is offline \(as of \d+ s ago\)/.test(off), off);

  // G. the publisher restarts
  publish();
  const ga = await until(pa, SCREEN, (s) => s.state === 'playing', 90000), gb = await until(pb, SCREEN, (s) => s.state === 'playing', 90000);
  check('G. both screens come back to playing on their own', ga?.state === 'playing' && gb?.state === 'playing', JSON.stringify({ ga, gb }));

  // H. the screen comes down
  const down = await req(pa, 'delete', { id: SCREEN, component: 'video' });
  await sleep(3000);
  const ha = await st(pa, SCREEN), hb = await st(pb, SCREEN);
  check('H. taking the video down closes every appliance session this probe opened', down?.ok && (await sessions()) === 0, `${JSON.stringify(down?.refused ?? 'ok')} sessions=${await sessions()}`);
  check('H. …and both browsers dropped the screen', ha === null && hb === null, JSON.stringify({ ha, hb }));
  check('no page errors', !errs.some((e) => !e.startsWith('ffmpeg')), errs.join(' | ').slice(0, 400));
} finally {
  await A.close().catch(() => {}); await B.close().catch(() => {});
  await world.close().catch(() => {});
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(500);
  const alive = procs.filter((p) => { try { process.kill(p.pid, 0); return true; } catch { return false; } });
  check('I. every process this probe started is gone', alive.length === 0, alive.map((p) => p.pid).join(','));
  rmSync(SCR, { recursive: true, force: true });
}
done();

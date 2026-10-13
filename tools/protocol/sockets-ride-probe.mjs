// tools/protocol/sockets-ride-probe.mjs — sockets as child entities (PLAN-sockets-entities, commits 7–9) in a real browser.
// usage (one Chrome, under the guard):  eido-probe.sh -C <worktree> -t 600 tools/protocol/sockets-ride-probe.mjs
//   COMMONS_LOG=<a COPY of a Commons world.jsonl>   (the commons stage is skipped, said so, without one)
// Two stages, each a line printed ok/FAIL:
//   commons  a copy of the Commons' log, lifted at its first load (one `lift-sockets` act per host, in a child process):
//            one lifted seat host, its socket children verbatim (ids, poses, bodies; the host's turn and scale), is carried
//            into the garden (on the probe's crate: the Commons' model lives in its own store). Ann sits on it with her own
//            /sit; her seat is the socket child's id, and her root stands on the socket's world point
//   swing    the probe's swing (probe-swing-glb: a named 'plank' node) whose plank swings on a part pendulum; its seat and
//            a shelf ride the plank (sockets with part: 'plank', written in the old spelling and lifted at the door). Ann
//            sits on the seat; a cup sits on the shelf. Sampled through more than a swing: the seat socket really moves
//            with the plank, Ann's root stays on it, and the cup stays on the shelf (it rides the part: the scene graph
//            carries it)
// The log copy is copied again into a scratch WORLDS_DIR (never a live world directory). Teardown in finally.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { launchBrowser, ownedWorld } from '../probe-harness.mjs';
import { foundWorld } from '../../server/worldlog.ts';
import { openLive } from '../../server/livehost.ts';
import { request, liftWorld, worldOf, posAt } from '../../shared/protocol/authority.js';
import { readLog, opsOf } from '../../shared/protocol/fold.js';
import { ENGINE_CATALOGUE, warm } from '../../server/modelcatalogue.ts';
import { directoryFor } from '../../server/directory.ts';
import { swingGlb } from './probe-swing-glb.mjs';
import { OPT_DIR } from '../../server/config.ts';

const KEY = 'socketsride';
const SWING = `eidoverse/assets/models/probe-swing-${process.pid}.glb`;
const SWING_FILE = join(OPT_DIR, SWING);
const CUP = 'eidoverse/assets/models/crate_large_red.glb';
const COMMONS = process.env.COMMONS_LOG ?? null;
// --lift <log>: the Commons stage's server half, alone in this process (printed as one JSON line): the copy opened in
// memory, as replay-check's RL does (a staging world is signed by the staging sequencer, whose key a probe server doesn't
// hold: custody would refuse to write it), lifted by the same call the server's world load makes (server/worldlog.ts),
// and one lifted seat — a plain host (no part) with its socket children, as the lift wrote them — handed back
if (process.argv[2] === '--lift') {
  const entries = readLog(readFileSync(process.argv[3])); const lines = [];
  const name = entries.find((e) => e?.kind === 'act' && e.verb === 'create-world')?.body?.name ?? 'commons';
  const T = (entries.findLast((e) => Number.isInteger(e?.ts))?.ts ?? 0) + 1000;
  const cw = worldOf({ name, entries: entries.map(posAt), getBlob: () => { throw new Error('no blob'); }, putBlob: () => '', writeLine: (l) => lines.push(l), now: () => T });
  const before = entries.filter((e) => e?.kind === 'act' && e.verb === 'lift-sockets').length;
  liftWorld(cw);
  const after = lines.map((l) => JSON.parse(l)).filter((e) => e?.kind === 'act' && e.verb === 'lift-sockets').length;
  const E = cw.state().entities;
  const isSock = (k) => E[k]?.c?.socket && typeof E[k].c.socket === 'object';
  const kidsOf = (h) => Object.keys(E).filter((k) => E[k].c.parent?.to === h);
  const seatHost = Object.keys(E).find((h) => !isSock(h) && typeof E[h].c.model === 'string' && kidsOf(h).some((k) => isSock(k) && E[k].c.socket.body && !E[k].c.socket.part)) ?? null;
  const chair = seatHost ? { host: E[seatHost].c, socks: kidsOf(seatHost).filter(isSock).map((k) => ({ id: k, c: E[k].c })) } : null;
  console.log(JSON.stringify({ name, before, after, seatHost, chair }));
  process.exit(0);
}
const worlds = mkdtempSync(join(tmpdir(), 'sockets-ride-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (n, v, d) => { if (!v) failed++; console.log(`${v ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? ` — ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 500)}` : ''}`); return v; };
let world = null, b = null, commonsName = null, seatHost = null;
try {
  // ---- the worlds: a Commons copy (lifted when the server first opens it), and a garden for the swing
  // the Commons copy is opened server-side (the whole world in a headless browser is more than this machine holds with a
  // second Chrome's worth of headroom): its first load lifts it, and its lifted seat — the host with its socket
  // children, as the lift wrote them — is carried into the garden, where Ann sits on it in the browser
  let chair = null;
  if (COMMONS) {
    // in a child process: the Commons fold is large, and this machine's memory floor wants it gone before Chrome starts
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--lift', COMMONS], { encoding: 'utf8', env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, maxBuffer: 1 << 24 });
    const got = (() => { try { return JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { return null; } })();
    commonsName = got?.name ?? null; seatHost = got?.seatHost ?? null; chair = got?.chair ?? null;
    check('commons: the copy is lifted at its first load (one lift-sockets act per host appended), and a seat host stands with its socket children', got && got.before === 0 && got.after > 0 && !!chair?.socks.length,
      got ? { before: got.before, after: got.after, seatHost, socks: chair?.socks.map((x) => [x.id, x.c.socket.name]) } : { stderr: r.stderr?.slice(-400) });
  }
  foundWorld(join(worlds, 'garden'), 'garden', 'Ann', 'a test garden');
  mkdirSync(join(SWING_FILE, '..'), { recursive: true }); writeFileSync(SWING_FILE, swingGlb());
  await warm([SWING, CUP]);
  { const w = openLive(join(worlds, 'garden'), 'garden', { catalogue: ENGINE_CATALOGUE });
    const ANN = directoryFor(worlds).idOfSub('local:ann');
    // the old spelling on purpose: the door lifts it into socket children (a seat and a shelf, both riding the plank)
    const r = request(w, ANN, 'create', { id: 'swing', model: SWING, components: { transform: { pos: [0, 0, 2.5] },
      'motion:plank': { type: 'pendulum', axis: [1, 0, 0], amp: 0.5, period: 3, damp: 0, pivot: [0, 1.5, 0] },
      sockets: { seat: { pos: [0, 0.55, 0], part: 'plank', body: {} }, shelf: { pos: [0.22, 0.55, 0], part: 'plank' } } } });
    if (!r.ok) throw new Error(`setup: ${JSON.stringify(r.refused)}`);
    const shelf = Object.entries(r.notes?.find((n) => n.legacy === 'sockets')?.wrote ?? {}).find(([k]) => k === 'shelf')?.[1];
    const c = request(w, ANN, 'create', { id: 'cup', model: CUP, components: { transform: { pos: [0, 0.1, 0], scale: [0.15, 0.15, 0.15] }, parent: { to: shelf ?? 'nope' } } });
    if (!c.ok) throw new Error(`setup cup: ${JSON.stringify([shelf, c.refused])}`);
    // the Commons chair, as the lift left it: the host (its model, its scale and turn) and its socket children, same ids
    if (chair) {
      const t = chair.host.transform ?? {};
      // its model stays in the Commons' own store (not in a probe's library): the probe's crate stands in for it; the seats,
      // their ids, poses and bodies, and the host's turn and scale are the Commons' own
      const h = request(w, ANN, 'create', { id: seatHost, model: CUP, components: { transform: { pos: [-2, 0, 0], q: t.q ?? [0, 0, 0, 1], scale: t.scale ?? [1, 1, 1] } } });
      const k = chair.socks.map((x) => request(w, ANN, 'create', { id: x.id, components: { transform: x.c.transform, parent: { to: seatHost }, socket: x.c.socket } }));
      if (!h.ok || k.some((r) => !r.ok)) throw new Error(`setup chair: ${JSON.stringify([h.refused, ...k.map((r) => r.refused)])}`);
    } }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  b = await launchBrowser();

  const visit = async (wname) => {
    const pg = await b.page();
    const logs = [], errors = [];
    pg.on('console', (m) => { logs.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.goto(`${world.origin}/?world=${wname}&name=Ann&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ev = (fn, arg) => Promise.race([pg.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error('evaluate stalled')), 20000))]);
    const t0 = Date.now();
    while (Date.now() - t0 < 150000 && !logs.some((l) => /^\[boot\] ready in/.test(l))) await sleep(500);
    const waitFor = async (fn, arg, ms = 30000) => { const t = Date.now(); let v = null; while (Date.now() - t < ms) { v = await ev(fn, arg).catch(() => null); if (v) return v; await sleep(250); } return v; };
    return { pg, ev, waitFor, logs, errors };
  };
  // where Ann sits, as {socket, host, name} — her seat is a socket child's id
  const mySeat = () => { const EW = globalThis.EW; const m = EW.avatarMounts.get(EW.net.myId) ?? EW.avatarMounts.get('Ann'); const s = m && EW.seatSocket(m.to); return s ? { socket: s.id, host: s.host, name: s.name } : null; };

  // one page for both stages (this machine's memory floor): the garden holds the Commons chair and the swing
  const v = await visit('garden');
  // ---- commons: the lifted Commons seat, sat on in the browser (in the garden: see above)
  if (!COMMONS) console.log('skip commons — no COMMONS_LOG (a copy of a Commons world.jsonl) given');
  else if (chair) {
    const sockets = await v.waitFor((h) => { const s = globalThis.EW.socketsOn(h); return s.length ? s.map((x) => ({ id: x.id, name: x.name, seat: !!x.sock.body })) : null; }, seatHost, 60000);
    await v.waitFor((h) => !!globalThis.EW.entities.get(h), seatHost, 60000);
    let seat = null;
    for (let i = 0; i < 40 && !seat; i++) { if (i % 10 === 0) await v.ev((h) => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: h }), seatHost); await sleep(500); seat = await v.ev(mySeat).catch(() => null); }
    await sleep(2500);   // past the ease onto the seat
    const at = await v.ev((sid) => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const so = EW.entities.get(sid);
      so.updateWorldMatrix(true, false); const sp = new T.Vector3().setFromMatrixPosition(so.matrixWorld);
      return { root: me.root.position.toArray(), socket: sp.toArray(), clip: EW.myState.clip, kind: so.userData.socket === true }; }, seat?.socket).catch((e) => String(e));
    const d = Array.isArray(at?.root) ? Math.hypot(...at.root.map((x, i) => x - at.socket[i])) : Infinity;
    check(`commons: Ann sits on the lifted seat of ${seatHost} with her own /sit (her seat is the socket child)`, !!seat && seat.host === seatHost && !!sockets?.some((x) => x.id === seat.socket), { seat, sockets });
    check('commons: …her root stands on the socket\'s world point (a root-anchored seat), the socket an Empty frame', d < 0.02 && at.kind, { d, at });
    // get up (X: the seat's getting off), so the swing below takes her
    for (let i = 0; i < 6 && await v.ev(mySeat).catch(() => null); i++) { await v.pg.keyboard.press('x'); await sleep(700); }
    check('commons: …and X gets her up off it', !(await v.ev(mySeat).catch(() => 'err')), await v.ev(mySeat).catch((e) => String(e)));
  }

  // ---- swing: the seat and the shelf ride the plank
  {
    await v.waitFor(() => { const EW = globalThis.EW; let p = null; EW.entities.get('swing')?.traverse((o) => { if (o.name === 'plank') p = o; }); return !!p && !!EW.entities.get('cup'); }, null, 60000);
    let seat = null;
    for (let i = 0; i < 40 && !seat; i++) { if (i % 10 === 0) await v.ev(() => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: 'swing' })); await sleep(500); seat = await v.ev(mySeat).catch(() => null); }
    await sleep(1500);
    const rows = [];
    for (let i = 0; i < 28; i++) {
      rows.push(await v.ev((sid) => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const wp = (o) => { o.updateWorldMatrix(true, false); return new T.Vector3().setFromMatrixPosition(o.matrixWorld); };
        const sock = EW.entities.get(sid), cup = EW.entities.get('cup'), shelf = EW.socketsOn('swing').find((x) => x.name === 'shelf');
        const sh = shelf && EW.entities.get(shelf.id);
        return { seat: wp(sock).toArray(), root: me.root.position.toArray(), cup: wp(cup).toArray(), shelf: sh ? wp(sh).toArray() : null,
          inPart: sock.parent?.name === 'plank', cupOn: cup.parent === sh }; }, seat?.socket).catch((e) => ({ err: String(e) })));
      await sleep(150);
    }
    const ok = rows.filter((r) => Array.isArray(r.seat));
    const span = (k) => Math.max(...ok.map((r) => r.seat[k])) - Math.min(...ok.map((r) => r.seat[k]));
    const dist = (a, b2) => Math.hypot(...a.map((x, i) => x - b2[i]));
    const onSeat = ok.map((r) => dist(r.root, r.seat));
    const cupGap = ok.map((r) => dist(r.cup, r.shelf));
    check('swing: Ann sits on the swing\'s seat (a socket child) with her own /sit', !!seat && seat.host === 'swing' && seat.name === 'seat', seat);
    check('swing: the seat socket hangs IN the plank (the part\'s node), so it really moves (> 15 cm over a swing)', ok.length > 20 && ok.every((r) => r.inPart) && Math.max(span(1), span(2)) > 0.15, { n: ok.length, dy: span(1), dz: span(2) });
    check('swing: …and Ann rides it: her root stays on the moving seat (every sample within 2 cm)', onSeat.length > 20 && Math.max(...onSeat) < 0.02, { max: Math.max(...onSeat) });
    check('swing: the cup on the shelf rides the plank too (a child of the shelf socket, a fixed offset from it)', ok.every((r) => r.cupOn) && Math.max(...cupGap) - Math.min(...cupGap) < 1e-3 && Math.max(...ok.map((r) => r.cup[2])) - Math.min(...ok.map((r) => r.cup[2])) > 0.1, { gap: [Math.min(...cupGap), Math.max(...cupGap)], first: ok[0], last: ok.at(-1) });
    check('swing: no page error', v.errors.filter((e) => !/destroyAttribute|favicon|WebGPU|Failed to load resource/.test(e)).length === 0, v.errors.slice(0, 4));
  }
} catch (e) { failed++; console.log(`FAIL probe — ${String(e?.stack ?? e).slice(0, 600)}`); }
finally {
  try { await b?.close(); } catch {}
  try { await world?.close(); } catch {}
  rmSync(worlds, { recursive: true, force: true });
  rmSync(SWING_FILE, { force: true });
}
console.log(failed ? `sockets-ride-probe: ${failed} failed` : 'sockets-ride-probe: all passed — a lifted Commons seat and a swing\'s part sockets, sat on and ridden');
process.exit(failed ? 1 : 0);

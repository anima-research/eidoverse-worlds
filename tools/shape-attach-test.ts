// shape-attach-test — the shape audit's wave 2, attach-interact family (notes/eidoverse/shape-audit/attach-interact.md;
// PLAN.md "Wave 2" + R's calls). Each row is a behaviour the audit changes, through the real door (a scratch world) or the
// pure reader that carries it. Written red first, against the tree before the change.
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/shape-attach-test.ts
// @ts-nocheck
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { scratchWorld } from './protocol/scratchworld.ts';
import { COMPONENTS, statusOf, pinOf, refsOf, mapRefs, materialize } from '../shared/protocol/componentspec.js';
import { legacyHosts, liftHostOps, socketId } from '../shared/protocol/authority/sockets.js';
import { evalLookAt } from '../shared/lookat.js';
import { toWorld, toLocal } from '../mcpl/places.ts';
import { translate } from './protocol/import-v1/translate-v1.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: any = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail !== '' ? `  — ${JSON.stringify(detail).slice(0, 300)}` : ''}`); };
const code = (r: any) => r?.refused?.code ?? (r?.ok ? 'ok' : 'error');
const near = (a: number[], b: number[], e = 1e-6) => Array.isArray(a) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);
const tryRow = (name: string, f: () => void) => { try { f(); } catch (e) { check(`${name} (threw)`, false, String(e?.stack ?? e).slice(0, 300)); } };

// ===================================================================== socket = attach point; station = the body there
tryRow('ST', () => {
  const W = scratchWorld('w2-station').seed({ bench: { model: 'crate', pos: [0, 0, 0] } });
  const C = (id: string) => W.state().entities[id]?.c;
  const mk = (id: string, socket: any, extra: any = {}) => W.call('create', { id, components: { parent: { to: 'bench' }, transform: { pos: [0, 0.5, 0] }, socket, ...extra } });

  check('ST1 the registry: socket is {name, part?, accepts?, radius?} (no body)', JSON.stringify(Object.keys(COMPONENTS.socket.fields)) === '["name","part","accepts","radius"]', COMPONENTS.socket.fields);
  check('ST1 …station is its own component, core {action, anim, anchor, exit, leaveBy, who, input} (R 10-17: anim was pose; input opened for the drive helm, step 3b)', JSON.stringify(Object.keys(COMPONENTS.station?.fields ?? {})) === '["action","anim","anchor","exit","leaveBy","who","input"]', COMPONENTS.station);
  check('ST1 …sockets (the old map) is reserved, lift-only', statusOf('sockets') === 'reserved' && !!COMPONENTS.sockets.lifted);

  let r = mk('lie1', { name: 'bunk' }, { station: { action: 'lie' } });
  check('ST2 a station is materialized on write: lie → anim lie, anchor root', r.ok && JSON.stringify(C('lie1')?.station) === '{"action":"lie","anchor":"root","anim":"lie"}', [r.refused, C('lie1')]);
  r = mk('sit1', { name: 'seat' }, { station: {} });
  check('ST2 …an empty station is a seat: sit, sitchair, root', r.ok && JSON.stringify(C('sit1')?.station) === '{"action":"sit","anchor":"root","anim":"sitchair"}', [r.refused, C('sit1')]);
  r = mk('odd1', { name: 'perch' }, { station: { action: 'hover' } });
  check('ST2 …an action the table doesn\'t know gets the seat pose, written down', r.ok && C('odd1')?.station?.anim === 'sitchair', [r.refused, C('odd1')]);
  const u = W.call('use', { id: 'bench', action: 'lie' });
  check('ST3 use {lie} attaches there in the stored pose', u.ok && u.attach?.to === 'lie1' && u.attach.pose === 'lie', u);

  r = mk('old1', { name: 'stool', body: { action: 'sit' } });
  check('ST4 a socket written with the old body block is lifted: socket without body + station', r.ok && C('old1')?.socket && !('body' in C('old1').socket) && C('old1')?.station?.action === 'sit' && C('old1')?.station?.anim === 'sitchair', [r.refused, C('old1')]);
  check('ST5 a station key the alpha holds back (reach) is refused as reserved', code(mk('rb1', { name: 'rb' }, { station: { reach: { leftHand: { at: [0, 1, 0] } } } })) === 'reserved');
  check('ST5 …so are poses, sync, approach, enter, leave, look, fromSeat', ['poses', 'sync', 'approach', 'enter', 'leave', 'look', 'fromSeat'].every((k, i) => code(mk(`rb${i + 2}`, { name: `rb${i + 2}` }, { station: { [k]: k === 'fromSeat' ? true : k === 'sync' || k === 'enter' || k === 'leave' ? 'x' : k === 'approach' ? [0, 0, 0, 0] : {} } })) === 'reserved'));
  { const r = mk('in1', { name: 'helm' }, { station: { action: 'drive', input: { move: 'drive' } } });
    check('ST5 …while input is a field now (step 3b, the drive helm): input {move: \'drive\'} is read, not reserved (here the helm rule answers: the host has no drive)', r.refused?.code === 'shape' && /helm/.test(r.refused.reason) && /drive/.test(r.refused.reason), [r.refused, C('in1')]); }
  check('ST5 …and the bone overrides (hold) are cut: an unknown key', code(mk('hb1', { name: 'hb' }, { station: { hold: { spine: [0, 0, 0, 1] } } })) === 'schema');
  W.call('create', { id: 'crate2', model: 'crate' });
  check('ST6 a station hangs only on a socket entity', code(W.call('set', { id: 'crate2', component: 'station', value: { action: 'sit' } })) !== 'ok');
  check('ST7 station.who names a role here', code(mk('wh1', { name: 'wh' }, { station: { who: 'wizard' } })) === 'shape' && mk('wh2', { name: 'wh2' }, { station: { who: 'builder' } }).ok);

  // the map lift: body → station
  W.call('create', { id: 'sofa', model: 'crate' });
  r = W.call('set', { id: 'sofa', component: 'sockets', value: { left: { pos: [-0.4, 0.5, 0], body: {} }, right: { pos: [0.4, 0.5, 0], body: { action: 'sit', pose: 'sit' } } } });
  const L = C(socketId('sofa', 'left')), R = C(socketId('sofa', 'right'));
  check('ST8 the old sockets map lifts each body to a station on its socket child', r.ok && L?.station?.anim === 'sitchair' && R?.station?.anim === 'sit' && !('body' in (L?.socket ?? {})), [r.refused, L, R]);

  // a stored socket.body (a log stored before station), lifted at load
  const st = { diagnostics: [], entities: { h: { c: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }, s: { c: { parent: { to: 'h' }, transform: { pos: [0, 1, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, socket: { name: 'seat', body: { action: 'lie' } } } } } };
  const hosts = legacyHosts(st);
  const ops = hosts.includes('h') ? liftHostOps(st, new Set(), 'h').ops : [];
  check('ST9 the load-time lift finds a stored socket.body and moves it to a station', hosts.includes('h') && ops.some((o: any) => o.id === 's' && o.comp === 'station' && o.value?.action === 'lie' && o.value?.anim === 'lie')
    && ops.some((o: any) => o.id === 's' && o.comp === 'socket' && !('body' in o.value)), [hosts, ops]);
});

// ===================================================================== one action namespace per thing
tryRow('AN', () => {
  const W = scratchWorld('w2-actions').seed({ chair: { model: 'crate', pos: [0, 0, 0] }, lamp: { model: 'crate', pos: [3, 0, 0] } });
  W.call('create', { id: 'seat-a', components: { parent: { to: 'chair' }, transform: { pos: [0, 0.5, 0] }, socket: { name: 'a' }, station: { action: 'sit' } } });
  check('AN1 two stations on one host may share an action (a sofa\'s seats all sit)', W.call('create', { id: 'seat-b', components: { parent: { to: 'chair' }, transform: { pos: [0.5, 0.5, 0] }, socket: { name: 'b' }, station: { action: 'sit' } } }).ok);
  check('AN2 a reaction named as one of its sockets\' station actions is refused', code(W.call('set', { id: 'chair', component: 'reactions', value: { sit: { kind: 'set', component: 'label', value: 'sat' } } })) === 'action-taken');
  W.call('set', { id: 'lamp', component: 'reactions', value: { ride: { kind: 'set', component: 'label', value: 'on' } } });
  check('AN3 …and a station whose action is one of its host\'s reaction keys', code(W.call('create', { id: 'seat-c', components: { parent: { to: 'lamp' }, transform: { pos: [0, 0.5, 0] }, socket: { name: 'c' }, station: { action: 'ride' } } })) === 'action-taken');
  check('AN4 grabbable.use naming one of its own station actions is refused (use fires a reaction)', code(W.call('set', { id: 'chair', component: 'grabbable', value: { use: 'sit' } })) === 'action-taken');
  check('AN5 a reaction with its own name is fine', W.call('set', { id: 'chair', component: 'reactions', value: { knock: { kind: 'set', component: 'label', value: 'knocked' } } }).ok);
});

// ===================================================================== home wins; grabbable registered
tryRow('HG', () => {
  const W = scratchWorld('w2-home').seed({ ball: { model: 'ball', pos: [1, 0, 1] }, key: { model: 'ball', pos: [2, 0, 2] } });
  const C = (id: string) => W.state().entities[id]?.c;
  check('HG1 grabbable.home is no field: refused (home is its own component)', code(W.call('set', { id: 'ball', component: 'grabbable', value: { home: { pos: [0, 0, 0] } } })) === 'schema');
  const r = W.call('set', { id: 'key', component: 'grabbable', value: { release: 'return' } });
  check('HG2 a returning grabbable gets its home stamped in the home component', r.ok && Array.isArray(C('key')?.home?.pos) && !('home' in (C('key')?.grabbable ?? {})), [r.refused, C('key')]);
  const s = W.call('set', { id: 'ball', component: 'home', value: { pos: [1, 0, 1], scale: 2 } });
  check('HG3 a number home.scale is stored as a vector', s.ok && JSON.stringify(C('ball')?.home?.scale) === '[2,2,2]', [s.refused, C('ball')?.home]);
  check('HG4 home.parent is {to} only (the socket spelling is gone)', JSON.stringify(COMPONENTS.home.fields) === '{"pos":"vec3","q":"array","scale":"vec3","parent":"object"}', COMPONENTS.home.fields);
  const G = COMPONENTS.grabbable;
  check('HG5 grabbable registers its fields (carries included; no home, no fx)', !!G.fields && 'carries' in G.fields && !('home' in G.fields) && !('fx' in G.fields) && 'grips' in G.fields && 'use' in G.fields, G.fields);
  check('HG5 …and its enums from grab.js', JSON.stringify(G.enums?.hold) === '["auto","press","toggle"]' && JSON.stringify(G.enums?.release) === '["drop","stay","return"]' && G.enums?.pose === undefined && G.fields?.anim === 'string', G.enums);   // anim is an open name (R 10-17), no enum
  check('HG6 grabbable.fx is reserved (refused)', code(W.call('set', { id: 'ball', component: 'grabbable', value: { fx: { particles: { effect: 'sparks' } } } })) === 'reserved');
  check('HG7 a grip\'s bone overrides (hold) are cut', code(W.call('set', { id: 'ball', component: 'grabbable', value: { grips: { a: { pos: [0, 0, 0], hold: { rightIndexProximal: [0, 0, 0, 1] } } } } })) === 'schema');
  check('HG8 carries is taken', W.call('set', { id: 'ball', component: 'grabbable', value: { carries: true } }).ok);
});

// ===================================================================== reactions: kinds frozen and pinned, impulse reserved, refs
tryRow('RX', () => {
  const W = scratchWorld('w2-rx').seed({ swing: { model: 'crate', pos: [0, 0, 0], motion: { type: 'pendulum' } }, b0: { model: 'ball', pos: [1, 0, 0] } });
  check('RX1 an impulse handler is refused as reserved (even on a pendulum)', code(W.call('set', { id: 'swing', component: 'reactions', value: { push: { kind: 'impulse', strength: 0.5 } } })) === 'reserved');
  const P = pinOf().reactions;
  check('RX2 the pin carries the handler kinds and each one\'s args', JSON.stringify(Object.keys(P.handlers ?? {})) === '["toggle","set","script","play","reset"]' && JSON.stringify(P.handlers?.reset) === '["targets"]', P);
  check('RX2 …and the reserved kind', JSON.stringify(P.reservedKinds) === '["impulse"]', P.reservedKinds);
  const v = { home: { kind: 'reset', targets: ['b0', 'b1'] }, flip: { kind: 'toggle' } };
  const refs = refsOf('reactions', v);
  check('RX3 reset.targets are references (a copy or fork remaps them)', JSON.stringify(refs) === '[{"path":"reactions.home.targets[0]","id":"b0"},{"path":"reactions.home.targets[1]","id":"b1"}]', refs);
  const m = mapRefs('reactions', v, (x: string) => (x === 'b1' ? null : `${x}-copy`));
  check('RX3 …mapRefs remaps them and drops a gone one', JSON.stringify(m.value.home.targets) === '["b0-copy"]' && m.dropped.length === 1, m);
  check('RX4 who is a role id (custom roles too): the common arg says so', /role/.test(COMPONENTS.reactions.common.who));
});

// ===================================================================== look-at: radians, vectors, no offset
tryRow('LA', () => {
  const W = scratchWorld('w2-lookat').seed({ head: { model: 'crate', pos: [0, 0, 0] } });
  const r = W.call('set', { id: 'head', component: 'look-at', value: { target: '@viewer', forward: 'x' } });
  const v = W.state().entities.head.c['look-at'];
  check('LA1 forward/up are stored as vectors (a letter is accepted and written as one)', r.ok && JSON.stringify(v?.forward) === '[1,0,0]' && JSON.stringify(v?.up) === '[0,1,0]', [r.refused, v]);
  check('LA2 speed is radians a second (240°/s)', r.ok && Math.abs(v?.speed - 240 * Math.PI / 180) < 1e-9 && COMPONENTS['look-at'].units.speed === 'rad/s', v);
  check('LA3 offset is gone', code(W.call('set', { id: 'head', component: 'look-at', value: { target: '@viewer', offset: [0, 1, 0] } })) === 'schema');
  check('LA4 yaw limits are radians: within ±π', code(W.call('set', { id: 'head', component: 'look-at', value: { target: '@viewer', yaw: [-90, 90] } })) === 'bounds' && W.call('set', { id: 'head', component: 'look-at', value: { target: '@viewer', yaw: [-1, 1] } }).ok);
  const e = evalLookAt({ at: [0, 0, 0], target: [10, 0, 0.001], la: { mode: 'yaw', forward: [0, 0, 1], up: [0, 1, 0], yaw: [-0.5, 0.5], speed: 0 } });
  check('LA5 the evaluator reads the limits as radians', Math.abs(e.yaw - 0.5) < 1e-9, e);
});

// ===================================================================== places: closed entries, no kind; full-transform frame
tryRow('PL', () => {
  const W = scratchWorld('w2-places').seed({ hut: { model: 'crate', pos: [0, 0, 0] } });
  check('PL1 a place entry is closed: kind is gone', code(W.call('set', { id: 'hut', component: 'places', value: { porch: { at: [0, 0, 1], kind: 'seat' } } })) === 'schema');
  check('PL2 …an entry is {at} or {min, max} (+label)', code(W.call('set', { id: 'hut', component: 'places', value: { porch: { at: [0, 1] } } })) === 'shape' && code(W.call('set', { id: 'hut', component: 'places', value: { porch: { min: [0, 0, 0] } } })) === 'shape');
  check('PL3 …a good one, and null, are taken', W.call('set', { id: 'hut', component: 'places', value: { porch: { at: [0, 0, 1], label: 'the porch' }, room: { min: [0, 0, 0], max: [2, 2, 2] }, door: null } }).ok);
  check('PL4 …a long label is refused', code(W.call('set', { id: 'hut', component: 'places', value: { p: { at: [0, 0, 0], label: 'x'.repeat(81) } } })) === 'bounds');
  const s = Math.SQRT1_2, h = { id: 't', pos: [1, 2, 3], q: [s, 0, 0, s], scale: [2, 1, 1] };   // turned 90° about x, scaled 2 along x
  const w = toWorld(h as any, [1, 1, 0]);
  check('PL5 toWorld uses the full transform (a pitched, non-uniformly scaled holder)', near(w, [3, 2, 4]), w);
  check('PL5 …and toLocal inverts it', near(toLocal(h as any, w), [1, 1, 0]), toLocal(h as any, w));
});

// ===================================================================== spawn, lock, false ≡ absent, reserved names
tryRow('MS', () => {
  const S = COMPONENTS.spawn;
  check('SP1 spawn has units, a radius range, and the absent radius pinned (2 m)', S.units?.pos === 'm' && S.units?.radius === 'm' && S.ranges?.radius?.max === 100 && /2 m/.test(S.absentMeans?.radius ?? '') && /2 m/.test(pinOf().spawn.absentMeans?.radius ?? ''), S);
  const W = scratchWorld('w2-misc').seed({ box: { model: 'crate', pos: [0, 0, 0] } });
  check('SP2 a spawn radius past 100 m is refused', code(W.call('set', { id: '@world', component: 'spawn', value: { pos: [0, 0, 0], radius: 500 } })) === 'bounds');
  const k = W.call('set', { id: 'box', component: 'lock', value: true });
  check('LK1 lock true is taken and stored as true (recut B2: its strength is its setter\'s rank, read at check time)', k.ok && W.state().entities.box.c.lock === true, [k.refused, W.state().entities.box.c.lock]);
  check('LK2 lock is on things only', COMPONENTS.lock.on === 'thing');
  check('FA1 hidden, disabled, clickthrough, openable say false reads as absent', ['hidden', 'disabled', 'clickthrough'].every((n) => /false reads (the same )?as absent/i.test(COMPONENTS[n].help)) && /false reads (the same )?as absent/i.test(COMPONENTS.openable.docs.open + COMPONENTS.openable.docs.locked));
  const RES = ['material', 'anim-clip', 'anim-states', 'camera', 'video', 'spring-joint', 'link', 'tags'];
  check('RN1 the held names are registered reserved', RES.every((n) => statusOf(n) === 'reserved'), RES.map((n) => [n, statusOf(n)]));
  check('RN2 …and a write of one is refused as reserved', RES.every((n) => code(W.call('set', { id: 'box', component: n, value: {} })) === 'reserved'));
});

// ===================================================================== the translator's repair rules (@12)
tryRow('TR', () => {
  const old = [{ seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 2, dialect: 'eidoverse-log', roles: { ann: { role: 'owner' } } } },
    { seq: 1, ts: 2, actor: 'ann', verb: 'spawn', args: { id: 'statue', lib: 'crate', pos: [1, 0, 1] } },
    { seq: 2, ts: 3, actor: 'ann', verb: 'comp', args: { id: 'statue', type: 'lock', data: true } },
    { seq: 3, ts: 4, actor: 'ann', verb: 'spawn', args: { id: 'sign', lib: 'crate', pos: [3, 0, 1] } },
    { seq: 4, ts: 5, actor: 'ann', verb: 'comp', args: { id: 'sign', type: 'guard', data: true } }];
  const r = translate(old); const f = r.final.translated;
  check('TR1 a v1 lock and a v1 guard translate to lock {rank: builder} (one spelling)', JSON.stringify(f.statue?.lock) === '{"rank":"builder"}' && JSON.stringify(f.sign?.lock) === '{"rank":"builder"}' && !r.stats.divergences, [f.statue?.lock, f.sign?.lock, r.stats.divergences]);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

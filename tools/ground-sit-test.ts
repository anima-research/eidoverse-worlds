// ground-sit-test.ts — /sit ground (or /sit here) sits where you stand, and never on a seat (PR #165).
//
// The defect: `/sit ground` went through thing resolution (handlers.js thingNamed, by id OR label) and then seat
// matching (localbody.js nearestSeat, an id prefix), so a seat labelled or named "ground…" took the words. Out of
// reach, the authority refused it, and you got a refusal instead of a ground sit. Already seated, the ground sit has to
// get you off first, and a seat that won't let you go (leaveBy 'script') keeps you, saying so, with nothing else done.
//
// Through the REAL /sit handler (commands/handlers.js, commands/registry.js) and the REAL localbody.js; every other
// client module they import is a no-op stub derived from their import lists, so the harness follows them as they change.
// shared/ and three are real.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/ground-sit-test.ts
// Mutation (must go red): drop the `ground|here` line from the /sit handler (G1, G2), or `&& !dismountMe('menu')` from
// sitOnGround (G4).
import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import * as THREE from '../client/node_modules/three/build/three.module.js';

const base = resolve(import.meta.dir, '../client/lib') + sep;
const requests: [string, any][] = [];        // what went to the authority
const postures: string[] = [];
const chat: string[] = [];
const hints: string[] = [];
const myState: any = { pos: new THREE.Vector3(), yaw: 0, seat: null, clip: 'idle' };
const avatarMounts = new Map<string, any>();
const entities = new Map<string, any>();
const bags = new Map<string, any>();           // id → bag: hosts and their socket children
const parents = new Map<string, string>();     // socket child → host
const where = new Map<string, number[]>();     // socket child → its world position
const seat = (host: string, label: string, at: number[], station: any = { action: 'sit' }) => {
  const sid = `${host}-seat`;
  entities.set(host, new THREE.Group());
  bags.set(host, { label });
  bags.set(sid, { socket: { name: 'seat' }, station });
  parents.set(sid, host); where.set(sid, at);
  return sid;
};

const REAL = new Set(['localbody.js', 'commands/handlers.js', 'commands/registry.js']);
const overrides: Record<string, Record<string, unknown>> = {
  'core.js': { THREE, camera: new THREE.PerspectiveCamera(60, 1, 0.05, 100) },
  'base.js': { CONFIG: { name: 'me' }, bus: { on() {}, emit() {} }, report() {} },
  'controller.js': {
    myState, keys: new Set(), xrIntent: {}, camYaw: 0, camPitch: 0,
    setPosture: (p: string) => { postures.push(p); },
  },
  'world.js': {
    avatarMounts, entities, bags: () => bags, bagOf: (id: string) => bags.get(id) ?? null,
    parentIdOf: (sid: string) => parents.get(sid) ?? null,
    socketWorldPos: (sid: string, v: any) => { const p = where.get(sid); return p ? v.set(p[0], p[1], p[2]) : null; },
    seatSocket: (sid: string) => ({ host: parents.get(sid), station: bags.get(sid)?.station }),
    socketsOn: () => [],
    setBodySeat: (name: string, to: any) => { if (to) avatarMounts.set(name, to); else avatarMounts.delete(name); },
    mountTransform: () => null,
    worldHasOwner: () => true,
  },
  'net.js': { sendRequest: async (verb: string, args: any) => { requests.push([verb, args]); return { ok: true }; }, identities: new Map() },
  'chat.js': { logChat: (_who: string, s: string) => { chat.push(String(s)); } },
  'ui.js': {
    flashHint: (s: unknown) => { hints.push(String(s)); },
    html: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v),
  },
  'plainwords.js': { plain: (w: string) => w, called: (id: string) => id, typeable: (w: string) => w },
  'myview.js': { outOfMyView: () => false },
  'mybody.js': { getMe: () => null },
  'thingphysics.js': { physicsApi: { mine: () => [] } },
};
const wanted = new Map<string, Set<string>>();
for (const file of REAL) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const src = readFileSync(base + file, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*'(\.\.?\/[\w./]+\.js)'/g)) {
    const abs = resolve(base, dir, m[4]);
    if (!abs.startsWith(resolve(base) + sep)) continue;   // shared/: real
    const target = relative(base, abs).split(sep).join('/');
    const names = wanted.get(target) ?? new Set<string>();
    for (const part of (m[2] ?? '').split(',')) { const n = part.trim().split(/\s+as\s+/)[0]; if (n) names.add(n); }
    if (m[1]) names.add('default');
    wanted.set(target, names);
  }
}
for (const [file, names] of wanted) {
  if (REAL.has(file)) continue;
  const exports: Record<string, unknown> = {};
  for (const n of names) exports[n] = () => undefined;
  Object.assign(exports, overrides[file] ?? {});
  mock.module(resolve(base, file), () => exports);
}

await import('../client/lib/commands/handlers.js');
const { dispatch, COMMANDS } = await import('../client/lib/commands/registry.js');
const settle = () => Promise.resolve().then(() => undefined);   // sendRequest's .then, one microtask hop
const reset = () => { requests.length = 0; postures.length = 0; chat.length = 0; hints.length = 0; myState.seat = null; avatarMounts.clear(); };

// Seats whose names would have taken the words: one in reach, labelled "ground", one far, its id starting "here".
seat('ground-bench', 'ground', [1, 0, 0]);
seat('here-chair', 'here chair', [20, 0, 0]);

// G1, G2: the words never reach a seat, in any case, with any spacing
for (const words of ['ground', 'here', ' GROUND ', 'Here']) {
  reset();
  dispatch('sit', words);
  await settle();
  assert.deepEqual(requests, [], `/sit ${words.trim()} asks the authority for no seat`);
  assert.deepEqual(postures, ['sit'], `/sit ${words.trim()} sits on the ground`);
  assert.deepEqual(chat, [], `/sit ${words.trim()} says nothing about a seat`);
}

// G3: on a ground-level geometry seat (myState.seat), the ground sit clears it
reset(); myState.seat = { id: 'stool', chair: true };
dispatch('sit', 'ground');
assert.equal(myState.seat, null, 'a geometry seat is cleared');
assert.deepEqual(postures, ['sit']);

// G4: mounted on a seat that lets you go: off first (dismountMe stands you), then sitting
reset(); avatarMounts.set('me', { to: 'ground-bench-seat' });
dispatch('sit', 'here');
await settle();
assert.equal(avatarMounts.has('me'), false, 'getting off the seat');
assert.deepEqual(postures, ['stand', 'sit'], 'stood up off the seat, then sat where you stand');
assert.deepEqual(requests, [], 'and no new seat asked for');

// G5: mounted on a seat that lets you go only when the world does: you stay, told how to leave, nothing else happens
reset(); seat('throne', 'throne', [0.5, 0, 0], { action: 'sit', leaveBy: 'script' });
avatarMounts.set('me', { to: 'throne-seat' });
dispatch('sit', 'ground');
await settle();
assert.equal(avatarMounts.get('me')?.to, 'throne-seat', 'a seat that won\'t let you go keeps you');
assert.deepEqual(postures, [], 'and no ground posture is struck while seated');
assert.equal(hints.length, 1, 'its hint says how to get up');
assert.equal(myState.seat, null);
bags.delete('throne-seat');

// Seat discovery is otherwise unchanged
reset();
dispatch('sit', '');
await settle();
assert.equal(requests[0]?.[0], 'use', 'plain /sit still takes the seat in reach');
assert.equal(requests[0]?.[1].id, 'ground-bench-seat');
reset();
dispatch('sit', 'here-chair');
await settle();
assert.equal(requests[0]?.[1].id, 'here-chair-seat', 'a seat named in full is still taken by name');

// The help line teaches it
assert.match(COMMANDS.find((c: any) => c.name === 'sit').help, /\/sit ground/);

console.log('ground-sit: explicit ground sit, seats it must not take, getting off first, a seat that keeps you, discovery and help passed');
process.exit(0);

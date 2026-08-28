// browserlab-seed — plant a comparable scene in a LOCAL scratch world, so a
// Firefox-vs-Chrome receipt has something to be about (#42).
//
// The harness measures whatever is in front of the camera; an empty dev world
// measures nothing. This puts a known, reproducible scene there: one grass
// field and a ring of library models, both from ordinary logged verbs, so the
// world another person seeds this way is the same world.
//
//   node tools/browserlab-seed.mjs                     # localhost:8949, world "labworld"
//   node tools/browserlab-seed.mjs --url=ws://127.0.0.1:8949/ws --world=labworld
//   node tools/browserlab-seed.mjs --density=1.4 --ring=24
//
// 🔴 LOCALHOST ONLY, ON PURPOSE. This writes verbs into a world log, and a
// world log is permanent history. It refuses any host that is not loopback —
// the measurement harness must never be one typo away from planting a meadow
// in the commons. (AGENTS.md: never develop against a port someone lives on.)

const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));

const URL_ = argv.url ?? 'ws://127.0.0.1:8949/ws';
// 🔴 NEVER DEFAULT TO A NAME SOMEONE MIGHT LIVE IN.
//
// This wrote grass and two dozen spawns into a world called `meadow` by
// default, on the reasoning that loopback is safe. Loopback is not proof
// nobody lives there — a local sequencer is exactly where someone's own world
// is, and world verbs are permanent history. The default is now a fresh name
// nobody can already be standing in, and naming a world explicitly still has
// to pass the empty-world check below.
const WORLD = argv.world ?? `browserlab-${Math.random().toString(36).slice(2, 10)}`;
const NAMED = !!argv.world;
const TOKEN = argv.token ?? process.env.JOIN_TOKEN ?? 'lab-door';
// The `grass` verb is owner-rank, and a world's owner is whoever FOUNDED it.
// Seeding under a second name gets the ring of models and a refusal for the
// meadow — which is the one thing the foliage arms are about. Default to the
// name the lab world is founded under; pass --name to match yours.
const NAME = argv.name ?? 'lab';
const DENSITY = Number(argv.density ?? 1.4);
const RING = Number(argv.ring ?? 24);

const host = new URL(URL_).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`refusing ${host}: browserlab-seed writes world verbs and only speaks to loopback.`);
  process.exit(1);
}

const LIBS = [
  'eidoverse/assets/models/palm_date_tree_tropical_deseert_oasis_plant.glb',
  'eidoverse/assets/models/stylized_yucca_joshua_tree_desert_cactus_plant.glb',
  'eidoverse/assets/models/streetlight_lamp_light_street_blade_runner_cyberpunk.glb',
];

const ws = new WebSocket(URL_);
const msgs = [];
ws.onmessage = (ev) => { try { msgs.push(JSON.parse(String(ev.data))); } catch { /* not ours */ } };
ws.onerror = (e) => { console.error('socket error', String(e)); process.exit(1); };

const waitFor = (pred, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const m = msgs.find(pred);
    if (m) { clearInterval(iv); res(m); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timed out after ${ms}ms`)); }
  }, 25);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verb = (v, args) => ws.send(JSON.stringify({ type: 'verb', verb: v, args }));

await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ type: 'join', token: TOKEN, name: NAME, world: WORLD }));
const snap = await waitFor((m) => m.type === 'snapshot');
console.log(`[seed] joined "${WORLD}" as ${NAME}`);

// The second half of the guard: a named world that already has anything in it
// is somebody's, and this seeder does not write into somebody's world. An
// explicitly empty one is fine, and --allow-existing is the deliberate override
// for re-seeding a scratch world you made yourself.
{
  const st = snap.state ?? snap.world ?? snap;
  const ents = Object.keys(st?.entities ?? {}).length;
  const seq = snap.seq ?? st?.seq ?? null;
  const inhabited = ents > 0 || (typeof seq === 'number' && seq > 1);
  if (NAMED && inhabited && argv['allow-existing'] !== 'true') {
    console.error(`refusing to seed "${WORLD}": it already holds ${ents} entities`
      + (seq != null ? ` at log seq ${seq}` : '') + '.');
    console.error("That is somebody's world, and grass/spawn verbs are permanent history.");
    console.error('Use a fresh --world, omit --world for a generated one, or pass --allow-existing if it is yours.');
    ws.close();
    process.exit(2);
  }
  if (inhabited) console.log(`[seed] note: re-seeding an existing world (${ents} entities) by request`);
}

// The sequencer rate-limits verbs per socket (server/config.ts MSG_RATE), and
// a burst of two dozen spawns loses most of them to "slow down" — the first
// run of this seeder planted 13 of 25 and reported a scene nobody could
// reproduce. Pace it, and re-running is harmless: spawn REPLACES by id.
const PACE_MS = Number(argv.pace ?? 400);

// one field: the thing the foliage arms actually toggle
verb('grass', { species: 'grass', width: 90, depth: 80, center: [0, 0], density: DENSITY, height: 0.42, wind: 1 });
await sleep(PACE_MS);

// a ring of models: draw calls and triangles that are NOT foliage, so "grass
// hidden" has a floor to recover to instead of an empty sky
for (let i = 0; i < RING; i++) {
  const a = (i / RING) * Math.PI * 2;
  const r = 6 + (i % 5) * 3.5;
  verb('spawn', { id: `lab${i}`, lib: LIBS[i % LIBS.length], pos: [Math.sin(a) * r, 0, Math.cos(a) * r], yaw: a, scale: 1 });
  await sleep(PACE_MS);
}

await sleep(1500);
const errors = msgs.filter((m) => m.type === 'error');
const logged = msgs.filter((m) => m.type === 'log').length;
console.log(`[seed] ${logged} entries echoed back, ${errors.length} refusals`);
for (const e of errors.slice(0, 8)) console.error('  refused:', JSON.stringify(e).slice(0, 200));
console.log(`[seed] world "${WORLD}" is ready. Measure it with:`);
console.log(`  node tools/browserlab-run.mjs --browser=chrome --label=chrome`);
console.log(`       --url="http://localhost:${new URL(URL_).port}/?name=viewer&world=${WORLD}&key=${TOKEN}"`);
ws.close();
process.exit(errors.length ? 1 : 0);

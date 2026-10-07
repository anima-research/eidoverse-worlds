// tools/v4/seat-ab-probe.mjs — where a sitter lands on a Commons seat, for an A/B across client versions.
// usage (one Chrome, under the guard):  perf-guard.sh -t 300 -- bun tools/v4/seat-ab-probe.mjs [shot.png]
// The seat is the Commons crate seat (commons-0927 snapshot, entity 0febbb4b: crate_large_red at scale 0.3997, socket
// {pos [0.343, 1.954, -0.375], yaw 2.09}), written the way the v1→v4 translator writes it ({pos, q, body: {}}), in a
// scratch v4 world. Ann sits with her own /sit; the probe prints one line, `AB {...}`: her root's world position and
// rotation, her hips joint, and the socket's world point. Run it at two commits and compare the lines: a change that
// leaves existing seats alone prints the same numbers. Self-contained on purpose (it runs unchanged at older commits).
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, ownedWorld } from '../probe-harness.mjs';
import { foundV4 } from '../../server/v4/worldlog.ts';
import { openLive } from '../../server/v4/livehost.ts';
import { request } from '../../shared/v4/authority.js';
import { ENGINE_CATALOGUE, warm } from '../../server/v4/modelcatalogue.ts';
import { directoryFor } from '../../server/v4/directory.ts';

const MODEL = 'eidoverse/assets/models/crate_large_red.glb';
const KEY = 'v4seatab';
const SHOT = process.argv[2] ?? null;
const qY = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const worlds = mkdtempSync(join(tmpdir(), 'v4-seatab-'));
let world = null, b = null, code = 1;
try {
  foundV4(join(worlds, 'garden'), 'garden', 'Ann', 'a v4 garden');
  await warm([MODEL]);
  { const w = openLive(join(worlds, 'garden'), 'garden', { catalogue: ENGINE_CATALOGUE });
    const ANN = directoryFor(worlds).idOfSub('local:ann');
    const r = request(w, ANN, 'create', { id: 'crate0feb', model: MODEL, components: { transform: { pos: [1.5, 0, 1.5], scale: [0.3997, 0.3997, 0.3997] },
      sockets: { seat: { pos: [0.343, 1.954, -0.375], q: qY(2.09), body: {} } } } });
    if (!r.ok) throw new Error(`setup: ${JSON.stringify(r.refused)}`); }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  b = await launchBrowser();
  const pg = await b.page();
  const logs = []; pg.on('console', (m) => logs.push(m.text()));
  await pg.goto(`${world.origin}/?world=garden&name=Ann&key=${KEY}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const ev = (fn, arg) => Promise.race([pg.evaluate(fn, arg), new Promise((_, j) => setTimeout(() => j(new Error('evaluate stalled')), 20000))]);
  const t0 = Date.now();
  while (Date.now() - t0 < 120000 && !(logs.some((l) => /^\[boot\] ready in/.test(l)) && await ev(() => !!globalThis.EW?.entities?.get('crate0feb')).catch(() => false))) await new Promise((r) => setTimeout(r, 500));
  let seated = null;
  for (let i = 0; i < 60 && !seated; i++) {
    if (i % 10 === 0) await ev(() => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: 'crate0feb' }));
    await new Promise((r) => setTimeout(r, 500));
    seated = await ev(() => (globalThis.EW.myState.clip === 'sitchair' ? true : null)).catch(() => null);
  }
  await new Promise((r) => setTimeout(r, 3000));   // past any ease onto the seat
  const out = await ev(() => { const EW = globalThis.EW, T = EW.THREE, me = EW.me(); const s = EW.entities.get('crate0feb'); s.updateWorldMatrix(true, false);
    const r3 = (v) => v.map((x) => +x.toFixed(4));
    return { seated: EW.myState.clip, root: r3(me.root.position.toArray()), q: r3(me.root.quaternion.toArray()),
      hips: r3(me.vrm.humanoid.getRawBoneNode('hips').getWorldPosition(new T.Vector3()).toArray()),
      socket: r3(new T.Vector3(0.343, 1.954, -0.375).applyMatrix4(s.matrixWorld).toArray()) }; });
  console.log(`AB ${JSON.stringify(out)}`);
  if (SHOT) await pg.screenshot({ path: SHOT });
  code = seated ? 0 : 1;
} catch (e) { console.log(`seat-ab-probe FAIL ${String(e?.stack ?? e).slice(0, 400)}`); }
finally {
  try { await b?.close(); } catch {}
  try { await world?.close(); } catch {}
  rmSync(worlds, { recursive: true, force: true });
}
process.exit(code);

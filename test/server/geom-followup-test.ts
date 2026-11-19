// bun test/server/geom-followup-test.ts — the join's `geom` follow-up (server/server.ts sendGeomFollowup) comes to
// every join, even empty: it tells the client every size this join will get has come, and the arrival hold
// (client/lib/realize/models.js geomLanded) stops waiting on unsized models then. Against a real scratch sequencer.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scratchSequencer } from '../harness/harness.ts';
import { until } from '../gate/wait.ts';
import { helloOf } from '../../shared/protocol/hello.js';
import { suite } from '../gate/suite.ts';
const { ok, done } = suite('geom-followup');
const data = mkdtempSync(join(tmpdir(), 'geom-followup-data-'));
const h = await scratchSequencer('geomfollow', { worlds: ['geomfollow'], serverEnv: {
  SKIP_OPT_SWEEP: '1', JOIN_TOKEN: 'test-door',
  OPT_DIR: join(data, 'opt'), STORE_DIR: join(data, 'store'), EIDOVERSE_DIR: join(data, 'library'),
} });
let completed = false;
const ws = new WebSocket(h.BASE.replace('http', 'ws') + '/ws');
try {
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await until('the socket opens', () => ws.readyState === 1, { ms: 8000, step: 25 });
  ws.send(JSON.stringify({ type: 'join', hello: helloOf(), token: 'test-door', world: 'geomfollow', id: 'joiner', replica: true }));
  const snap = await until('the snapshot', () => got.find((m) => m.type === 'snapshot'), { ms: 8000, step: 25 });
  // the fold rides the snapshot as `state`; a placed model is a record with a `model`
  ok(!!snap.state && typeof snap.state === 'object' && !JSON.stringify(snap.state).includes('"model"'),
    'G1 setup: the snapshot carries the fold, and no placed model is in it', JSON.stringify(snap.state)?.slice(0, 200));
  // the follow-up of a world without models needs no summary: it comes at once, so a few seconds is generous
  const geom = await until('the geom follow-up', () => got.find((m) => m.type === 'geom'), { ms: 5000, step: 25 }).catch(() => null);
  ok(geom && geom.geom && typeof geom.geom === 'object' && Object.keys(geom.geom).length === 0,
    'G1 a join to a world without models still gets its geom follow-up, empty', JSON.stringify(geom ?? got.map((m) => m.type)));
  ok(got.findIndex((m) => m.type === 'geom') > got.findIndex((m) => m.type === 'snapshot'), 'G2 it comes after the snapshot', got.map((m) => m.type));
  completed = true;
} finally {
  try { ws.close(); } catch { /* closed */ }
  await h.cleanup(completed ? 0 : 1);
  rmSync(data, { recursive: true, force: true });
}
done();

// Real-browser ground presentation with fixed 60Hz sampling of the actual
// applier. Asset identity is the response the browser consumed, including
// overlay/texture negotiation. bun tools/sim-ground-smoke.ts [--slow-frames]
import { createHash } from 'node:crypto';
import { SIM_ID } from '../shared/sim.js';
import assetFixture from '../spec/fixtures/sim-ground-assets.json';
import { terrainParams, makeHeightField } from '../shared/terrainmath.js';
import { scratchBench, mkCheck, sleep } from './harness.ts';
const TERRAIN = { seed: 7, size: 160, segments: 200, amplitude: 6, flatRadius: 16, layers: [{ color: '#4a5d33', repeat: 16 }] };
const hf = makeHeightField(terrainParams(TERRAIN));
const MODEL = assetFixture.model;
const OFF = assetFixture.offsetXZ;
const SPAWN = [-10.4749, -0.5047, 30.7654];
const DIR = [-0.5934150204746177, 0.9, -0.8048966476977706];
const { PORT, BASE, cws, cdp, evalJson, cleanup, die, record } = await scratchBench('simground', {
  headed: process.argv.includes('--headed'), portFrom: 8970,
});
const { check, tally } = mkCheck();
if (process.argv.includes('--slow-frames')) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => setTimeout(() => raf(cb), 300);' });
  console.log('Browser animation callbacks limited to about 3 fps; measurement remains fixed at 60Hz.');
}
const WORLD = `simground-${crypto.randomUUID().slice(0, 8)}`;
const msgs: any[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = ev => { const m = JSON.parse(String(ev.data)); msgs.push(m); record('wire.jsonl', m); };
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
async function until(f: () => any, label: string, timeout = 60_000) {
  const start = Date.now();
  while (!await f()) { if (Date.now() - start > timeout) await die(1, `timed out: ${label}`); await sleep(100); }
}
dws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'grounddriver', token: '' }));
await until(() => msgs.some(m => m.type === 'snapshot'), 'driver join');
const pose = (p: number[]) => dws.send(JSON.stringify({ type: 'pose', pose: { p } }));
async function verb(v: string, args: unknown) {
  const start = msgs.length;
  dws.send(JSON.stringify({ type: 'verb', verb: v, args }));
  await until(() => msgs.slice(start).some(m => (m.entry ?? m).verb === v || m.type === 'error'), `${v} echo`, 10_000);
  const error = msgs.slice(start).find(m => m.type === 'error');
  if (error) await die(1, `${v} refused: ${error.error}`);
  return msgs.slice(start).map(m => m.entry ?? m).find(m => m.verb === v);
}
await verb('terrain', TERRAIN);
await verb('epoch', { sim: SIM_ID, tickMs: 66 });
await verb('spawn', { id: 'bar', lib: MODEL, pos: SPAWN, yaw: 0 });

let bootReady = false;
const assets = new Map<string, string>(), finished = new Set<string>();
cws.addEventListener('message', ev => {
  const m = JSON.parse(String(ev.data));
  if (m.method === 'Runtime.consoleAPICalled') {
    if ((m.params.args ?? []).some((a: any) => String(a.value ?? '').startsWith('[boot] ready'))) bootReady = true;
  }
  if (m.method === 'Network.responseReceived') {
    const url = m.params.response.url;
    if (new URL(url).pathname === `/library/${MODEL}`) assets.set(m.params.requestId, url);
  }
  if (m.method === 'Network.loadingFinished') finished.add(m.params.requestId);
});
async function navigate(name: string) {
  bootReady = false; assets.clear(); finished.clear();
  await cdp.send('Page.navigate', { url: `${BASE}/?name=${name}&world=${WORLD}` });
  await until(() => bootReady, 'client boot');
  await until(() => evalJson(`(async () => {
    const {colliders} = await import('/lib/colliders.js');
    return !!globalThis.EW?.entities.get('bar') && !!colliders.get('bar')?.box;
  })()`), 'model and collider');
  await until(() => assets.size && [...assets.keys()].every(id => finished.has(id)), 'effective model response');
  for (const [requestId, url] of assets) {
    const body = await cdp.send<any>('Network.getResponseBody', { requestId });
    const bytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    record('asset-hashes.jsonl', { url, sha256, bytes: bytes.length });
    if (!Object.hasOwn(assetFixture.responses, sha256)) await die(2, `effective model ${url} is sha256 ${sha256}; response is absent from sim-ground-assets.json. Run ground-asset-check.ts and re-measure offsets before adding the hash.`);
    console.log(`effective asset sha256 ${sha256}`);
  }
  // The native frame loop has exercised hydration/model arrival. Measurement
  // now owns just this hook; other world/render hooks continue normally.
  await evalJson(`(async () => {
    const {releaseHook} = await import('/lib/autohooks.js');
    const {simWorldFrame} = await import('/lib/simworld.js');
    releaseHook(simWorldFrame);
    globalThis.simGroundFrameTime = performance.now();
  })()`);
}
await navigate('groundbot');

function rot(q: number[], v: number[]) {
  const [x,y,z,w] = q, [vx,vy,vz] = v;
  const cx=y*vz-z*vy, cy=z*vx-x*vz, cz=x*vy-y*vx;
  return [vx+2*w*cx+2*(y*cz-z*cy), vy+2*w*cy+2*(z*cx-x*cz), vz+2*w*cz+2*(x*cy-y*cx)];
}
const clusterOf = (r: any) => { const v=rot(r[4], [OFF[0],0,OFF[1]]); return [r[0]+v[0],r[1]+v[1],r[2]+v[2]]; };
async function flight(from: number[]) {
  pose([from[0]+1, 0, from[2]+1]);
  const entry = await verb('punt', { id: 'bar', power: 4, dir: DIR });
  await until(() => evalJson(`globalThis.EW?.simFold().bodies.bar?.seq === ${entry.seq}`), 'client punt fold');
  return evalJson(`(async () => {
    const {state} = await import('/lib/state.js');
    const {updateSimWorld} = await import('/lib/simworld.js');
    const source = state.sim; state.sim = structuredClone(source);
    const sim = state.sim, o = EW.entities.get('bar'), T = EW.THREE;
    const wall = sim.epoch.ts + sim.tick * sim.epoch.tickMs;
    const rows = [], v = new T.Vector3(); let restAt = -1;
    try {
      for (let frame = 1; frame <= 1200; frame++) {
        globalThis.simGroundFrameTime += 1000 / 60;
        updateSimWorld(wall + frame * 1000 / 60, globalThis.simGroundFrameTime);
        o.updateWorldMatrix(true, true);
        const b = sim.bodies.bar; let meshMin = Infinity;
        o.traverse(nd => {
          if (!nd.isMesh || !nd.geometry) return;
          if (!nd.geometry.boundingBox) nd.geometry.computeBoundingBox();
          const bb = nd.geometry.boundingBox;
          for(let i=0;i<8;i++) {
            v.set(i&1?bb.max.x:bb.min.x,i&2?bb.max.y:bb.min.y,i&4?bb.max.z:bb.min.z).applyMatrix4(nd.matrixWorld);
            meshMin = Math.min(meshMin,v.y);
          }
        });
        rows.push([o.position.x,o.position.y,o.position.z,b.resting?1:0,o.quaternion.toArray(),meshMin,b.v[1]]);
        if(b.resting && restAt<0) restAt=frame;
        // Three simulated seconds for the presentation's slope slerp, with
        // every actual applier step executed; no wall-time convergence guess.
        if(restAt>=0 && frame-restAt>=180) return {rows, rest:structuredClone(b), restFrame:restAt};
      }
      throw Error('fixed-step flight did not settle within 20 simulated seconds');
    } finally { state.sim=source; }
  })()`);
}
let req = 0;
async function serverRest() {
  let body: any;
  await until(async () => {
    const reqId = `rest${++req}`;
    dws.send(JSON.stringify({ type: 'debug', sim: true, reqId }));
    await until(() => msgs.some(m => m.reqId === reqId), 'server sim reply', 5000);
    body = msgs.find(m => m.reqId === reqId)?.sim?.bodies?.bar;
    return body?.resting;
  }, 'sequencer rest', 15000);
  return body;
}
function judge(label: string, result: any, reload = false) {
  const rows = result.rows, moving = rows.filter((r: any) => r[3] === 0);
  const airborne = moving.filter((r: any) => r[6] !== 0);
  check(`${label}: fixed 60Hz samples cover flight through settled presentation`, moving.length > 0 && airborne.length > 0 && rows.at(-1)?.[3] === 1 && rows.length-result.restFrame === 180);
  let worstOrigin=0, worstCluster=0, worstMesh=0, maxTilt=0;
  for(const r of moving) {
    const c=clusterOf(r), q=r[4];
    worstOrigin=Math.min(worstOrigin,r[1]-hf(r[0],r[2]));
    worstCluster=Math.min(worstCluster,c[1]-hf(c[0],c[2]));
    worstMesh=Math.min(worstMesh,r[5]-hf(c[0],c[2]));
    if(r[6]!==0) maxTilt=Math.max(maxTilt,Math.acos(Math.max(-1,Math.min(1,1-2*(q[0]*q[0]+q[2]*q[2]))))*180/Math.PI);
  }
  check(`${label}: origin and visible cluster stay above ground`, worstOrigin>=-0.005 && worstCluster>=-0.01, `${moving.length} fixed samples, worst origin ${worstOrigin.toFixed(4)}m, cluster ${worstCluster.toFixed(4)}m`);
  const last=rows.at(-1), c=clusterOf(last), clearance=c[1]-hf(c[0],c[2]);
  check(`${label}: settled cluster stands on ground`, Math.abs(clearance)<0.005, `${clearance.toFixed(4)}m`);
  if(reload) {
    check('reload: airborne model does not tumble and mesh clears the slope', maxTilt<20 && worstMesh>-0.15, `${airborne.length} fixed airborne samples, tilt ${maxTilt.toFixed(1)}°, mesh ${worstMesh.toFixed(3)}m`);
    const e=0.5, n=[-(hf(c[0]+e,c[2])-hf(c[0]-e,c[2]))/(2*e),1,-(hf(c[0],c[2]+e)-hf(c[0],c[2]-e))/(2*e)];
    const len=Math.hypot(...n), up=rot(last[4],[0,1,0]);
    const ang=Math.acos(Math.min(1,Math.max(-1,up.reduce((s,v,i)=>s+v*n[i]/len,0))))*180/Math.PI;
    check('reload: settled up vector follows the terrain normal', last[3]===1 && ang<=3, `${ang.toFixed(2)}°`);
  }
  record('samples.jsonl', { label, ...result });
}
judge('authored launch', await flight(SPAWN));
let rest = await serverRest();
judge('launch from rest', await flight(rest.p));
rest = await serverRest();
await navigate('groundbot2');
judge('launch after reload', await flight(rest.p), true);
dws.close();
console.log(`${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);

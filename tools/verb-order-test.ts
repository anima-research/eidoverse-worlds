// Product-door ordering with observed, explicitly held cold asset reads.
// bun tools/verb-order-test.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scratchSequencer, sleep, mkCheck, ROOT } from './harness.ts';
import { emptyState, foldEntry } from '../shared/fold.js';
import { SIM_ID } from '../shared/sim.js';

const LIB1 = 'eidoverse/assets/models/order-red.glb';
const LIB2 = 'eidoverse/assets/models/order-green.glb';
const serverEnv = { JOIN_TOKEN: 'test-door', VERB_RATE: '100', EIDOVERSE_DIR: '' };
// A real, tiny GLB through the normal parser; this door test needs no private
// asset closure. Its non-flat bounding box covers all three axes.
function modelBytes() {
  const positions = new Float32Array([-0.5,0,-0.5, 0.5,0,-0.5, 0,1,0.5]);
  const json = JSON.stringify({ asset:{version:'2.0'}, scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0}}]}], buffers:[{byteLength:positions.byteLength}],
    bufferViews:[{buffer:0,byteLength:positions.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-0.5,0,-0.5],max:[0.5,1,0.5]}] });
  const chunk = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const out = Buffer.alloc(28 + chunk.length + positions.byteLength);
  out.writeUInt32LE(0x46546c67,0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(chunk.length,12); out.writeUInt32LE(0x4e4f534a,16); chunk.copy(out,20);
  out.writeUInt32LE(positions.byteLength,20+chunk.length); out.writeUInt32LE(0x004e4942,24+chunk.length);
  Buffer.from(positions.buffer).copy(out,28+chunk.length);
  return out;
}
const { check, tally } = mkCheck();
const { PORT, SCRATCH, seq, cleanup, die, record } = await scratchSequencer('verborder', {
  portFrom: 8980, preload: join(ROOT, 'tools', 'box-read-gate.ts'),
  serverEnv,
  prepare(scratch) {
    serverEnv.EIDOVERSE_DIR = join(scratch, 'library');
    mkdirSync(join(serverEnv.EIDOVERSE_DIR, 'eidoverse/assets/models'), { recursive: true });
    for (const lib of [LIB1, LIB2]) writeFileSync(join(serverEnv.EIDOVERSE_DIR, lib), modelBytes());
    mkdirSync(join(scratch, 'box-gate'));
    const dir = join(scratch, 'worlds', 'order'); mkdirSync(dir, { recursive: true });
    const entries = [
      { seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 3, dialect: 'eidoverse-log' } },
      { seq: 1, ts: 2, actor: 'fixture', verb: 'grant', args: { id: 'author', role: 'owner', gen: true } },
      { seq: 2, ts: 3, actor: 'fixture', verb: 'spawn', args: { id: 'target', lib: LIB2, pos: [2, 0, 2] } },
    ];
    writeFileSync(join(dir, 'log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  },
});
const gate = (lib: string, action: string) => join(SCRATCH, 'box-gate', `${basename(lib)}.${action}`);
const until = async (f: () => any, label: string) => {
  const start = Date.now();
  while (!f()) {
    if (seq.exitCode !== null || Date.now() - start > 8000) await die(1, `timed out: ${label}; sequencer exit ${seq.exitCode}`);
    await sleep(10);
  }
};
async function connection() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs: any[] = [];
  ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); msgs.push(m); record('wire.jsonl', m); };
  await new Promise((r, j) => { ws.onopen = r as any; ws.onerror = j as any; });
  return { ws, msgs };
}
const rejected = await connection();
rejected.ws.send(JSON.stringify({ type: 'join', world: 'order', id: 'invalid', token: 'wrong' }));
await until(() => rejected.msgs.some(m => m.type === 'error') || rejected.ws.readyState === WebSocket.CLOSED, 'rejected admission');
check('a rejected join starts no world GLB read', !existsSync(gate(LIB2, 'started')));
rejected.ws.close();
const { ws, msgs } = await connection();
ws.send(JSON.stringify({ type: 'join', world: 'order', id: 'author', token: 'test-door' }));
await until(() => msgs.some(m => m.type === 'snapshot'), 'admitted snapshot');
ws.send(JSON.stringify({ type: 'pose', pose: { p: [0, 0, 0] } }));
const send = (verb: string, args: unknown) => ws.send(JSON.stringify({ type: 'verb', verb, args }));
let req = 0;
async function request(type: string, args: object = {}) {
  const reqId = `q${++req}`;
  ws.send(JSON.stringify({ type, reqId, ...args }));
  await until(() => msgs.some(m => m.type === type && m.reqId === reqId), type);
  return msgs.find(m => m.type === type && m.reqId === reqId);
}
const history = async () => (await request('history', { limit: 100 })).entries as any[];
const folded = (es: any[]) => { const st = emptyState(); for (const e of [...es].sort((a,b) => a.seq-b.seq)) foldEntry(st, e); return st; };
const seenVerb = (verb: string) => msgs.some(m => (m.entry ?? m).verb === verb);

// The log was populated BEFORE process startup. Admission's read is still
// held, so the following epoch really must wait on a cold standing library.
await until(() => existsSync(gate(LIB2, 'started')), 'cold epoch read');
send('epoch', { sim: SIM_ID, tickMs: 66 });
send('punt', { id: 'target', dir: [1, 0.5, 0], power: 4 });
let es = await history();
check('cold epoch and following punt both wait for the asset read', !es.some(e => e.verb === 'epoch' || e.verb === 'punt'));
writeFileSync(gate(LIB2, 'release'), 'go');
await until(() => seenVerb('punt'), 'punt after epoch');
es = await history();
const epoch = es.find(e => e.verb === 'epoch'), punt = es.find(e => e.verb === 'punt');
check('cold epoch → punt land in authored order', !!epoch && punt?.seq > epoch.seq);
check('the epoch stamps the previously cold library', Array.isArray(epoch?.args?.boxes?.[LIB2]));
check('the punt folded under the epoch', !!(await request('debug', { sim: true })).sim?.bodies?.target);

const malformed = { id: { toString: null }, type: 'label', data: 'probe' };
const errorCount = () => msgs.filter(m => m.type === 'error' && /failed server-side/.test(m.error)).length;
send('comp', malformed);
await until(() => errorCount() === 1, 'synchronous malformed request refused');
check('synchronous request failure is contained', seq.exitCode === null);

send('spawn', { id: 'thing', lib: LIB1, pos: [0, 0, 0] });
send('place', { id: 'thing', pos: [9, 0, 9] });
send('comp', { id: 'thing', type: 'label', data: { text: 'x' } });
send('comp', malformed);
send('say', { text: 'queue recovered' });
await until(() => existsSync(gate(LIB1, 'started')), 'cold spawn read');
es = await history();
check('cold spawn and later edits wait together', !es.some(e => e.args?.id === 'thing'));
writeFileSync(gate(LIB1, 'release'), 'go');
await until(() => seenVerb('say'), 'valid request after queued failure');
es = await history();
const authored = es.filter(e => e.args?.id === 'thing').sort((a,b) => a.seq-b.seq);
check('cold spawn → place → comp land in authored order', authored.map(e => e.verb).join(',') === 'spawn,place,comp');
let st = folded(es);
check('cold final authored position and component are preserved', JSON.stringify(st.entities.thing?.pos) === '[9,0,9]' && st.entities.thing?.comp?.label?.text === 'x');
check('queued request failure is reported and following requests survive', errorCount() === 2 && seq.exitCode === null && es.some(e => e.verb === 'say' && e.args.text === 'queue recovered'));

send('spawn', { id: 'thing2', lib: LIB1, pos: [1, 0, 1] });
send('place', { id: 'thing2', pos: [8, 0, 8] });
send('comp', { id: 'thing2', type: 'label', data: { text: 'y' } });
es = await history(); st = folded(es);
check('warm control preserves folded position and component', JSON.stringify(st.entities.thing2?.pos) === '[8,0,8]' && st.entities.thing2?.comp?.label?.text === 'y');
const before = errorCount();
for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) ws.send(JSON.stringify({ type }));
await history();
check('inherited message names are silently ignored', errorCount() === before && seq.exitCode === null);
ws.close();
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);

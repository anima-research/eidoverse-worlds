// A retired transport's pending intents must never become durable history.
// bun tools/verb-generation-test.ts — owned server, real WS, held GLB reads.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { scratchSequencer, sleep, mkCheck, ROOT } from './harness.ts';
import { modelBytes } from './box-fixture.ts';
import { emptyState, foldEntry } from '../shared/fold.js';

const scenarios = ['takeover', 'disconnect', 'expel', 'rejoin'] as const;
const lib = (scenario: string) => `eidoverse/assets/models/generation-${scenario}.glb`;
const serverEnv = { JOIN_TOKEN: 'test-door', VERB_RATE: '100', EIDOVERSE_DIR: '' };
const { check, tally } = mkCheck();
const { PORT, SCRATCH, seq, cleanup, die, record } = await scratchSequencer('verb-generation', {
  portFrom: 9040, preload: join(ROOT, 'tools/box-read-gate.ts'), serverEnv,
  prepare(scratch) {
    serverEnv.EIDOVERSE_DIR = join(scratch, 'library');
    mkdirSync(join(serverEnv.EIDOVERSE_DIR, 'eidoverse/assets/models'), { recursive: true });
    mkdirSync(join(scratch, 'box-gate'));
    for (const scenario of scenarios) {
      writeFileSync(join(serverEnv.EIDOVERSE_DIR, lib(scenario)), modelBytes());
      const dir = join(scratch, 'worlds', scenario); mkdirSync(dir, { recursive: true });
      const entries = [
        { seq: 0, ts: 1, actor: 'world', verb: 'genesis', args: { v: 3, dialect: 'eidoverse-log' } },
        { seq: 1, ts: 2, actor: 'fixture', verb: 'grant', args: { id: 'moderator', role: 'owner' } },
        { seq: 2, ts: 3, actor: 'fixture', verb: 'grant', args: { id: 'same', role: 'builder' } },
      ];
      writeFileSync(join(dir, 'log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    }
  },
});
const gate = (scenario: string, action: string) => join(SCRATCH, 'box-gate', `${basename(lib(scenario))}.${action}`);
const until = async (f: () => unknown, label: string) => {
  const start = Date.now();
  while (!f()) {
    if (seq.exitCode !== null || Date.now() - start > 8000) await die(1, `timed out: ${label}; sequencer exit ${seq.exitCode}`);
    await sleep(10);
  }
};
async function connection(world: string, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs: any[] = [];
  const socket = { ws, msgs, closedWith: 0,
    send: (msg: object) => ws.send(JSON.stringify(msg)),
    verb: (verb: string, args: object) => ws.send(JSON.stringify({ type: 'verb', verb, args })),
  };
  ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); msgs.push(m); record('wire.jsonl', { world, id, m }); };
  ws.onclose = ev => { socket.closedWith = ev.code; };
  await new Promise((r, j) => { ws.onopen = r as any; ws.onerror = j as any; });
  socket.send({ type: 'join', world, id, token: 'test-door' });
  await until(() => msgs.some(m => m.type === 'snapshot'), `${world}: ${id} snapshot`);
  return socket;
}
type Socket = Awaited<ReturnType<typeof connection>>;
let req = 0;
async function history(socket: Socket) {
  const reqId = `generation-${++req}`;
  socket.send({ type: 'history', reqId, limit: 100 });
  await until(() => socket.msgs.some(m => m.type === 'history' && m.reqId === reqId), reqId);
  return socket.msgs.find(m => m.type === 'history' && m.reqId === reqId).entries as any[];
}
const snapshot = (socket: Socket) => socket.msgs.filter(m => m.type === 'snapshot').at(-1);

for (const scenario of scenarios) {
  const observer = await connection(scenario, 'moderator');
  const old = await connection(scenario, 'same');
  const oldGen = snapshot(old).gen;
  // No earlier world/suite has used this model. Hold the real parser while
  // a burst from the old generation accumulates behind its cold spawn.
  old.verb('spawn', { id: 'stale', lib: lib(scenario), pos: [1, 0, 1] });
  old.verb('place', { id: 'stale', pos: [9, 0, 9] });
  old.verb('comp', { id: 'stale', type: 'label', data: 'stale' });
  old.verb('say', { text: 'stale generation' });
  await until(() => existsSync(gate(scenario, 'started')), `${scenario}: observed cold read`);
  check(`${scenario}: old burst waits on the observed cold read`, !(await history(old)).some(e => e.actor === 'same'));

  let current: Socket;
  if (scenario === 'rejoin') {
    // Same Client object, same world and roster slot, but a new acceptance.
    // Only binding the queued command to gen distinguishes this case.
    old.send({ type: 'join', world: scenario, id: 'same', token: 'test-door' });
    await until(() => snapshot(old).gen !== oldGen, 'same-socket rejoin');
    current = old;
  } else {
    if (scenario === 'disconnect') old.ws.close(1000, 'ordinary disconnect');
    if (scenario === 'expel') observer.verb('kick', { id: 'same', reason: 'generation regression' });
    if (scenario !== 'takeover') {
      await until(() => old.closedWith && observer.msgs.some(m => m.type === 'leave' && m.id === 'same'), `${scenario}: server retired client`);
    }
    current = await connection(scenario, 'same');
    await until(() => old.closedWith, `${scenario}: predecessor closed`);
  }
  const expectedClose = { takeover: 4002, disconnect: 1000, expel: 4006, rejoin: 0 }[scenario];
  check(`${scenario}: replacement owns a fresh accepted generation`,
    Number.isInteger(oldGen) && snapshot(current).gen > oldGen && old.closedWith === expectedClose);

  // The replacement waits on the SAME pending read. Its final say is a
  // product-door completion barrier, so absence assertions never race the
  // parser or rely on a grace-period sleep. Follow-up intents must work too.
  current.verb('spawn', { id: 'current', lib: lib(scenario), pos: [0, 0, 0] });
  current.verb('place', { id: 'current', pos: [4, 0, 4] });
  current.verb('comp', { id: 'current', type: 'label', data: 'current' });
  current.verb('say', { text: 'current generation' });
  check(`${scenario}: replacement waits for the same read`, !(await history(current)).some(e => e.args?.id === 'current'));
  writeFileSync(gate(scenario, 'release'), 'go');
  await until(() => current.msgs.some(m => m.entry?.verb === 'say' && m.entry.args.text === 'current generation'), `${scenario}: replacement burst committed`);
  const es = await history(current);
  const stale = es.filter(e => e.args?.id === 'stale' || e.args?.text === 'stale generation');
  check(`${scenario}: retired generation authors nothing after release`, stale.length === 0, JSON.stringify(stale));
  const state = emptyState();
  for (const e of [...es].sort((a, b) => a.seq - b.seq)) foldEntry(state, e);
  const authored = es.filter(e => e.args?.id === 'current').sort((a, b) => a.seq - b.seq);
  check(`${scenario}: replacement authors ordered, correctly folded edits`,
    authored.map(e => e.verb).join(',') === 'spawn,place,comp'
    && authored.every(e => e.actor === 'same') && JSON.stringify(state.entities.current?.pos) === '[4,0,4]'
    && state.entities.current?.comp?.label === 'current' && !state.entities.stale && seq.exitCode === null);
  current.ws.close(); observer.ws.close();
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);

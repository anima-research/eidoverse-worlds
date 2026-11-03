// bun run tools/presence-session-test.ts — the presence `session` on arrive and
// snapshot.present, against a real scratch sequencer over raw sockets.
// A page's own id outlives a reconnect, as its utterance counter does; a join
// without a usable id gets a fresh token per leg, never the process's
// connection counter.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scratchSequencer, mkCheck, sleep } from './harness.ts';
const { check, tally } = mkCheck();
const data = mkdtempSync(join(tmpdir(), 'presence-data-'));
const h = await scratchSequencer('presence', { serverEnv: {
  SKIP_OPT_SWEEP: '1', JOIN_TOKEN: 'test-door',
  OPT_DIR: join(data, 'opt'), STORE_DIR: join(data, 'store'), EIDOVERSE_DIR: join(data, 'library'),
} });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const open: WebSocket[] = [];
let completed = false;

async function until(test: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting for wire event');
    await sleep(25);
  }
}
/** Join as `id`, with `session` in the join when given; resolves after the snapshot. */
async function join_(id: string, session?: unknown) {
  const ws = new WebSocket(h.BASE.replace('http', 'ws') + '/ws');
  const got: any[] = [];
  ws.onmessage = e => got.push(JSON.parse(String(e.data)));
  await until(() => ws.readyState === 1);
  ws.send(JSON.stringify({ type: 'join', token: 'test-door', world: 'presence', id, ...(session === undefined ? {} : { session }) }));
  await until(() => got.some(m => m.type === 'snapshot'));
  open.push(ws);
  return { ws, got };
}
async function closeLeg(ws: WebSocket) {
  ws.close();
  await until(() => ws.readyState === 3);
}

try {
  const listener = await join_('listener');
  const arrivals = () => listener.got.filter(m => m.type === 'arrive' && m.id === 'speaker');

  const page = 'page-0123456789abcdef';
  let speaker = await join_('speaker', page);
  await until(() => arrivals().length === 1);
  check("a page's id is its session", arrivals()[0].session === page, JSON.stringify(arrivals()[0]));

  // The same page reconnects: same id, same session, so a listener keeps the
  // speaker's utterance memory (its counter goes on).
  await closeLeg(speaker.ws);
  speaker = await join_('speaker', page);
  await until(() => arrivals().length === 2);
  check('a reconnect of the same page keeps its session', arrivals()[1].session === page);

  const fresh = await join_('fresh-listener');
  const present = fresh.got.find(m => m.type === 'snapshot').present.find((p: any) => p.id === 'speaker');
  check("a snapshot carries the page's session", present?.session === page, JSON.stringify(present));

  // A join without an id (an agent, an older client) gets a token for its leg.
  await closeLeg(speaker.ws);
  speaker = await join_('speaker');
  await until(() => arrivals().length === 3);
  const token = arrivals()[2].session;
  check('a join without a session id gets a fresh per-leg token', typeof token === 'string' && UUID.test(token), token);
  await closeLeg(speaker.ws);
  speaker = await join_('speaker');
  await until(() => arrivals().length === 4);
  check('each such leg gets its own token', UUID.test(arrivals()[3].session) && arrivals()[3].session !== token);
  // A snapshot repeats the token its leg's arrive carried, so a listener
  // doesn't read it as a new sender.
  const later = await join_('later-listener');
  const tokenPresent = later.got.find(m => m.type === 'snapshot').present.find((p: any) => p.id === 'speaker');
  check("a snapshot repeats a leg's token", tokenPresent?.session === arrivals()[3].session, JSON.stringify(tokenPresent));

  // The id's bounds: 8 and 64 characters of A-Za-z0-9_- are relayed as sent.
  for (const ok of ['a1_b-C9x', 'Z'.repeat(64)]) {
    await closeLeg(speaker.ws);
    const before = arrivals().length;
    speaker = await join_('speaker', ok);
    await until(() => arrivals().length === before + 1);
    check(`a ${ok.length}-character session id is relayed`, arrivals()[before].session === ok, arrivals()[before].session);
  }

  // An unusable id is not relayed.
  for (const bad of ['short', 'has space in it!', 'x'.repeat(65), 42]) {
    await closeLeg(speaker.ws);
    const before = arrivals().length;
    speaker = await join_('speaker', bad);
    await until(() => arrivals().length === before + 1);
    const got = arrivals()[before].session;
    check(`an unusable session id (${JSON.stringify(bad).slice(0, 20)}) is replaced by a token`, UUID.test(got), got);
  }
  completed = true;
} finally {
  for (const ws of open) { try { ws.close(); } catch { /* closed */ } }
  await h.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(data, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);

// The caption bot's pipeline, executed with no stream, no STT vendor, and no
// world: a synthetic PCM source (tone bursts with silence between), a fake
// STT provider that honors voice-kit's session seam, the real tap, VAD,
// captioner, and window. What must hold:
//   A. segmentation — one caption per burst, t0/t1 on the burst's edges
//      (media time), finals only;
//   B. revision doctrine — a partial never becomes a caption; a revision
//      before settle replaces; one after emission is counted and dropped;
//   C. the stage cue labels the NEXT caption, not the ones already written;
//   D. a segment is SEALED once its finals settle: a revision after that is
//      counted and dropped, never a second caption, and the segment's own
//      bookkeeping goes with it (no per-line memory for a two-hour film);
//   E. the framer never drops a trailing partial frame;
//   F. an empty final is not a caption;
//   G. source loss is owned: ffmpeg exiting flushes the tap, resets its
//      clock, tells the caller (who rotates the session), and respawns with
//      a backoff — close() ends it for good;
//   H. the world client, offline: the queue is BOUNDED and overflow is loud
//      and spooled; a restart re-queues what the spool never saw confirmed;
//   I. the spool fails CLOSED: a line whose `queued` row cannot be written
//      is refused and intake halts, out loud; what was queued still drains;
//      `end` still goes through; SPOOL_BEST_EFFORT states the weaker promise.
//
//   bun tools/captionbot-test.ts   (run from a tree where tools/captionbot has its deps)
import type { SttProvider, SttSession, SttTranscript, SttSessionOptions } from '@animalabs/voice-kit';
import { AudioTap } from './captionbot/tap.ts';
import { framer } from './captionbot/sources.ts';
import { Captioner, type Caption } from './captionbot/captioner.ts';
import { ffmpegSource } from './captionbot/sources.ts';
import { WorldClient } from './captionbot/world.ts';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE = 16_000;

// ── the fake provider: one session per segment; commit() → a final ────────
class FakeSession implements SttSession {
  fns: Array<(t: SttTranscript) => void> = [];
  bytes = 0; committed = false; closed = false;
  constructor(private script: (n: number, emit: (t: SttTranscript) => void) => void, private n: number) {}
  sendAudio(pcm: Buffer) { this.bytes += pcm.length; }
  commit() { this.committed = true; this.script(this.n, (t) => this.fns.forEach((f) => f(t))); }
  close() { this.closed = true; }
  onTranscript(fn: (t: SttTranscript) => void) { this.fns.push(fn); }
  onError() {}
}
class FakeProvider implements SttProvider {
  readonly name = 'fake';
  sessions: FakeSession[] = [];
  constructor(private script: (n: number, emit: (t: SttTranscript) => void) => void) {}
  openSession(_o: SttSessionOptions): SttSession { const s = new FakeSession(this.script, this.sessions.length + 1); this.sessions.push(s); return s; }
}

// ── synthetic audio: a tone burst or silence, PCM16LE mono ──────────────
function tone(ms: number, dbfs = -20): Buffer {
  const n = Math.round(RATE * ms / 1000), amp = Math.round(32767 * 10 ** (dbfs / 20));
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 440 * i / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(Math.round(RATE * ms / 1000) * 2);

async function run(script: (n: number, emit: (t: SttTranscript) => void) => void, audio: Buffer[], opts: { speaker?: () => string | undefined; cueAt?: (t: number) => void; settleMs?: number } = {}) {
  const tap = new AudioTap(RATE);
  const provider = new FakeProvider(script);
  const cap = new Captioner({ rateHz: RATE, provider, settleMs: opts.settleMs ?? 30, speaker: opts.speaker, hangoverMs: 300, onsetMs: 60 });
  const out: Caption[] = [];
  cap.onCaption((c) => out.push(c));
  tap.attach(cap);
  // An operator advancing the cue in MEDIA time (a consumer after the
  // captioner, so the cue at a frame is what the captioner saw at that frame).
  if (opts.cueAt) tap.attach({ onPcm: (_f, t) => opts.cueAt!(t) });
  const f = framer(tap);
  for (const a of audio) f.write(a);
  f.end();
  await sleep((opts.settleMs ?? 30) * 6);
  return { out, provider, cap, tap };
}

console.log('— A. segmentation —');
{
  // 500 ms tone, 600 ms silence, 700 ms tone, 600 ms silence.
  const { out, provider } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: `segment ${n}`, final: true }), [tone(500), silence(600), tone(700), silence(600)]);
  check('one caption per burst', out.length === 2, JSON.stringify(out));
  check('one STT session per segment, each committed and closed', provider.sessions.length === 2 && provider.sessions.every((s) => s.committed), JSON.stringify(provider.sessions.map((s) => [s.bytes, s.committed])));
  const near = (a: number, b: number, tol = 0.08) => Math.abs(a - b) <= tol;
  check('first caption sits on its burst (t0≈0.00, t1≈0.50)', out[0] && near(out[0].t0, 0.0) && near(out[0].t1, 0.5), JSON.stringify(out[0]));
  check('second caption sits on its burst (t0≈1.10, t1≈1.80)', out[1] && near(out[1].t0, 1.1) && near(out[1].t1, 1.8), JSON.stringify(out[1]));
  check('times are media time, monotone', out[0].t1 <= out[1].t0);
  check('the session heard the burst, not the silence around it', provider.sessions[0].bytes >= RATE * 2 * 0.4 && provider.sessions[0].bytes <= RATE * 2 * 0.9, String(provider.sessions[0].bytes));
}

console.log('— B. revision doctrine —');
{
  const { out, cap } = await run((n, emit) => {
    emit({ utteranceId: `u${n}`, text: 'partial tex', final: false });
    emit({ utteranceId: `u${n}`, text: 'partial text, revis', final: false });
    emit({ utteranceId: `u${n}`, text: 'partial text, revised final', final: true });
    setTimeout(() => emit({ utteranceId: `u${n}`, text: 'partial text, revised final, settled', final: true }), 5);   // before settle: replaces
    setTimeout(() => emit({ utteranceId: `u${n}`, text: 'too late', final: true }), 120);                              // after emission: dropped
  }, [tone(400), silence(600)], { settleMs: 30 });
  await sleep(200);
  check('a partial never becomes a caption; the settled final does', out.length === 1 && out[0].text === 'partial text, revised final, settled', JSON.stringify(out));
  check('a revision after emission is counted and dropped', cap.lateRevisions === 1 && out.length === 1, String(cap.lateRevisions));
}

{
  // A segment whose STT never finalizes (a dropped connection mid-line, a
  // provider that gives up): partials alone must produce NO caption, ever.
  const { out } = await run((n, emit) => {
    emit({ utteranceId: `u${n}`, text: 'a partial that', final: false });
    emit({ utteranceId: `u${n}`, text: 'a partial that never lands', final: false });
  }, [tone(400), silence(600)], { settleMs: 30 });
  await sleep(150);
  check('partials with no final behind them never become a caption', out.length === 0, JSON.stringify(out));
}

console.log('— C. the stage cue —');
{
  // The operator cues "Ra" at media time 0.9 s — after the first burst ended
  // (0.4 s + hangover) and before the second begins (1.0 s).
  let who: string | undefined;
  const { out } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: `line ${n}`, final: true }),
    [tone(400), silence(600), tone(400), silence(600)], { speaker: () => who, cueAt: (t) => { if (t >= 0.9) who = 'Ra'; } });
  check('the cue labels the line spoken under it, not the one spoken before it', out.length === 2 && out[0].speaker === undefined && out[1].speaker === 'Ra', JSON.stringify(out));
  check('…and the label is fixed at segment end, not at STT settle time', out[0].speaker === undefined);
}

console.log('— D. sealing —');
{
  // one burst; the fake emits a final at commit, then (after the segment has
  // sealed) a revision of the same utterance and a brand-new final
  let late: ((t: SttTranscript) => void) | null = null;
  const { out, cap } = await run((n, emit) => { emit({ utteranceId: `u${n}`, text: 'first words', final: true }); late = emit; }, [tone(400), silence(600)], { settleMs: 30 });
  await sleep(30 * 10);   // past 8× settle: sealed
  late!({ utteranceId: 'u1', text: 'first words, revised', final: true });
  late!({ utteranceId: 'u1-b', text: 'a brand new final', final: true });
  await sleep(60);
  check('one caption from the burst; a revision AND a new final after sealing are counted, never emitted', out.length === 1 && out[0].text === 'first words' && cap.lateRevisions === 2, `${out.length} captions, ${cap.lateRevisions} late`);
  check('the sealed segment holds nothing (its pending map and emitted set are cleared)', (cap as any).segment === null);
}

console.log('— E. the framer —');
{
  const tap = new AudioTap(RATE);
  let frames = 0, bytes = 0;
  tap.attach({ onPcm: (f) => { frames++; bytes += f.length; } });
  const f = framer(tap);
  f.write(Buffer.alloc(1000)); f.write(Buffer.alloc(1000)); f.end();
  check('2000 bytes → 3 frames of 640 (the tail padded, never dropped)', frames === 4 && bytes === 4 * 640, `${frames} frames, ${bytes} bytes`);
  check('media time counts the samples fed', Math.abs(tap.mediaTime - 4 * 0.02) < 1e-9, String(tap.mediaTime));
}

console.log('— F. empties —');
{
  const { out } = await run((n, emit) => emit({ utteranceId: `u${n}`, text: '   ', final: true }), [tone(400), silence(600)]);
  check('an empty final is not a caption', out.length === 0, JSON.stringify(out));
}

console.log('— G. source loss is owned —');
{
  // a fake ffmpeg: emits some PCM, then exits on its own (code 1) — twice — then
  // stays up until closed
  const children: FakeChild[] = [];
  class FakeChild extends EventEmitter { stdout = new EventEmitter(); stderr = new EventEmitter(); killed = false; kill() { this.killed = true; this.emit('close', 0); } }
  const spawnFn = (() => { const c = new FakeChild(); children.push(c); setTimeout(() => { c.stdout.emit('data', Buffer.alloc(640 * 3)); if (children.length <= 2) c.emit('close', 1); }, 5); return c; }) as any;
  const tap = new AudioTap(RATE);
  let ends = 0, reattaches = 0;
  tap.attach({ onPcm() {}, onEnd() { ends++; } });
  const logs: string[] = [];
  const src = ffmpegSource('rtsp://nowhere/screen', tap, (m) => logs.push(m), { spawnFn, onReattach: () => reattaches++, minBackoffMs: 20, maxBackoffMs: 40 });
  await sleep(200);
  check('two unasked exits → two reattaches, each flushing the tap and resetting its clock', reattaches === 2 && ends === 2 && children.length === 3 && tap.mediaTime > 0 && tap.mediaTime < 0.1, `reattaches=${reattaches} ends=${ends} spawns=${children.length} mediaTime=${tap.mediaTime}`);
  check('…said out loud with the backoff', logs.filter((l) => /source lost; reattaching in/.test(l)).length === 2, JSON.stringify(logs));
  const before = children.length;
  src.close();
  await sleep(80);
  check('close() ends it for good: the child is killed and nothing respawns', children[before - 1].killed && children.length === before && src.attempts === 3, `spawns=${children.length} attempts=${src.attempts}`);
}

console.log('— H. the world client, offline —');
{
  const dir = mkdtempSync(join(tmpdir(), 'captionbot-spool-'));
  const spool = join(dir, 'spool.jsonl');
  const logs: string[] = [];
  const w = new WorldClient({ url: 'ws://127.0.0.1:1/ws', token: 't', world: 'w', actor: 'cap', screenId: 'cinema', spool, maxPending: 3, log: (m) => logs.push(m), agent: false });
  for (let i = 1; i <= 5; i++) w.caption({ t0: i, t1: i + 0.5, text: `line ${i}` });
  check('the queue is bounded: 5 queued into a bound of 3 keeps the newest 3', w.pendingCount === 3 && w.overflow === 2, `pending=${w.pendingCount} overflow=${w.overflow}`);
  check('…out loud', logs.some((l) => /overflow: dropped the 1 oldest/.test(l)) && logs.filter((l) => /overflow/.test(l)).length === 2, JSON.stringify(logs));
  const rows = readFileSync(spool, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the spool holds every line tried and each overflow by key', rows.filter((r) => r.state === 'queued').length === 5 && rows.filter((r) => r.state === 'overflow').map((r) => r.key).join() === `${w.session}#1,${w.session}#2`, JSON.stringify(rows.map((r) => [r.state, r.key])));
  check('n is monotonic within the session', rows.filter((r) => r.state === 'queued').map((r) => r.args.n).join() === '1,2,3,4,5');
  // a restart: a new client over the same spool re-queues the three unconfirmed
  // lines ahead of its own (later) session
  writeFileSync(spool, readFileSync(spool, 'utf8') + JSON.stringify({ state: 'acked', key: `${w.session}#3`, at: 1 }) + '\n');
  const w2 = new WorldClient({ url: 'ws://127.0.0.1:1/ws', token: 't', world: 'w', actor: 'cap', screenId: 'cinema', spool, log: (m) => logs.push(m), agent: false });
  check('a restart re-queues exactly the unconfirmed lines (4 and 5; 3 was confirmed, 1–2 overflowed)', w2.pendingCount === 2 && (w2 as any).pending.map((p: any) => p.args.n).join() === '4,5', JSON.stringify((w2 as any).pending.map((p: any) => p.key)));
  check('…under a session that follows the old one, so they drain first', w2.session > w.session && (w2 as any).pending[0].args.session === w.session);
  check('rotateSession refuses to go backwards', (() => { try { w2.rotateSession(w.session); return false; } catch { return true; } })());
}

console.log('— I. the spool fails closed —');
{
  const dir = mkdtempSync(join(tmpdir(), 'captionbot-spool-'));
  const good = join(dir, 'spool.jsonl');
  const logs: string[] = [];
  const w = new WorldClient({ url: 'ws://127.0.0.1:1/ws', token: 't', world: 'w', actor: 'cap', screenId: 'cinema', spool: good, log: (m) => logs.push(m), agent: false });
  w.caption({ t0: 1, t1: 1.5, text: 'before the disk went' });
  check('a writable spool takes the line', w.pendingCount === 1 && w.spoolRefused === 0 && w.spoolFailed === null);
  // the disk goes away under a running bot: the spool path is now unwritable
  (w as any).opts.spool = join(dir, 'no-such-dir', 'spool.jsonl');
  w.caption({ t0: 2, t1: 2.5, text: 'first line after' });
  check('the first line whose row cannot be written is refused, not queued', w.pendingCount === 1 && w.spoolRefused === 1 && /ENOENT/.test(w.spoolFailed ?? ''), `pending=${w.pendingCount} refused=${w.spoolRefused} failed=${w.spoolFailed}`);
  check('…out loud, naming the halt and the way out', logs.some((l) => /⛔ spool write failed .*intake halted.*1 already queued still drain.*SPOOL_BEST_EFFORT=1/.test(l)), JSON.stringify(logs));
  w.caption({ t0: 3, t1: 3.5, text: 'second line after' });
  check('intake stays halted: later lines are refused and counted, without per-line noise', w.pendingCount === 1 && w.spoolRefused === 2 && logs.filter((l) => /⛔/.test(l)).length === 1, `pending=${w.pendingCount} refused=${w.spoolRefused} ⛔-lines=${logs.filter((l) => /⛔/.test(l)).length}`);
  w.end();
  check('end is not a line: it goes through with the spool down', w.pendingCount === 2 && (w as any).pending[1].args.end === true, `pending=${w.pendingCount}`);
  const rows = readFileSync(good, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('the good spool holds exactly the line it took', rows.length === 1 && rows[0].state === 'queued' && rows[0].args.text === 'before the disk went');
  // the weaker promise, stated
  const logs2: string[] = [];
  const w2 = new WorldClient({ url: 'ws://127.0.0.1:1/ws', token: 't', world: 'w', actor: 'cap', screenId: 'cinema', spool: join(dir, 'no-such-dir', 'spool.jsonl'), spoolBestEffort: true, log: (m) => logs2.push(m), agent: false });
  w2.caption({ t0: 1, t1: 1.5, text: 'best effort' });
  w2.caption({ t0: 2, t1: 2.5, text: 'best effort 2' });
  check('SPOOL_BEST_EFFORT: the line queues anyway and nothing is refused', w2.pendingCount === 2 && w2.spoolRefused === 0, `pending=${w2.pendingCount} refused=${w2.spoolRefused}`);
  check('…and the failure is still recorded', /ENOENT/.test(w2.spoolFailed ?? ''), String(w2.spoolFailed));
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

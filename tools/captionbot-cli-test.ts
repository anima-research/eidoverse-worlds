// captionbot-cli-test — the shipping CLI's exit status is the spool's promise.
//
//   bun tools/captionbot-cli-test.ts
//
// captionbot-test proves WorldClient counts what the spool could not keep
// (`spoolLost`); this proves the PROCESS an operator or batch caller actually
// runs turns that count into its exit status. It spawns tools/captionbot/index.ts
// in FILE mode with a saved-transcript replay (no audio, no STT, no world
// reachable — the lines queue unconfirmed, which is exactly the case the spool
// exists for) and reads the exit code back:
//   A. fail-closed, spool unwritable → every line refused → exits 1;
//   B. best-effort, spool unwritable → lines queued without their row → exits 1;
//   C. spool writable → the promise is kept (unconfirmed lines are on disk) → exits 0;
//   D. a replayed row that isn't a caption line → nothing is sent → exits 1, naming its line;
//   E. the spool fails after the lines' rows, before the end's → the summary says
//      the end is not in the spool → exits 1;
//   F. no spool → the summary says the unconfirmed lines are in memory only;
//   G. lines dropped for overflow → the summary counts them → exits 1.
// Mutating the final owner back to an unconditional `process.exit(0)` turns
// A and B red (Mica, #202 round-three review).
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const CLI = new URL('./captionbot/index.ts', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'captionbot-cli-'));
const transcript = join(dir, 'lines.jsonl');
writeFileSync(transcript, [
  { t0: 0.5, t1: 1.2, text: 'first line', session: 'x', at: 1 },
  { t0: 1.4, t1: 2.0, text: 'second line', speaker: 'ra', session: 'x', at: 2 },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

const envFor = (extra: Record<string, string>) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
  FILE: transcript, SCREEN_ID: 'cinema', WORLD_URL: 'ws://127.0.0.1:1/ws', WORLD_TOKEN: 't',
  ...extra,
});
function run(extra: Record<string, string>) {
  const r = Bun.spawnSync(['bun', CLI], { env: envFor(extra), stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

console.log('\n— A. fail-closed: the spool cannot take a row —\n');
{
  const r = run({ SPOOL: join(dir, 'no-such-dir', 'spool.jsonl') });
  check('both lines are refused', /2 REFUSED \(spool unwritable/.test(r.out), r.out.slice(-400));
  check('the run exits non-zero', r.code === 1, `exit=${r.code}`);
}

console.log('\n— B. best-effort: the lines queue without their row —\n');
{
  const r = run({ SPOOL: join(dir, 'no-such-dir', 'spool.jsonl'), SPOOL_BEST_EFFORT: '1' });
  check('the summary says which lines are NOT in the spool, and that the end is not', /2 of this run's lines and its end are NOT in the spool/.test(r.out), r.out.slice(-400));
  check('the run exits non-zero', r.code === 1, `exit=${r.code}`);
}

console.log('\n— C. the promise kept: unconfirmed, but on disk —\n');
{
  const spool = join(dir, 'spool.jsonl');
  const r = run({ SPOOL: spool });
  const rows = readFileSync(spool, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // two lines and the session's `end` (end rides the spool too, so a restart replays it in order)
  check('the spool holds both lines and the end, all queued',
    rows.every((x) => x.state === 'queued') && rows.filter((x) => x.args?.text).length === 2 && rows.filter((x) => x.args?.end).length === 1,
    JSON.stringify(rows.map((x) => [x.state, x.args?.text ?? (x.args?.end ? 'end' : '?')])));
  check('the summary calls them unconfirmed, in the spool', /3 unconfirmed \(in the spool\)/.test(r.out), r.out.slice(-400));
  check('the run exits zero', r.code === 0, `exit=${r.code}`);
}

console.log('\n— D. a replayed row that is not a caption line fails the run, by its line —\n');
for (const [label, second] of [
  ['reversed times', JSON.stringify({ t0: 2, t1: 1, text: 'reversed times' })],
  ['empty text', JSON.stringify({ t0: 1, t1: 2, text: '   ' })],
  ['not JSON', '{"t0": 1,'],
] as const) {
  const name = label.replace(/ /g, '-');
  const file = join(dir, `bad-${name}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ t0: 0.5, t1: 1.2, text: 'first line' })}\n${second}\n`);
  const spool = join(dir, `spool-${name}.jsonl`);
  const r = run({ FILE: file, SPOOL: spool });
  check(`${label}: the run exits 1, naming line 2`, r.code === 1 && r.out.includes(`${file}:2: `), `exit=${r.code} ${r.out.slice(-300)}`);
  check(`${label}: nothing was queued, the valid first line included`, !existsSync(spool), existsSync(spool) ? readFileSync(spool, 'utf8') : '');
}

console.log('\n— E. the spool goes after the lines are on it, before the end —\n');
{
  const spool = join(dir, 'spool-end.jsonl');
  const rowsIn = (p: string) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0;
  // the CLI waits 2 s after the replay before it ends the session: once both
  // lines' rows are on disk, a directory takes the spool's place, so the
  // end's append is the first write to fail. A process stalled past those
  // 2 s misses the window (the end's row lands first), which says nothing
  // about the CLI, so that attempt is run again, up to three times.
  let rows = 0, caught = false, code: number | null = null, out = '';
  for (let attempt = 1; attempt <= 3 && !caught; attempt++) {
    rmSync(spool, { recursive: true, force: true }); rmSync(`${spool}.lines`, { force: true });
    const proc = Bun.spawn(['bun', CLI], { env: envFor({ SPOOL: spool }), stdout: 'pipe', stderr: 'pipe' });
    rows = 0;
    for (let i = 0; i < 3000 && rows < 2; i++) { await Bun.sleep(10); rows = rowsIn(spool); }
    if (rows === 2) { renameSync(spool, `${spool}.lines`); mkdirSync(spool); }
    else proc.kill();
    code = await proc.exited;
    out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    caught = rows === 2 && rowsIn(`${spool}.lines`) === 2;
  }
  check('the spool held both lines, and only them, before it went', caught, `rows=${rows}`);
  check('the end\'s failed write is said', /session's end queues anyway/.test(out), out.slice(-400));
  check('the summary says the end is NOT in the spool', /3 unconfirmed \(its end is NOT in the spool: /.test(out), out.slice(-400));
  check('the run exits non-zero', code === 1, `exit=${code}`);
}

console.log('\n— F. no spool: the summary says the lines are in memory only —\n');
{
  const r = run({ SPOOL: '' });
  check('the summary says the unconfirmed entries are in memory only', /3 unconfirmed \(in memory only: there is no spool\)/.test(r.out), r.out.slice(-400));
  check('the run exits zero: no spool, no promise', r.code === 0, `exit=${r.code}`);
}

console.log('\n— G. lines dropped for overflow: the summary counts them, and the run exits 1 —\n');
{
  // one line of room: the second line pushes the first out, and the end the second
  const r = run({ SPOOL: join(dir, 'spool-overflow.jsonl'), MAX_PENDING: '1' });
  check('the summary counts the lines dropped for overflow', /2 DROPPED for overflow/.test(r.out), r.out.slice(-400));
  check('the run exits non-zero', r.code === 1, `exit=${r.code}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
//   C. spool writable → the promise is kept (unconfirmed lines are on disk) → exits 0.
// Mutating the final owner back to an unconditional `process.exit(0)` turns
// A and B red (Mica, #202 round-three review).
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

function run(extra: Record<string, string>) {
  const r = Bun.spawnSync(['bun', CLI], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
      FILE: transcript, SCREEN_ID: 'cinema', WORLD_URL: 'ws://127.0.0.1:1/ws', WORLD_TOKEN: 't',
      ...extra,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
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
  check('the summary says which lines are NOT in the spool', /2 of this run's lines are NOT in the spool/.test(r.out), r.out.slice(-400));
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

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

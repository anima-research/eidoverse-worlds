// The product-door gate must detect losing either the final authority check
// or the generation ticket (same socket, same world, new accepted join).
// bun tools/verb-generation-mutation-test.ts
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, mkCheck } from './harness.ts';

const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), 'ew-generation-mutations-'));
const messagesPath = join(ROOT, 'server/messages.ts');
const source = readFileSync(messagesPath, 'utf8');
const mutations = [
  { name: 'remove the authority check immediately before runVerb',
    before: 'if (current()) runVerb', after: 'if (c.world === w) runVerb', scenarios: ['takeover', 'disconnect', 'rejoin'] },
  { name: 'remove only the captured generation comparison',
    before: 'c.gen === gen', after: 'true', scenarios: ['rejoin'] },
];
async function run(preload?: string) {
  const child = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), join(ROOT, 'tools/verb-generation-test.ts')], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out: out.replace(/\x1b\[[0-9;]*m/g, ''), err, code };
}
try {
  const control = await run();
  check('unmodified lifecycle gate passes', control.code === 0 && control.out.includes('20 passed, 0 failed'), control.code ? control.out + control.err : '');
  for (const mutation of mutations) {
    if (source.split(mutation.before).length !== 2) throw Error(`mutation target must occur exactly once: ${mutation.before}`);
    // Copy just this module into the test's temp dir, resolving its imports
    // back to the actual server. Never modify the working tree or handlers
    // beyond the stated guard mutation.
    const modified = source.replace(mutation.before, mutation.after).replace(
      /from (["'])(\.[^"']+)\1/g,
      (_, _quote, specifier) => `from ${JSON.stringify(new URL(specifier, new URL('../server/messages.ts', import.meta.url)).pathname)}`,
    );
    const copy = join(scratch, 'messages.ts'); writeFileSync(copy, modified);
    const childPreload = join(scratch, 'child.ts');
    writeFileSync(childPreload, `
import {mock} from 'bun:test';
await import(${JSON.stringify(join(ROOT, 'tools/box-read-gate.ts'))});
const modified = await import(${JSON.stringify(copy)});
mock.module(${JSON.stringify(messagesPath)}, () => modified);
`);
    const parentPreload = join(scratch, 'parent.ts');
    const harnessPath = join(ROOT, 'tools/harness.ts');
    writeFileSync(parentPreload, `
import {mock} from 'bun:test';
const real = await import(${JSON.stringify(harnessPath)});
const spawn = real.scratchSequencer;
mock.module(${JSON.stringify(harnessPath)}, () => ({...real,
  scratchSequencer: (name, opts) => spawn(name, {...opts, preload: ${JSON.stringify(childPreload)}}),
}));
`);
    const result = await run(parentPreload);
    const caught = result.code === 1 && mutation.scenarios.every(scenario =>
      result.out.includes(`✗ ${scenario}: retired generation authors nothing after release`));
    check(`${mutation.name} makes the lifecycle gate red`, caught, caught ? '' : result.out + result.err);
    const diagnostics = /failure diagnostics retained at ([^\r\n]+)/.exec(result.err)?.[1];
    if (diagnostics && caught) rmSync(diagnostics, { recursive: true, force: true });
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);

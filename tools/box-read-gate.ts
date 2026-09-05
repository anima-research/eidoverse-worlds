// Test-only preload: hold actual GLB reads until the owning product-door test
// releases them. No production timing flags or replacement geometry involved.
import { mock } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
const geometry = await import('../server/geometry.ts');
const summarize = geometry.summarizeGlb;
const gate = join(process.env.WORLDS_DIR!, '..', 'box-gate');
mock.module(new URL('../server/geometry.ts', import.meta.url).pathname, () => ({
  ...geometry,
  summarizeGlb: async (file: string) => {
    const name = basename(file);
    writeFileSync(join(gate, `${name}.started`), 'read started');
    const start = Date.now();
    while (!existsSync(join(gate, `${name}.release`))) {
      if (Date.now() - start > 10_000) throw new Error(`box gate timed out: ${name}`);
      await Bun.sleep(10);
    }
    return summarize(file);
  },
}));

// Re-measure a candidate ground-smoke response before adding its hash to the
// fixture manifest. bun tools/ground-asset-check.ts path/to/model.glb
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { summarizeGlb } from '../server/geometry.ts';
import manifest from '../spec/fixtures/sim-ground-assets.json';
const file = process.argv[2];
if (!file) throw new Error('usage: bun tools/ground-asset-check.ts path/to/model.glb');
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
const s = await summarizeGlb(file);
if (!s) throw new Error('cannot measure model');
const matches = s.tris === manifest.triangles
  && JSON.stringify({ min:s.bbox.min, max:s.bbox.max }) === JSON.stringify(manifest.bbox)
  && JSON.stringify([s.bbox.center[0],s.bbox.center[2]]) === JSON.stringify(manifest.offsetXZ);
console.log(JSON.stringify({ file, sha256, bbox:s.bbox, triangles:s.tris, matches }, null, 2));
process.exit(matches ? 0 : 1);

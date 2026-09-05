// Extract only node transforms/parentage and the humanoid map; no meshes or
// textures are needed by the doll suite. Usage:
// bun tools/extract-doll-fixture.ts path/to/rig.vrm > fixture.json
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { glbJson } from './rig-load.mjs';
const file = process.argv[2];
if (!file) throw new Error('usage: bun tools/extract-doll-fixture.ts rig.vrm');
const bytes = readFileSync(file), g = glbJson(bytes);
const fields = ['name', 'children', 'translation', 'rotation', 'scale', 'matrix'];
console.log(JSON.stringify({
  source: { file: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  nodes: g.nodes.map((n: any) => Object.fromEntries(fields.filter(k => k in n).map(k => [k, n[k]]))),
  extensions: g.extensions.VRMC_vrm
    ? { VRMC_vrm: { humanoid: g.extensions.VRMC_vrm.humanoid } }
    : { VRM: { humanoid: g.extensions.VRM.humanoid } },
}, null, 2));

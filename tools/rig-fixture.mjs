// tools/rig-fixture.mjs — write a VRM's skeleton (nodes + humanoid map, no meshes, no textures) as a repo fixture, so a
// suite that needs a real rig runs on a host without the avatar library (rig-load.mjs fixtureRig reads it back).
//   bun tools/rig-fixture.mjs <path/to/name.vrm>        → spec/fixtures/<name>-rig.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { glbJson } from '../shared/rig.js';
const src = process.argv[2]; if (!src) { console.error('usage: bun tools/rig-fixture.mjs <name.vrm>'); process.exit(2); }
const bytes = readFileSync(src), g = glbJson(bytes), name = basename(src).replace(/\.vrm$/, '');
const keep = ['name', 'translation', 'rotation', 'scale', 'matrix', 'children'];
const nodes = g.nodes.map((n) => Object.fromEntries(keep.filter((k) => n[k] !== undefined).map((k) => [k, n[k]])));
const ext = {};
if (g.extensions?.VRMC_vrm) ext.VRMC_vrm = { specVersion: g.extensions.VRMC_vrm.specVersion, humanoid: g.extensions.VRMC_vrm.humanoid };
if (g.extensions?.VRM) ext.VRM = { humanoid: g.extensions.VRM.humanoid };
const fx = { source: { file: basename(src), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  scene: g.scene, scenes: g.scenes, nodes, extensions: ext };
const out = new URL(`../spec/fixtures/${name}-rig.json`, import.meta.url);
writeFileSync(out, JSON.stringify(fx) + '\n');
console.log(`wrote ${out.pathname} (${nodes.length} nodes)`);

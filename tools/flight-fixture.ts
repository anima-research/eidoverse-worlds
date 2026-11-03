// flight-fixture — derive the tested bone map from the ACTUAL shipped asset.
//
//   bun tools/flight-fixture.ts
//
// mica: "the body test hardcodes a claimed bone list; it does not parse the
// actual 24,755,464-byte mythos-wings artifact... Do not call a literal array
// 'the shipped body'." Right -- an array typed into a test cannot go stale
// against a file, so it proves nothing about the file.
//
// This reads the VRM and writes spec/fixtures/mythos-wings-rig.json: SHA-256
// (integrity), byte size, and the full bone map. The ASSET is not in the branch
// (24 MB, gitignored); the FIXTURE is, so a reviewer without the asset still
// sees exactly which rig was tested and can verify the hash against their own
// copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const P = 'assets/opt/eidoverse/assets/vrms/mythos-wings.vrm';
const d = readFileSync(P);
const jl = d.readUInt32LE(12);
const g = JSON.parse(d.subarray(20, 20 + jl).toString());
const bones = g.nodes.filter(n => n.name).map(n => n.name).sort();
const fx = {
  source: P,
  bytes: d.length,
  sha256: createHash('sha256').update(d).digest('hex'),
  md5: createHash('md5').update(d).digest('hex'),
  boneCount: bones.length,
  bones,
};
writeFileSync('spec/fixtures/mythos-wings-rig.json', JSON.stringify(fx, null, 2) + '\n');
console.log('bytes', fx.bytes, '\nsha256', fx.sha256, '\nbones', fx.boneCount);

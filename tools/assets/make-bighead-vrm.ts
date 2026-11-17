// make-bighead-vrm — a test rig whose head mesh surrounds a camera at the head joint (#75 eye anchor).
//   bun tools/assets/make-bighead-vrm.ts <src.vrm> <out.vrm> [scale]
// Sets the humanoid head bone's scale to [s, s, s] (default 5; it replaces any scale the node had) without moving it;
// GLB container surgery only. VRM 0.x and 1.0.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [src, out, scaleArg] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: bun tools/assets/make-bighead-vrm.ts <src.vrm> <out.vrm> [scale]");
  process.exit(2);
}
const SCALE = Number(scaleArg ?? 5);

const buf = readFileSync(src);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error("not a GLB"); process.exit(1); }
const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== 0x4e4f534a) { console.error("first chunk is not JSON"); process.exit(1); }
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
const rest = buf.subarray(20 + jsonLen);   // BIN chunk(s), byte-preserved

const headNode =
  json.extensions?.VRM?.humanoid?.humanBones?.find((b: { bone: string }) => b.bone === "head")?.node
  ?? json.extensions?.VRMC_vrm?.humanoid?.humanBones?.head?.node;
if (headNode == null) { console.error("no humanoid head bone in VRM metadata"); process.exit(1); }

json.nodes[headNode].scale = [SCALE, SCALE, SCALE];
console.log(`head bone = node ${headNode} ("${json.nodes[headNode].name ?? "?"}") → scale ×${SCALE}`);

let jsonOut = Buffer.from(JSON.stringify(json), "utf8");
if (jsonOut.length % 4) jsonOut = Buffer.concat([jsonOut, Buffer.alloc(4 - (jsonOut.length % 4), 0x20)]);

const head = Buffer.alloc(20);
head.writeUInt32LE(0x46546c67, 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(20 + jsonOut.length + rest.length, 8);
head.writeUInt32LE(jsonOut.length, 12);
head.writeUInt32LE(0x4e4f534a, 16);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([head, jsonOut, rest]));
console.log(`wrote ${out} (${20 + jsonOut.length + rest.length} bytes)`);

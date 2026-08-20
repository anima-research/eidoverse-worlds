// Does an agent standing inside a griddled building know where it is?
//
//   WORLD_URL=ws://localhost:8961/ws JOIN_TOKEN=test-door \
//     bun run tools/structure-look-probe.ts structdemo
//
// This is the claim the whole slice exists to test, so it is checked against a
// live sequencer rather than a fixture: a headless agent with no scene, no
// triangles and no renderer walks from room to room and reads its own percept
// back. Everything it says is derived from folded state alone.

import { WorldAgent } from '../mcpl/agent.ts';

const URL_ = process.env.WORLD_URL ?? 'ws://localhost:8961/ws';
const WORLD = process.argv[2] ?? 'structdemo';

const ag = new WorldAgent({ url: URL_, name: 'roomprobe', world: WORLD });
await ag.connect();
await new Promise((r) => setTimeout(r, 800));

/** The "You are in …" sentence out of a full look(), or a marker. */
const hereLine = (text: string) =>
  text.split('\n').find((l) => l.startsWith('You are in ')) ?? '(no room line)';
const buildingLine = (text: string) =>
  text.split('\n').find((l) => /a building:/.test(l))?.trim() ?? '(no building line)';

// The house sits at the origin, 6×4 tiles. Room centres, in world metres.
const SPOTS: [string, number, number][] = [
  ['kitchen (1.5, 1.0)', 1.5, 1.0],
  ['bedroom (1.5, 3.0)', 1.5, 3.0],
  ['hall    (4.5, 2.0)', 4.5, 2.0],
  ['outside (9.0, 9.0)', 9.0, 9.0],
];

console.log(`\nprobing "${WORLD}" — what an agent knows from folded state alone\n`);
console.log(`  entity line: ${buildingLine(await ag.look())}\n`);

let failed = 0;
for (const [label, x, z] of SPOTS) {
  // teleport rather than walk: walkTo goes in a straight line and does not
  // consult colliders (agent.ts:848), so it would happily cross a wall — the
  // known gap this slice surfaces rather than fixes. Perception is what is
  // under test here, not locomotion.
  ag.pos.x = x; ag.pos.z = z;
  const line = hereLine(await ag.look());
  console.log(`  ${label}\n    ${line}\n`);
  const expect = label.split(' ')[0];
  const ok = expect === 'outside' ? line === '(no room line)' : line.includes(expect);
  if (!ok) { failed++; console.log(`    ✗ expected ${expect}`); }
}

console.log(failed ? `\n${failed} spot(s) wrong` : '\nevery spot named its own room');
process.exit(failed ? 1 : 0);

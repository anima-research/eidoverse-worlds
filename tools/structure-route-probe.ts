// Does a routed walk actually go through the doorway?
//
//   WORLD_URL=ws://localhost:8962/ws WORLD_TOKEN=test-door \
//     bun run tools/structure-route-probe.ts structdemo
//
// The headless suite proves the CELL route is legal. This proves the wire-in:
// that grid-local waypoints come back out into world space correctly, and that
// a body asked to cross the house ends up where it was sent without passing
// through a wall on the way. Sampled along the walk, because arriving is not
// evidence — walking straight through the divider also arrives.

import { WorldAgent } from '../mcpl/agent.ts';
import { planStructure, localizePoint, passable, cellKey } from '../shared/structure.js';

const ag = new WorldAgent({ url: process.env.WORLD_URL ?? 'ws://localhost:8962/ws',
  name: 'router', world: process.argv[2] ?? 'structdemo' });
await ag.connect();
await new Promise((r) => setTimeout(r, 900));

const ent: any = [...(ag as any).entities.values()].find((e: any) => e.comp?.structure);
if (!ent) { console.log('no structure in world'); process.exit(1); }
const plan = planStructure(ent.comp.structure);
const lv = plan.levels[0].level;

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const cellOf = (wx: number, wz: number) => {
  const [lx, , lz] = localizePoint(ent, wx, 0, wz);
  return cellKey(Math.floor(lx / plan.grid.tile), Math.floor(lz / plan.grid.tile));
};

// kitchen (1.5, 0.5) → bedroom (1.5, 3.5): only route is through the hall,
// which means two doorways and a turn. A straight line crosses two walls.
(ag as any).pos.x = 1.5; (ag as any).pos.z = 0.5;
console.log(`\nrouted walk — start cell ${cellOf(1.5, 0.5)}\n`);

const trail: string[] = [];
const tick = setInterval(() => {
  const p = (ag as any).pos;
  const c = cellOf(p.x, p.z);
  if (trail[trail.length - 1] !== c) trail.push(c);
}, 40);

const ok = await ag.walkTo(1.5, 3.5, false, 40_000);
clearInterval(tick);

check('the walk completes', ok === true);
check('it ends in the bedroom', cellOf((ag as any).pos.x, (ag as any).pos.z) === '1,3',
  cellOf((ag as any).pos.x, (ag as any).pos.z));
check('it visited the hall', trail.some((c) => c.startsWith('3,') || c.startsWith('4,') || c.startsWith('5,')),
  trail.join(' → '));
// EVERY cell transition on the trail must have been legal
const illegal = trail.slice(1).filter((c, i) => {
  const [ax, az] = trail[i].split(',').map(Number);
  const [bx, bz] = c.split(',').map(Number);
  if (Math.abs(ax - bx) + Math.abs(az - bz) !== 1) return false;  // diagonal sample skip
  return !passable(lv, ax, az, bx, bz);
});
check('no step crossed a wall', illegal.length === 0, `${illegal.length}: ${trail.join(' → ')}`);
console.log(`\n  trail: ${trail.join(' → ')}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

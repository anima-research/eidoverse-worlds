// the arrival hold's rules (client/lib/arrivalnear.js): which placed models a
// restored body waits for, and which are near it. Pure: no page, no renderer.
//   bun tools/arrival-hold-test.ts
// The hold itself, in a real browser: tools/getup-browser-test.ts.
import { stillArriving, footprintOf, arrivingNear, NEAR } from '../client/lib/arrivalnear.js';
import { mkCheck } from './harness.ts';

const { check, tally } = mkCheck();
const placeholder = { userData: { placeholder: true } };
const real = { userData: {} };
const model = { kind: 'model' };
const resident = { resident: true };

// ---- what is still on its way
check('a bare reservation the realizer will load (within its residency radius) is still on its way', stillArriving(model, null, resident) === true);
check('...but one beyond that radius, which the realizer never loads, is not', stillArriving(model, null, { resident: false }) === false);
check('a placeholder the realizer will load is still on its way', stillArriving(model, placeholder, resident) === true);
check('a load in flight is still on its way, wherever it is', stillArriving({ ...model, loading: true }, null, { resident: false }) === true);
check('a realized model whose promote tail (its collider) is still queued is still on its way', stillArriving(model, real, { tailPending: true }) === true);
check('a realized model whose tail has run has arrived, collider or not (decorative, a structure\'s, a reduced tier)',
  stillArriving(model, real, resident) === false);
check('a stand-in waiting out a failed load\'s back-off is not waited on', stillArriving(model, null, { resident: true, backingOff: true }) === false);
check('...but its retry, in flight, is', stillArriving({ ...model, loading: true }, null, { resident: true, backingOff: true }) === true);
check('...and a retry that loaded, its collider still queued, is: the old failure doesn\'t count',
  stillArriving(model, real, { tailPending: true, resident: true, backingOff: true }) === true);
check('...and a model that failed long ago, a stand-in again the sweep will load, is', stillArriving(model, placeholder, { resident: true, backingOff: false }) === true);
check('an id the realizer holds nothing for, a light, or an id it never tracked, is not a model on its way',
  stillArriving(model, undefined, resident) === false && stillArriving({ kind: 'light' }, null, resident) === false
  && stillArriving(undefined, null, resident) === false);

// ---- where a model stands on the ground
{
  const f = footprintOf({ pos: [10, 0, 5] }, null);
  check('before its geom, a model\'s size isn\'t known: it can\'t be ruled out anywhere', f.r === Infinity, JSON.stringify(f));
  const g = footprintOf({ pos: ['x', 0, 5] }, { bbox: { center: [0, 0, 0], size: [4, 4, 4] } });
  check('...nor can one whose place isn\'t a number', g.r === Infinity, JSON.stringify(g));
  const m = footprintOf({ pos: [10] }, { bbox: { center: [0, 0, 0], size: [4, 4, 4] } });
  check('...nor one whose place is missing a coordinate', m.r === Infinity, JSON.stringify(m));
  const p = footprintOf({ pos: ['10', '0', '-4'] }, { bbox: { center: [0, 0, 0], size: [4, 4, 4] } });
  check('a place given as numeric strings is placed as the realizer renders it', p.x === 10 && p.z === -4 && Math.abs(p.r - Math.hypot(4, 4) / 2) < 1e-9, JSON.stringify(p));
}
{
  // a 40×40 m hall whose origin is its south-west corner
  const geom = { bbox: { center: [20, 3, 20], size: [40, 6, 40] } };
  const f = footprintOf({ pos: [0, 0, 0] }, geom);
  check('with its geom, the footprint is the bbox: centred on it, the circle round it its half-diagonal across the ground',
    f.x === 20 && f.z === 20 && Math.abs(f.r - Math.hypot(40, 40) / 2) < 1e-9, JSON.stringify(f));
  const t = footprintOf({ pos: [0, 0, 0], yaw: Math.PI / 2 }, geom);
  check('...turned as the model is turned (yaw 90°: the corner-origin hall lies toward +x, -z)',
    Math.abs(t.x - 20) < 1e-9 && Math.abs(t.z + 20) < 1e-9, JSON.stringify(t));
  const s = footprintOf({ pos: [0, 0, 0], yaw: String(Math.PI / 2), scale: '2' }, geom);
  check('...with a scale and yaw given as numeric strings, placed as the realizer renders them',
    Math.abs(s.x - 40) < 1e-9 && Math.abs(s.z + 40) < 1e-9 && Math.abs(s.r - Math.hypot(40, 40)) < 1e-9, JSON.stringify(s));
}
{
  // a 10×4 m shed, its bbox centre off its origin, placed at (10, -4) at twice its size
  const geom = { bbox: { center: [3, 1, 1], size: [10, 2, 4] } };
  const f = footprintOf({ pos: [10, 0, -4], scale: 2 }, geom);
  check('a scaled model placed off the origin: its centre is placed and scaled, its circle from its ground size scaled',
    f.x === 16 && f.z === -2 && Math.abs(f.r - Math.hypot(10, 4)) < 1e-9, JSON.stringify(f));
}

// ---- which of them are near a body
{
  const hall = { lib: 'store/hall.glb', pos: [0, 0, 0] };
  const geom = { bbox: { center: [20, 3, 20], size: [40, 6, 40] } };
  const arriving = () => true;
  const withGeom = (_id: string, e: any) => footprintOf(e, geom);
  const noGeom = (_id: string, e: any) => footprintOf(e, null);
  // the body stands upstairs in the hall's far corner, 54 m from its origin
  const [bx, bz] = [38, 38];
  check('a body inside a large hall whose origin is far from it is near the hall (its footprint)',
    arrivingNear(bx, bz, { hall }, arriving, withGeom).length === 1);
  check('a hall whose size isn\'t known yet holds the body too, while it is on its way',
    arrivingNear(bx, bz, { hall }, arriving, noGeom).length === 1);
  check('a model that has arrived holds nothing', arrivingNear(bx, bz, { hall }, () => false, withGeom).length === 0);
  check('lights and collide:"none" never hold',
    arrivingNear(0, 0, { l: { lib: '(light)', pos: [0, 0, 0] }, g: { lib: 'store/ghost.glb', pos: [0, 0, 0], collide: 'none' } }, arriving, noGeom).length === 0);
  // the circle round the hall is centred at (20, 20) with radius 28.3: a body
  // 10 m beyond it is within NEAR, one 20 m beyond it is not
  const r = Math.hypot(40, 40) / 2;
  // (literal distances: a test that placed the body by NEAR itself would pass whatever NEAR said)
  check(`a body 10 m beyond the circle round a footprint is near it (NEAR is ${NEAR} m)`,
    arrivingNear(20 + r + 10, 20, { hall }, arriving, withGeom).length === 1);
  check('...and one 20 m beyond it is not', arrivingNear(20 + r + 20, 20, { hall }, arriving, withGeom).length === 0);
  check('with `first`, the search stops at the first',
    arrivingNear(bx, bz, { hall, hall2: hall }, arriving, withGeom, true).length === 1
    && arrivingNear(bx, bz, { hall, hall2: hall }, arriving, withGeom).length === 2);
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);

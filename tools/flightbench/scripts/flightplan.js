// flightplan — a filed flight plan, as a runtime behavior.
//
// The experiment: can spec §4's PLAN layer ("a short flight plan I can file in
// one call for set pieces -- maiden flight, deliveries, laps") be the existing
// behaviors sandbox rather than a new flight-specific tool?
//
// A plan is a list of legs. The behavior walks it on a timer, emitting one
// verb per leg, and stops when a live verb cancels it or the list runs out.
//
//   knobs: { legs: [ {verb, ...args}, ... ], tick: 5 }
//
// Everything it needs from the sandbox: world.knobs to carry the plan,
// world.every for the clock, world.kv to remember which leg is next across
// activations, world.emit to act, world.log for the flight recorder.

const LEGS = Array.isArray(world.knobs.legs) ? world.knobs.legs : [];
const TICK = Math.max(5, Number(world.knobs.tick) || 5);

function leg() { return Number(world.kv.get('leg') ?? 0); }
function setLeg(n) { world.kv.set('leg', n); }
function cancelled() { return world.kv.get('cancelled') === true; }

// A live verb outranks the plan (spec §4: "Cancelable by any live verb").
// Anything the pilot says that starts with "cancel" stands in for that here --
// the real cancel would be the flight tool itself clearing the flag.
world.on('say', (e) => {
  if (e.by === world.knobs.pilot && /^\s*cancel\b/i.test(e.text)) {
    world.kv.set('cancelled', true);
    world.log('plan cancelled by a live verb from', e.by);
  }
});

world.every(TICK, () => {
  if (cancelled()) return;
  const i = leg();
  if (i >= LEGS.length) {
    if (world.kv.get('done') !== true) {
      world.kv.set('done', true);
      world.log('plan complete —', LEGS.length, 'legs');
    }
    return;
  }
  const l = LEGS[i] || {};
  world.log(`leg ${i + 1}/${LEGS.length}:`, l.verb, JSON.stringify(l.args ?? {}));
  try {
    world.emit(l.verb, l.args ?? {});
    setLeg(i + 1);
  } catch (err) {
    // A refused emit THROWS with the reason. A plan that cannot fly its next
    // leg should say so and stop, not spin against the budget.
    world.log('leg refused:', String(err && err.message || err), '— plan halted');
    world.kv.set('cancelled', true);
  }
});

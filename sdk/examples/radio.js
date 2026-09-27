// radio — a `use {action: "toggle"}` on the thing this is bound to flips its
// sound: playing ↔ paused, with a fresh t0 on every start so everyone hears
// the same bar. Bind it as the radio's PLACER: the script writes with your
// standing, so a guarded radio (comp {type: "guard"}) still takes a visitor's
// toggle without opening its comps to visitors.
//
//   behavior {id: "radio", src: <upload>, attach: "radio1",
//             knobs: {action: "toggle"}}
//
// With the `interaction` comp the browser's E key / gamepad / button aim at
// exactly this action:  comp {id: "radio1", type: "interaction",
//                             data: {action: "toggle", label: "turn the radio on/off"}}

const ACTION = world.knobs.action ?? 'toggle';

world.on('use', (e) => {
  if (e.action !== ACTION) return;
  const ent = world.entity(e.entity);
  const s = ent && ent.comp && ent.comp.sound;
  if (!s || typeof s !== 'object') { world.log('no sound comp on', e.entity, '— nothing to toggle'); return; }
  const wasPlaying = s.playing !== false;
  const next = Object.assign({}, s, { playing: !wasPlaying });
  if (!wasPlaying) next.t0 = Date.now(); else delete next.t0;
  world.emit('comp', { id: e.entity, type: 'sound', data: next });
  world.log(e.by, wasPlaying ? 'switched it off' : 'switched it on');
});

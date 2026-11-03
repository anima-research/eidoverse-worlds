// bun tools/underwater-presence-test.ts — pure validation, no running world.
import { strict as assert } from 'node:assert';
import { sanePose } from '../server/posecheck.ts';
const pose = {p:[12,-30,8],yaw:0,speed:1.4,clip:'walk',q:[0,0,0,1],
  locomotion:{mode:'swim',medium:'water',body:'diver'}};
assert.equal(sanePose(pose),pose);
assert.ok(sanePose({p:[0,-1000,0],yaw:0,clip:'idle'}));
for (const q of [[0,0,0,0],[0,0,0,2],[NaN,0,0,1],[0,0,1],['0',0,0,1]])
  assert.equal(sanePose({...pose,q}),null);
for (const locomotion of [null,[],{mode:42},{medium:'x'.repeat(33)},{extra:Infinity}])
  assert.equal(sanePose({...pose,locomotion}),null);
assert.ok(sanePose({...pose,locomotion:{mode:'future-mode',extra:{value:1}}}));
assert.equal(sanePose({...pose,p:[0,Infinity,0]}),null);
console.log('UNDERWATER_POSE_VALIDATION_PASS');

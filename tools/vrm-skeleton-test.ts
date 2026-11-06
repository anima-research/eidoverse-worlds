/** bun tools/vrm-skeleton-test.ts — one skeleton pass per VRM parse. */
import assert from 'node:assert/strict';
import { optimizeVrmSkeleton } from '../client/lib/vrmskeleton.js';

const scene = { name: 'avatar' };
const calls: string[] = [];
const warnings: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

const legacy = (root: unknown) => {
  console.warn('VRMUtils.removeUnnecessaryJoints: removeUnnecessaryJoints is deprecated. Use combineSkeletons instead.');
  calls.push(`legacy:${(root as { name?: string }).name}`);
};
const modern = (root: unknown) => {
  calls.push(`modern:${(root as { name?: string }).name}`);
};

optimizeVrmSkeleton({ combineSkeletons: modern, removeUnnecessaryJoints: legacy }, scene);
assert.deepEqual(calls, ['modern:avatar'], 'a void modern optimizer runs once');
assert.deepEqual(warnings, [], 'the deprecated optimizer does not warn when the modern one exists');

calls.length = 0;
optimizeVrmSkeleton({ combineSkeletons: modern, removeUnnecessaryJoints: legacy }, scene);
assert.deepEqual(calls, ['modern:avatar']);

calls.length = 0;
warnings.length = 0;
optimizeVrmSkeleton({ removeUnnecessaryJoints: legacy }, scene);
assert.deepEqual(calls, ['legacy:avatar'], 'without the modern optimizer the legacy one still runs once');
assert.equal(warnings.length, 1);

calls.length = 0;
warnings.length = 0;
optimizeVrmSkeleton({ combineSkeletons: 'not-a-function', removeUnnecessaryJoints: legacy }, scene);
assert.deepEqual(calls, ['legacy:avatar'], 'a non-function modern export falls through once');

for (const utils of [{}, null, undefined]) {
  optimizeVrmSkeleton(utils, scene);
}
assert.deepEqual(calls, ['legacy:avatar'], 'absent optimizers add no call and no throw');

console.warn = warn;
console.log('vrm skeleton: one pass, legacy only as fallback');

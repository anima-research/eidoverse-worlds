import assert from 'node:assert/strict';
import { materialLayerSpecs } from '../shared/terrainlayers.js';

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; } };

const authored = [{ color: '#123456', repeat: 7 }, { color: '#abcdef' }];
test('array material layers pass through by identity', () => assert.equal(materialLayerSpecs(authored), authored));
test('missing layers means no material layers', () => assert.deepEqual(materialLayerSpecs(undefined), []));
test('null layers means no material layers', () => assert.deepEqual(materialLayerSpecs(null), []));
test('legacy numeric layers is ignored, not executed', () => assert.deepEqual(materialLayerSpecs(1), []));
test('object-shaped layers is ignored', () => assert.deepEqual(materialLayerSpecs({ color: '#fff' }), []));
test('string-shaped layers is ignored', () => assert.deepEqual(materialLayerSpecs('grass'), []));

console.log(`\n${passed}/6 terrain-layer compatibility checks passed`);
if (passed !== 6) process.exitCode = 1;

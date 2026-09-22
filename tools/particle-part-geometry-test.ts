// bun tools/particle-part-geometry-test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { summarizeGlb } from '../server/geometry.ts';
const dir = mkdtempSync(join(tmpdir(), 'particle-part-geometry-'));
try {
  const doc = new Document();
  const scene = doc.createScene();
  const group = doc.createNode('hinge'); scene.addChild(group);
  group.addChild(doc.createNode('wax'));
  doc.createNode('orphan');
  for(let i=0;i<40;i++) group.addChild(doc.createNode(`part-${i}`));
  const file = join(dir,'parts.glb');
  await new NodeIO().write(file,doc);
  const sum = await summarizeGlb(file);
  assert(sum.nodeNames.includes('hinge') && sum.nodeNames.includes('wax'));
  assert(sum.nodeNames.includes('part-39'), 'attachment names are not capped with mesh summaries');
  assert(!sum.nodeNames.includes('orphan'), 'unattached export nodes cannot anchor emitters');
  assert.equal(sum.nodes.length,0, 'transform-only attachment nodes need no mesh');
  console.log('particle attachment geometry names passed');
} finally { rmSync(dir,{recursive:true,force:true}); }

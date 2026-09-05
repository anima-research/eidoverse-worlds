// Isolated visual fixture: real sequencer, real GLBs, real fold. No browser automation.
// Run with Bun, open the printed URL, then Ctrl-C to remove the scratch world.
import { Document, NodeIO } from '@gltf-transform/core';
import { BoxGeometry } from 'three';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedWorld } from './probe-harness.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ew-label-preview-'));
const library = join(scratch, 'library'), worlds = join(scratch, 'worlds');
mkdirSync(library); mkdirSync(join(worlds, 'labels'), { recursive: true });
let server;
try {
  const log = [];
  const emit = (verb: string, args: object) => log.push({
    verb, args, seq: log.length + 1, ts: 1_700_000_000_000, actor: 'fixture-builder',
  });
  emit('genesis', { v: 2, dialect: 'eidoverse-log' });
  for (const [index, name] of ['Library', 'Workshop', 'Meeting hall'].entries()) {
    const document = new Document(), buffer = document.createBuffer();
    const geometry = new BoxGeometry(1.5, 1.4 + index * 0.4, 1.5);
    geometry.translate(0, (1.4 + index * 0.4) / 2, 0);
    const positions = document.createAccessor().setType('VEC3').setArray(geometry.attributes.position.array).setBuffer(buffer);
    const normals = document.createAccessor().setType('VEC3').setArray(geometry.attributes.normal.array).setBuffer(buffer);
    const indices = document.createAccessor().setType('SCALAR').setArray(geometry.index!.array).setBuffer(buffer);
    const color = [[0.15, 0.6, 0.5, 1], [0.65, 0.35, 0.15, 1], [0.3, 0.4, 0.7, 1]][index];
    const material = document.createMaterial().setBaseColorFactor(color as [number, number, number, number]);
    const primitive = document.createPrimitive().setAttribute('POSITION', positions).setAttribute('NORMAL', normals).setIndices(indices).setMaterial(material);
    const mesh = document.createMesh().addPrimitive(primitive);
    document.createScene().addChild(document.createNode(name).setMesh(mesh));
    await new NodeIO().write(join(library, `building-${index}.glb`), document);
    geometry.dispose();
    const id = `building-${index}`;
    emit('spawn', { id, lib: `building-${index}.glb`, pos: [(index - 1) * 3, 0, -index * 2] });
    emit('comp', { id, type: 'label', data: { name, description: [
      'A community reading room with books and quiet study spaces.',
      'Tools and workbenches for building things together.',
      'A place for visitors to meet and plan their next adventure.',
    ][index], visibility: 'always' } });
  }
  writeFileSync(join(worlds, 'labels', 'log.jsonl'), log.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  server = await ownedWorld({ key: 'label-preview', env: { EIDOVERSE_DIR: library, WORLDS_DIR: worlds } });
  console.log(`Labels on: ${server.origin}/?world=labels&spectate&key=label-preview&objectLabels=all`);
  console.log(`Default off: ${server.origin}/?world=labels&spectate&key=label-preview`);
  console.log('Check click/tap and keyboard activation, move the camera, then compare default-off. Ctrl-C stops only this fixture.');
  await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
} finally {
  await server?.close();
  rmSync(scratch, { recursive: true, force: true });
}

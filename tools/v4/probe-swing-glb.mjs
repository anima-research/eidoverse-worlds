// probe-swing-glb — a tiny swing model for browser probes: a top beam and a plank, each its own named node, so a
// part motion can swing the plank (`motion:plank`). The component grammar names a part as [a-z0-9-] (shared/v4/fold.js
// COMP), and nothing in the asset library has a part named that way, so the probe brings its own. Hand-built glTF 2.0
// binary (no exporter, no DOM): two boxes with normals and one material each.
//   node 'beam'  : 1.4 × 0.08 × 0.08 m at y 2.0
//   node 'plank' : 0.6 × 0.05 × 0.35 m at y 0.5 (its origin at its own centre)

function box(sx, sy, sz) {
  const [x, y, z] = [sx / 2, sy / 2, sz / 2];
  const faces = [ // normal, then four corners (counter-clockwise seen from outside)
    [[1, 0, 0], [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]]], [[-1, 0, 0], [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]]],
    [[0, 1, 0], [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]]], [[0, -1, 0], [[-x, -y, z], [-x, -y, -z], [x, -y, -z], [x, -y, z]]],
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]], [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
  ];
  const pos = [], nrm = [], idx = [];
  faces.forEach(([n, c], f) => { for (const p of c) { pos.push(...p); nrm.push(...n); } idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3); });
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx), min: [-x, -y, -z], max: [x, y, z] };
}

export function swingGlb() {
  const parts = [['beam', box(1.4, 0.08, 0.08), [0, 2.0, 0], [0.35, 0.35, 0.4, 1]], ['plank', box(0.6, 0.05, 0.35), [0, 0.5, 0], [0.62, 0.42, 0.24, 1]]];
  const chunks = [], views = [], accessors = [], meshes = [], nodes = [], materials = [];
  let off = 0;
  const push = (arr, target) => { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); const pad = (4 - (b.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target }); chunks.push(b, Buffer.alloc(pad)); off += b.length + pad; return views.length - 1; };
  parts.forEach(([name, g, t, color], i) => {
    const vp = push(g.pos, 34962), vn = push(g.nrm, 34962), vi = push(g.idx, 34963);
    accessors.push({ bufferView: vp, componentType: 5126, count: g.pos.length / 3, type: 'VEC3', min: g.min, max: g.max },
      { bufferView: vn, componentType: 5126, count: g.nrm.length / 3, type: 'VEC3' }, { bufferView: vi, componentType: 5123, count: g.idx.length, type: 'SCALAR' });
    materials.push({ name: `${name}-mat`, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.85 } });
    meshes.push({ name, primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    nodes.push({ name, mesh: i, translation: t });
  });
  const bin = Buffer.concat(chunks);
  const json = { asset: { version: '2.0', generator: 'eidoverse probe-swing-glb' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 'JSON'), js, ch(bin.length, 'BIN\0'), bin]);
}

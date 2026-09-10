// Self-contained normalized humanoid GLB for product-path tests.
export function fixture(scale = 1, vrm0 = false) {
  const nodes: any[] = [{ name: "root", scale: [scale, scale, scale], children: [1] }];
  const bones: any = {};
  const add = (name: string, parent: string | null, p: number[]) => {
    const i = nodes.length; bones[name] = { node: i }; nodes.push({ name, translation: p, children: [] });
    if (parent) nodes[bones[parent].node].children.push(i);
  };
  add("hips", null, [0, 1, 0]); add("spine", "hips", [0, .2, 0]);
  add("chest", "spine", [0, .2, 0]); add("upperChest", "chest", [0, .1, 0]);
  add("neck", "upperChest", [0, .1, 0]); add("head", "neck", [0, .2, 0]);
  for (const [side, sign] of [["left", 1], ["right", -1]] as const) {
    add(side + "Shoulder", "upperChest", [sign * .1, 0, 0]);
    add(side + "UpperArm", side + "Shoulder", [sign * .1, 0, 0]);
    add(side + "LowerArm", side + "UpperArm", [sign * .3, 0, 0]);
    add(side + "Hand", side + "LowerArm", [sign * .3, 0, 0]);
    add(side + "MiddleProximal", side + "Hand", [sign * .08, 0, 0]);
    add(side + "UpperLeg", "hips", [sign * .1, -.1, 0]);
    add(side + "LowerLeg", side + "UpperLeg", [0, -.4, 0]);
    add(side + "Foot", side + "LowerLeg", [0, -.4, .1]);
  }
  const extensions = vrm0 ? { VRM: { humanoid: { humanBones: Object.entries(bones).map(([bone, v]: any) => ({ bone, node: v.node })) } } } : { VRMC_vrm: { humanoid: { humanBones: bones } } };
  let json = JSON.stringify({ asset: { version: "2.0" }, nodes, extensions });
  json += " ".repeat((4 - Buffer.byteLength(json) % 4) % 4);
  const b = Buffer.alloc(20 + Buffer.byteLength(json));
  b.writeUInt32LE(0x46546c67, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(b.length - 20, 12); b.writeUInt32LE(0x4e4f534a, 16); b.write(json, 20);
  return b;
}

export function postureFixture(kind: 'idle'|'sit'|'sitchair'|'lie') {
  const base = fixture(), g = JSON.parse(base.subarray(20).toString());
  const bones = g.extensions.VRMC_vrm.humanoid.humanBones;
  g.extensions = { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: bones } } };
  g.extensionsUsed = ['VRMC_vrm_animation']; g.scenes = [{ nodes: [0] }]; g.scene = 0;
  g.accessors = []; g.bufferViews = [];
  const buffers: Buffer[] = [], samplers: any[] = [], channels: any[] = [];
  let byteOffset = 0;
  const data = (values: number[], type: string, width: number) => {
    const bytes = Buffer.from(new Float32Array(values).buffer), index = g.accessors.length;
    g.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
    g.accessors.push({ componentType: 5126, type, count: values.length / width, bufferView: index });
    buffers.push(bytes); byteOffset += bytes.length; return index;
  };
  const times = data([0, 1], 'SCALAR', 1); g.accessors[times].min = [0]; g.accessors[times].max = [1];
  const track = (name: string, path: string, values: number[]) => {
    const output = data([...values, ...values], path === 'rotation' ? 'VEC4' : 'VEC3', values.length);
    channels.push({ sampler: samplers.length, target: { node: bones[name].node, path } });
    samplers.push({ input: times, output, interpolation: 'LINEAR' });
  };
  const q = (a: number) => [Math.sin(a/2), 0, 0, Math.cos(a/2)];
  track('hips', 'translation', [0, kind === 'idle' ? 1 : kind === 'sitchair' ? .7 : .45, 0]);
  track('hips', 'rotation', q(kind === 'lie' ? Math.PI/2 : 0));
  for (const side of ['left','right']) {
    track(side+'UpperLeg', 'rotation', q(kind === 'sit' || kind === 'sitchair' ? -Math.PI/2 : 0));
    track(side+'LowerLeg', 'rotation', q(kind === 'sit' || kind === 'sitchair' ? Math.PI/2 : 0));
  }
  g.animations = [{ samplers, channels }]; g.buffers = [{ byteLength: byteOffset }];
  let json = JSON.stringify(g); json += ' '.repeat((4 - Buffer.byteLength(json)%4)%4);
  const bin = Buffer.concat(buffers), out = Buffer.alloc(28 + Buffer.byteLength(json) + bin.length);
  out.writeUInt32LE(0x46546c67,0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(Buffer.byteLength(json),12); out.writeUInt32LE(0x4e4f534a,16); out.write(json,20);
  const at=20+Buffer.byteLength(json);out.writeUInt32LE(bin.length,at);out.writeUInt32LE(0x004e4942,at+4);bin.copy(out,at+8);
  return out;
}

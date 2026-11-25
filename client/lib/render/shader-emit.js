// shader-emit — a checked shader graph (shared/shaderlang.js compileShader) as the renderer's nodes. One node per graph
// node, nothing else: every type is already settled by the checker, so what is built here is valid on WebGPU and WebGL 2
// alike. Takes TSL and THREE as arguments (no import of core.js), so test/client/shader-emit-test.ts builds every
// function headlessly. The reader that puts the result on a material is ../realize/shader-draft.js.

const BIN = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual',
  '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual', '&&': 'and', '||': 'or' };
// the functions that are the renderer's own, by its name for them
const SAME = ['sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'fract',
  'radians', 'degrees', 'saturate', 'atan', 'pow', 'mod', 'min', 'max', 'step', 'clamp', 'mix', 'smoothstep', 'length', 'distance', 'normalize',
  'cross', 'reflect', 'refract', 'dFdx', 'dFdy', 'fwidth', 'luminance'];

/** The functions, each as (T, args, argTypes) → node. Exported so the tests can hold it to shaderlang's list. */
export function shaderFunctions(T) {
  const { float, vec2, vec3, vec4 } = T;
  // a noise field is read at a 2D or 3D point: a single number walks along x
  const pt = (a, t) => (t === 'float' ? vec2(a, 0) : a);
  const pt3 = (a, t) => (t === 'float' ? vec3(a, 0, 0) : t === 'vec2' ? vec3(a, 0) : a);
  const K = { float: 127.1, vec2: vec2(127.1, 311.7), vec3: vec3(127.1, 311.7, 74.7), vec4: vec4(127.1, 311.7, 74.7, 269.5) };
  const f = Object.fromEntries(SAME.map((n) => [n, (a) => T[n](...a)]));
  return { ...f,
    inversesqrt: ([a]) => T.inverseSqrt(a),
    dot: ([a, b], [t]) => (t === 'float' ? a.mul(b) : T.dot(a, b)),   // WGSL has no dot of two single numbers: it is their product
    noise: ([a], [t]) => T.mx_noise_float(pt(a, t)),
    noise3: ([a], [t]) => T.mx_noise_vec3(pt(a, t)),
    worley: ([a], [t]) => T.mx_worley_noise_float(pt(a, t)),
    fbm: ([a, octaves, lacunarity, gain], [t]) => T.mx_fractal_noise_float(pt3(a, t), octaves ?? 4, lacunarity ?? 2, gain ?? 0.5),
    hash: ([a], [t]) => T.fract(T.sin(t === 'float' ? a.mul(K.float) : T.dot(a, K[t])).mul(43758.5453)),
    // hsv(h, s, v) or hsv(vec3): hue 0…1 round the wheel
    hsv: (a) => { const [h, s, v] = a.length === 1 ? [a[0].x, a[0].y, a[0].z] : a;
      return T.mix(vec3(1), T.clamp(T.abs(T.fract(vec3(h).add(vec3(1, 2 / 3, 1 / 3))).mul(6).sub(3)).sub(1), 0, 1), s).mul(v); },
    rotate: ([p, a]) => { const c = T.cos(a), s = T.sin(a); return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))); },
    // the rim: 0 facing the eye, 1 edge-on, sharpened by the power (5 when none is given)
    fresnel: ([power]) => T.pow(float(1).sub(T.saturate(T.dot(T.normalView, T.positionViewDirection))), power ?? 5),
  };
}

/** What the program reads, each as a node. `time` is the caller's (one uniform for every shader, on the world's clock).
 *  `has(attribute)` says what the mesh's geometry carries: for an attribute it lacks the renderer would write a constant
 *  into the shader, and a graphics compiler works constants out and refuses the ones out of range (log of a missing
 *  uv's 0). So a missing uv or colour is read from a uniform holding what its absence means: never a constant. */
export function shaderInputs(T, time, has = () => true, V = null) {
  return {
    position: () => T.positionLocal, positionWorld: () => T.positionWorld, normal: () => T.normalLocal, normalWorld: () => T.normalWorld,
    normalView: () => T.normalView, viewDir: () => T.positionViewDirection, uv: () => (has('uv') ? T.uv() : T.uniform(new V.Vector2(0, 0))), time: () => time,
    instance: () => T.varying(T.float(T.instanceIndex)), vertexColor: () => (has('color') ? T.vertexColor() : T.uniform(new V.Vector4(1, 1, 1, 1))),
    baseColor: () => T.materialColor.rgb, baseEmissive: () => T.materialEmissive, baseRoughness: () => T.materialRoughness,
    baseMetalness: () => T.materialMetalness, baseOpacity: () => T.materialOpacity,
  };
}

/** Build a graph for a mesh whose geometry carries what `has` says. Returns {outputs: {<name>: node}, discard: node | null,
 *  uniforms: Map(name → {node, type})}. */
export function emitShader({ TSL: T, THREE }, graph, time, has = () => true) {
  const fns = shaderFunctions(T), inputs = shaderInputs(T, time, has, THREE);
  const uniforms = new Map();
  const blank = { float: () => 0, vec2: () => new THREE.Vector2(), vec3: () => new THREE.Vector3(), vec4: () => new THREE.Vector4() };
  const built = [];
  for (const n of graph.nodes) {
    const a = n.args.map((i) => built[i]);
    let v;
    switch (n.op) {
      case 'const': v = Array.isArray(n.value) ? T[n.type](...n.value) : T[n.type](n.value); break;
      case 'input': v = inputs[n.name](); break;
      case 'uniform': { let u = uniforms.get(n.name); if (!u) { u = { node: T.uniform(blank[n.type]()), type: n.type }; uniforms.set(n.name, u); } v = u.node; break; }
      case 'un': v = n.o === '!' ? a[0].not() : a[0].negate(); break;
      case 'bin': v = a[0][BIN[n.o]](a[1]); break;
      case 'ctor': v = T[n.type](...a); break;
      case 'swz': v = a[0][n.f]; break;
      case 'select': v = T.select(a[0], a[1], a[2]); break;
      case 'call': v = fns[n.fn](a, n.args.map((i) => graph.nodes[i].type)); break;
      default: throw new Error(`shader-emit: no such node '${n.op}'`);
    }
    built.push(v);
  }
  const outputs = {}; for (const [name, i] of Object.entries(graph.outputs)) outputs[name] = built[i];
  return { outputs, discard: graph.discard === null ? null : built[graph.discard], uniforms };
}

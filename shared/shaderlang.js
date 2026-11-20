// shaderlang — the shader code a thing may carry (the DRAFT component `antra/shader`, docs/guide/SHADERS.md), read into a
// typed expression graph. No THREE and no DOM: the Inspector, an agent's tools and the tests check a shader with this
// module, and client/lib/realize/shader-draft.js turns the graph into the renderer's node materials.
//
// The code is GLSL-flavoured (float, vec3, swizzles, functions, if, for), but it is DATA, never run: this module is the
// only thing that reads it, and what it produces is a list of pure expression nodes. So a world's shader can't run
// code in a visitor's page, and the same graph builds on WebGPU and WebGL 2.
//   - a variable is a name for a node (an assignment rebinds it);
//   - `if` evaluates both sides and selects (a compile-time condition picks one);
//   - `for` is unrolled (its bounds must be constants); `break`, `continue` and an early `return` guard what follows;
//   - a function is inlined at each call (no recursion).
// compileShader(source) → {ok: true, nodes, outputs, discard, uniforms} | {ok: false, error: {line, col, message}}.

// Constant work is done here, not on the graphics card: a call whose arguments are all written out becomes one number,
// and one a graphics compiler would refuse (sqrt of a negative, a division by zero, smoothstep with its edges crossed)
// is refused here first, in words. WGSL rejects such a shader whole, and the thing would stop being drawn.
export const SHADER_LIMITS = Object.freeze({ source: 20000, nodes: 4096, iterations: 256, depth: 32, number: 1e30, int: 2147483647 });

const DIM = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 };
const VEC = [null, 'float', 'vec2', 'vec3', 'vec4'];
const isType = (t) => Object.hasOwn(DIM, t);
const isVec = (t) => t === 'vec2' || t === 'vec3' || t === 'vec4';
const isNum = (t) => t === 'float' || t === 'int';
const isGen = (t) => t === 'float' || isVec(t);

/** What a program may assign: its name, its type, and the input it starts as (so `position += …` and `color *= …` read
 *  the thing's own value first). An output nothing assigns is left to the material. */
export const SHADER_OUTPUTS = Object.freeze({
  color: { type: 'vec3', from: 'baseColor', help: 'its base colour (linear RGB)' },
  emissive: { type: 'vec3', from: 'baseEmissive', help: 'the light it gives off, lit or not' },
  roughness: { type: 'float', from: 'baseRoughness', help: '0 mirror-smooth … 1 matte' },
  metalness: { type: 'float', from: 'baseMetalness', help: '0 plastic, wood, paint … 1 bare metal' },
  opacity: { type: 'float', from: 'baseOpacity', help: '1 solid … 0 invisible (assigning it makes the material see-through)' },
  position: { type: 'vec3', from: 'position', help: 'the vertex, in the thing\'s own frame (metres): assign it to move the surface' },
  normal: { type: 'vec3', from: 'normal', help: 'the shading normal, in the thing\'s own frame' },
});
/** What a program may read. `frag`: known per pixel only, so `position` can't depend on it. */
export const SHADER_INPUTS = Object.freeze({
  position: { type: 'vec3', help: 'the point on the surface, in the thing\'s own frame (metres)' },
  positionWorld: { type: 'vec3', help: 'the point on the surface, in world metres' },
  normal: { type: 'vec3', help: 'the surface normal, in the thing\'s own frame' },
  normalWorld: { type: 'vec3', help: 'the surface normal, in the world\'s frame' },
  normalView: { type: 'vec3', help: 'the surface normal, in the eye\'s frame' },
  viewDir: { type: 'vec3', help: 'the unit vector from the surface to the eye, in the eye\'s frame (dot it with normalView)' },
  uv: { type: 'vec2', help: 'the model\'s texture coordinate' },
  time: { type: 'float', help: 'seconds on the world\'s clock, the same for every viewer; it wraps to 0 every hour' },
  instance: { type: 'float', help: 'which copy this is, 0, 1, 2… (0 for a thing drawn once)' },
  vertexColor: { type: 'vec4', help: 'the model\'s vertex colour (white where it has none)' },
  baseColor: { type: 'vec3', frag: true, help: 'the material\'s own colour, its texture included' },
  baseEmissive: { type: 'vec3', frag: true, help: 'the material\'s own glow' },
  baseRoughness: { type: 'float', frag: true, help: 'the material\'s own roughness' },
  baseMetalness: { type: 'float', frag: true, help: 'the material\'s own metalness' },
  baseOpacity: { type: 'float', frag: true, help: 'the material\'s own opacity' },
});

// ---- the built-in functions: name → what it returns for these argument types (null: no such overload) -----------------
// A resolver answers {ret, args: [the type each argument is converted to], frag?}. An int counts as a float; a float
// beside a vector is spread across it (so every argument an emitter sees already has its final type).
const gen1 = ([a]) => (isGen(a) ? { ret: a, args: [a] } : null);
const vec1 = ([a]) => (isVec(a) ? { ret: a, args: [a] } : null);
const wide = (ts) => { const v = ts.find(isVec); return ts.every((t) => t === 'float' || t === v) ? (v ?? 'float') : null; };
const genN = (n) => (ts) => { if (ts.length !== n || !ts.every(isGen)) return null; const t = wide(ts); return t ? { ret: t, args: ts.map(() => t) } : null; };
const toFloat = (n) => (ts) => { if (ts.length !== n || !ts.every(isGen)) return null; const t = wide(ts); return t ? { ret: 'float', args: ts.map(() => t) } : null; };
const fragOnly = (f) => (ts) => { const r = f(ts); return r ? { ...r, frag: true } : null; };
const point = (to) => ([a]) => (a === 'float' || a === 'vec2' || a === 'vec3' ? { ret: to, args: [a] } : null);
const one = (f) => (ts) => (ts.length === 1 ? f(ts) : null);

export const SHADER_FUNCTIONS = Object.freeze({
  ...Object.fromEntries(['sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor',
    'ceil', 'round', 'trunc', 'fract', 'radians', 'degrees', 'saturate'].map((n) => [n, one(gen1)])),
  atan: (ts) => (ts.length === 1 ? gen1(ts) : genN(2)(ts)),
  pow: genN(2), mod: genN(2), min: genN(2), max: genN(2), step: genN(2),
  clamp: genN(3), mix: genN(3), smoothstep: genN(3),
  length: toFloat(1), distance: toFloat(2), dot: toFloat(2),
  normalize: one(vec1),
  cross: (ts) => (ts.length === 2 && ts[0] === 'vec3' && ts[1] === 'vec3' ? { ret: 'vec3', args: ts } : null),
  reflect: (ts) => (ts.length === 2 && isVec(ts[0]) && ts[1] === ts[0] ? { ret: ts[0], args: ts } : null),
  refract: (ts) => (ts.length === 3 && isVec(ts[0]) && ts[1] === ts[0] && ts[2] === 'float' ? { ret: ts[0], args: ts } : null),
  dFdx: fragOnly(one(gen1)), dFdy: fragOnly(one(gen1)), fwidth: fragOnly(one(gen1)),
  // noise: smooth, about -1…1; fbm: several octaves of it (octaves 1–8, a constant); worley: the distance to the nearest
  // cell point, 0…~1; hash: a repeatable 0…1 number with no smoothness at all
  noise: one(point('float')), noise3: one(point('vec3')), worley: one(point('float')),
  fbm: (ts) => (ts.length >= 1 && ts.length <= 4 && point('float')([ts[0]]) && ts.slice(1).every((t) => t === 'float')
    ? { ret: 'float', args: ts, constArgs: [1] } : null),
  hash: (ts) => (ts.length === 1 && isGen(ts[0]) ? { ret: 'float', args: ts } : null),
  luminance: (ts) => (ts.length === 1 && ts[0] === 'vec3' ? { ret: 'float', args: ts } : null),
  hsv: (ts) => (ts.length === 1 && ts[0] === 'vec3' ? { ret: 'vec3', args: ts } : genN(3)(ts)?.ret === 'float' ? { ret: 'vec3', args: ts } : null),
  rotate: (ts) => (ts.length === 2 && ts[0] === 'vec2' && ts[1] === 'float' ? { ret: 'vec2', args: ts } : null),
  fresnel: (ts) => (ts.length === 0 ? { ret: 'float', args: [] } : ts.length === 1 && ts[0] === 'float' ? { ret: 'float', args: ts } : null),
});

// ---- constants: the arithmetic of a call whose arguments are all written out (lists of parts; a float is one part) ----
class Domain extends Error {}
const dom = (ok, why) => { if (!ok) throw new Domain(why); };
const each = (f) => (as) => { const n = Math.max(...as.map((a) => a.length)); return Array.from({ length: n }, (_, k) => f(...as.map((a) => (a.length === 1 ? a[0] : a[k])))); };
const dotOf = (a, b) => a.reduce((t, x, i) => t + x * b[i], 0);
const evenRound = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
const FOLD = {
  sin: each(Math.sin), cos: each(Math.cos), tan: each(Math.tan),
  asin: each((x) => (dom(Math.abs(x) <= 1, 'asin takes a number from -1 to 1'), Math.asin(x))), acos: each((x) => (dom(Math.abs(x) <= 1, 'acos takes a number from -1 to 1'), Math.acos(x))),
  atan: (as) => (as.length === 1 ? each(Math.atan)(as) : each(Math.atan2)(as)),
  exp: each(Math.exp), exp2: each((x) => 2 ** x),
  log: each((x) => (dom(x > 0, 'log takes a number above 0'), Math.log(x))), log2: each((x) => (dom(x > 0, 'log2 takes a number above 0'), Math.log2(x))),
  sqrt: each((x) => (dom(x >= 0, 'sqrt takes a number that isn\'t negative'), Math.sqrt(x))), inversesqrt: each((x) => (dom(x > 0, 'inversesqrt takes a number above 0'), 1 / Math.sqrt(x))),
  abs: each(Math.abs), sign: each(Math.sign), floor: each(Math.floor), ceil: each(Math.ceil), round: each(evenRound), trunc: each(Math.trunc), fract: each((x) => x - Math.floor(x)),
  radians: each((x) => x * Math.PI / 180), degrees: each((x) => x * 180 / Math.PI), saturate: each((x) => Math.min(1, Math.max(0, x))),
  pow: each((x, y) => (dom(x > 0 || (x === 0 && y > 0), 'pow of a negative number isn\'t defined in a shader (use abs(x), or x * x)'), x ** y)),
  mod: each((x, y) => (dom(y !== 0, 'a division by zero'), x - y * Math.floor(x / y))),
  min: each(Math.min), max: each(Math.max), step: each((e, x) => (x < e ? 0 : 1)),
  clamp: each((x, lo, hi) => Math.min(hi, Math.max(lo, x))), mix: each((a, b, t) => a + (b - a) * t),
  smoothstep: each((lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); }),
  length: ([a]) => [Math.hypot(...a)], distance: ([a, b]) => [Math.hypot(...a.map((x, i) => x - b[i]))], dot: ([a, b]) => [dotOf(a, b)],
  normalize: ([a]) => { const l = Math.hypot(...a); dom(l > 0, 'normalize of a vector of zeros'); return a.map((x) => x / l); },
  cross: ([a, b]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  reflect: ([v, n]) => { const d = 2 * dotOf(n, v); return v.map((x, i) => x - d * n[i]); },
  refract: ([v, n, [eta]]) => { const d = dotOf(n, v), k = 1 - eta * eta * (1 - d * d); return k < 0 ? v.map(() => 0) : v.map((x, i) => eta * x - (eta * d + Math.sqrt(k)) * n[i]); },
};
// …and what a graphics compiler refuses even when only SOME arguments are written out: [which arguments, the rule, the words]
const EDGES = {
  smoothstep: [[0, 1], (lo, hi) => lo < hi, 'smoothstep\'s first edge must be below its second (these are written out as equal or crossed)'],
  clamp: [[1, 2], (lo, hi) => lo <= hi, 'clamp\'s low is above its high'],
  mod: [[1, 1], (y) => y !== 0, 'a division by zero'],
};

class ShaderError extends Error { constructor(message, at) { super(message); this.line = at?.line ?? 1; this.col = at?.col ?? 1; } }
const fail = (message, at) => { throw new ShaderError(message, at); };

// ---- the words ---------------------------------------------------------------------------------------------------------
const TWO = new Set(['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '++', '--']);
function lex(src) {
  const toks = []; let i = 0, line = 1, col = 1;
  const at = () => ({ line, col });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; col = 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; col++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2); if (end < 0) fail('this comment never ends (no */)', at());
      for (; i < end + 2; i++) { if (src[i] === '\n') { line++; col = 1; } else col++; }
      continue;
    }
    const rest = src.slice(i, i + 64);
    let m = /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?f?/.exec(rest);
    if (m) {
      const text = m[0].replace(/f$/, ''); const float = /[.eE]/.test(text) || m[0].endsWith('f');
      toks.push({ t: 'num', v: Number(text), float, ...at() }); i += m[0].length; col += m[0].length; continue;
    }
    m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (m) { toks.push({ t: 'id', v: m[0], ...at() }); i += m[0].length; col += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (TWO.has(two)) { toks.push({ t: two, ...at() }); i += 2; col += 2; continue; }
    if ('+-*/%=<>!?:,;(){}.'.includes(c)) { toks.push({ t: c, ...at() }); i++; col++; continue; }
    fail(`'${c}' isn't part of this language`, at());
  }
  toks.push({ t: 'end', line, col });
  return toks;
}

// ---- the grammar ---------------------------------------------------------------------------------------------------------
function parse(toks) {
  let p = 0;
  const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)];
  const is = (t, v) => { const x = peek(); return x.t === t && (v === undefined || x.v === v); };
  const eat = (t, v) => (is(t, v) ? toks[p++] : null);
  const need = (t, what) => eat(t) ?? fail(`${what ?? `'${t}'`} is missing here${peek().t === 'end' ? ' (the code ends)' : ''}`, peek());
  const name = (what) => { const x = peek(); if (x.t !== 'id' || isType(x.v)) fail(`${what} is missing here`, x); p++; return x; };
  const typeHere = () => is('id') && isType(peek().v);

  const primary = () => {
    const x = peek();
    if (x.t === 'num') { p++; return { k: 'num', v: x.v, float: x.float, at: x }; }
    if (x.t === '(') { p++; const e = expr(); need(')'); return e; }
    if (x.t === 'id') {
      p++;
      if (x.v === 'true' || x.v === 'false') return { k: 'bool', v: x.v === 'true', at: x };
      if (is('(')) { p++; const args = []; if (!is(')')) do args.push(expr()); while (eat(','));
        need(')'); return { k: 'call', name: x.v, args, at: x }; }
      if (isType(x.v)) fail(`'${x.v}' is a type: write ${x.v}(…) to make one`, x);
      return { k: 'var', name: x.v, at: x };
    }
    fail(x.t === 'end' ? 'the code ends in the middle of an expression' : `an expression can't start with '${x.t}'`, x);
  };
  const postfix = () => { let e = primary(); while (is('.')) { const d = toks[p++]; const f = name('a swizzle (.xyz, .rgb…)'); e = { k: 'swz', of: e, f: f.v, at: d }; } return e; };
  const unary = () => { const x = peek(); if (x.t === '-' || x.t === '!' || x.t === '+') { p++; const e = unary(); return x.t === '+' ? e : { k: 'un', op: x.t, e, at: x }; } return postfix(); };
  const left = (next, ops) => () => { let e = next(); for (;;) { const x = peek(); if (!ops.includes(x.t)) return e; p++; e = { k: 'bin', op: x.t, a: e, b: next(), at: x }; } };
  const mul = left(unary, ['*', '/', '%']), add = left(mul, ['+', '-']), rel = left(add, ['<', '>', '<=', '>=']),
    eq = left(rel, ['==', '!=']), and = left(eq, ['&&']), or = left(and, ['||']);
  function expr() { const c = or(); const q = eat('?'); if (!q) return c; const a = expr(); need(':', "the ':' of this ?:"); return { k: 'sel', c, a, b: expr(), at: q }; }

  const block = () => { need('{'); const body = []; while (!is('}')) { if (is('end')) fail("a '{' is never closed", peek()); body.push(statement()); } p++; return body; };
  const body = () => (is('{') ? block() : [statement()]);
  // `x = e`, `x.yz *= e`, `x++`: the only statements that do anything
  const assign = (semi = true) => {
    const n = name('a statement'); let f = null; if (eat('.')) f = name('a swizzle (.xyz, .rgb…)').v;
    const x = peek(); let op, value;
    if (x.t === '++' || x.t === '--') { p++; op = x.t[0]; value = { k: 'num', v: 1, float: false, at: x }; }
    else if (['=', '+=', '-=', '*=', '/='].includes(x.t)) { p++; op = x.t === '=' ? null : x.t[0]; value = expr(); }
    else fail(is('(') ? `calling ${n.v}(…) on its own does nothing: assign its result` : `'${n.v}' alone does nothing: assign to it (${n.v} = …)`, n);
    if (semi) need(';');
    return { k: 'set', name: n.v, f, op, value, at: n };
  };
  function declare(isConst, at) {
    const type = toks[p++].v; const out = [];
    do { const n = name('a name'); out.push({ k: 'let', type, name: n.v, isConst, init: eat('=') ? expr() : null, at: n }); } while (eat(','));
    need(';');
    return out.length === 1 ? out[0] : { k: 'many', list: out, at };
  }
  function statement() {
    const x = peek();
    if (x.t === '{') return { k: 'block', body: block(), at: x };
    if (x.t === ';') { p++; return { k: 'block', body: [], at: x }; }
    if (x.t !== 'id') fail(`a statement can't start with '${x.t}'`, x);
    if (x.v === 'if') { p++; need('('); const c = expr(); need(')'); const then = body(); const other = eat('id', 'else') ? body() : []; return { k: 'if', c, then, other, at: x }; }
    if (x.v === 'for') {
      p++; need('(');
      if (!(typeHere() && peek().v === 'int')) fail('a for loop counts with an int: for (int i = 0; i < 8; i++)', peek());
      p++; const v = name('the loop\'s counter'); need('='); const from = expr(); need(';');
      const cond = expr(); need(';'); const step = assign(false); need(')');
      return { k: 'for', name: v.v, from, cond, step, body: body(), at: x };
    }
    if (x.v === 'return') { p++; const e = expr(); need(';'); return { k: 'return', e, at: x }; }
    if (x.v === 'discard' || x.v === 'break' || x.v === 'continue') { p++; need(';'); return { k: x.v, at: x }; }
    if (x.v === 'while' || x.v === 'do' || x.v === 'switch') fail(`there is no '${x.v}' here: a for loop with constant bounds is the only loop`, x);
    if (x.v === 'const') { p++; if (!typeHere()) fail('a type is missing after const', peek()); return declare(true, x); }
    if (isType(x.v)) return declare(false, x);
    return assign();
  }
  const prog = { uniforms: [], funcs: [], body: [] };
  while (!is('end')) {
    const x = peek();
    if (x.t === 'id' && x.v === 'uniform') {
      p++; if (!typeHere()) fail('a type is missing after uniform', peek());
      const type = toks[p++].v; if (!isGen(type)) fail(`a uniform is a float, vec2, vec3 or vec4 (not ${type})`, x);
      do { const n = name('the uniform\'s name'); prog.uniforms.push({ name: n.v, type, at: n }); } while (eat(','));
      need(';'); continue;
    }
    // type name ( … ) { … }  is a function; anything else is a statement
    if (typeHere() && peek(1).t === 'id' && !isType(peek(1).v) && peek(2).t === '(') {
      const ret = toks[p++].v; const n = toks[p++]; p++; const params = [];
      if (!is(')')) do { if (!typeHere()) fail('a parameter needs a type: float x', peek()); const type = toks[p++].v; params.push({ type, name: name('the parameter\'s name').v }); } while (eat(','));
      need(')'); prog.funcs.push({ name: n.v, ret, params, body: block(), at: n }); continue;
    }
    if (x.t === 'id' && x.v === 'void') fail('a function here returns a value (float f(…) { return …; }); there is no void', x);
    prog.body.push(statement());
  }
  return prog;
}

// ---- the graph -----------------------------------------------------------------------------------------------------------
const SWZ = ['xyzw', 'rgba', 'stpq'];
const ZERO = { float: 0, int: 0, bool: false };
const STOPS = ['$returned', '$break', '$continue'];

function lower(prog) {
  const nodes = []; const seen = new Map();
  const N = (id) => nodes[id];
  const mk = (op, type, args = [], extra = {}) => {
    const key = `${op}|${type}|${args.join(',')}|${JSON.stringify(extra)}`;
    const had = seen.get(key); if (had !== undefined) return had;
    if (nodes.length >= SHADER_LIMITS.nodes) fail(`this shader is too big: more than ${SHADER_LIMITS.nodes} operations once its loops are unrolled and its functions inlined (shorten a loop, or do less in it)`, here);
    const frag = !!extra.frag || args.some((a) => nodes[a].frag);
    nodes.push({ op, type, args, ...extra, ...(frag ? { frag: true } : {}) }); seen.set(key, nodes.length - 1);
    return nodes.length - 1;
  };
  let here = { line: 1, col: 1 };   // where a "too big" is reported: the statement being read
  const fits = (v, at) => { if (!(Math.abs(v) <= SHADER_LIMITS.number)) fail(Number.isNaN(v) ? 'this works out to something that isn\'t a number' : `a number here is beyond ±${SHADER_LIMITS.number}: too large for a shader`, at ?? here); return v === 0 ? 0 : v; };
  const lit = (type, value, at) => {
    if (type === 'bool') return mk('const', type, [], { value: !!value });
    if (type === 'int') { const v = Math.trunc(value); if (!(Math.abs(v) <= SHADER_LIMITS.int)) fail(`a whole number here is beyond ±${SHADER_LIMITS.int}`, at ?? here); return mk('const', type, [], { value: v === 0 ? 0 : v }); }
    if (type === 'float') return mk('const', type, [], { value: fits(Number(value), at) });
    return mk('const', type, [], { value: value.map((x) => fits(Number(x), at)) });
  };
  /** A constant's parts, as a list (a float is one part). */
  const parts = (id) => { const v = N(id).value; return Array.isArray(v) ? v : [Number(v)]; };
  const fromParts = (type, list, at) => lit(type, isVec(type) ? list : list[0], at);
  /** Parts of a vector by letter: a constant's are read here; anything else is a swizzle node. */
  const pick = (id, f) => { const type = VEC[f.length];
    if (N(id).op === 'const') return fromParts(type, [...f].map((ch) => parts(id)['xyzw'.indexOf(ch)]));
    return mk('swz', type, [id], { f }); };
  /** A vector from its arguments (already numbers and vectors of floats): written-out ones become one constant. */
  const vector = (type, args, at) => {
    if (args.every((a) => N(a).op === 'const')) { const flat = args.flatMap(parts); return lit(type, flat.length === 1 ? Array(DIM[type]).fill(flat[0]) : flat, at); }
    return mk('ctor', type, args);
  };
  const isConst = (id) => N(id).op === 'const';
  const val = (id) => N(id).value;
  const typeOf = (id) => N(id).type;

  /** id, as `to`: an int becomes a float, a float beside a vector is spread across it; anything else is refused. */
  const as = (id, to, at, what) => {
    const t = typeOf(id);
    if (t === to) return id;
    if (t === 'int' && to === 'float') return isConst(id) ? lit('float', val(id)) : mk('ctor', 'float', [id]);
    if (isNum(t) && isVec(to)) return vector(to, [as(id, 'float', at, what)], at);
    fail(`${what} is ${to === 'int' ? 'an' : 'a'} ${to}, and this is ${t === 'int' ? 'an' : 'a'} ${t}${isVec(to) && isVec(t) ? '' : isVec(to) ? `: write ${to}(…)` : ''}`, at);
  };
  const num = (id) => (typeOf(id) === 'int' ? as(id, 'float') : id);
  const fold = (op, a, b) => {
    const x = val(a), y = val(b), int = typeOf(a) === 'int';
    switch (op) {
      case '+': return x + y; case '-': return x - y; case '*': return x * y;
      case '/': return int ? Math.trunc(x / y) : x / y;
      case '%': return int ? x % y : x - y * Math.floor(x / y);
      case '<': return x < y; case '>': return x > y; case '<=': return x <= y; case '>=': return x >= y;
      case '==': return x === y; case '!=': return x !== y;
      default: return null;
    }
  };
  const binary = (op, a, b, at) => {
    let ta = typeOf(a), tb = typeOf(b);
    if (op === '&&' || op === '||') {
      if (ta !== 'bool' || tb !== 'bool') fail(`${op} joins two conditions (true or false), not a ${ta !== 'bool' ? ta : tb}`, at);
      if (isConst(a)) return (op === '&&') === val(a) ? b : a;
      if (isConst(b)) return (op === '&&') === val(b) ? a : b;
      return mk('bin', 'bool', [a, b], { o: op });
    }
    if (ta === 'bool' || tb === 'bool') {
      if ((op === '==' || op === '!=') && ta === tb) return isConst(a) && isConst(b) ? lit('bool', fold(op, a, b)) : mk('bin', 'bool', [a, b], { o: op });
      fail(`${op} works on numbers, not on a condition (true or false)`, at);
    }
    const cmp = ['<', '>', '<=', '>=', '==', '!='].includes(op);
    if (cmp) {
      if (isVec(ta) || isVec(tb)) fail(`${op} compares single numbers: compare one component (a.x ${op} b.x), or a length`, at);
      if (ta !== tb) { a = num(a); b = num(b); }
      if (isConst(a) && isConst(b)) return lit('bool', fold(op, a, b));
      return mk('bin', 'bool', [a, b], { o: op });
    }
    const byZero = (op === '/' || op === '%') && isConst(b) && parts(b).some((y) => y === 0);
    if (byZero) fail('a division by zero', at);
    if (ta === 'int' && tb === 'int') {
      if (isConst(a) && isConst(b)) return lit('int', fold(op, a, b), at);
      return mk('bin', 'int', [a, b], { o: op });
    }
    a = num(a); b = num(b); ta = typeOf(a); tb = typeOf(b);
    if (isVec(ta) && isVec(tb) && ta !== tb) fail(`${op} can't join a ${ta} and a ${tb}: they have different sizes`, at);
    const type = isVec(ta) ? ta : tb;
    if (isConst(a) && isConst(b)) { const f = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x - y * Math.floor(x / y) }[op];
      return fromParts(type, each(f)([parts(a), parts(b)]), at); }
    return mk('bin', type, [as(a, type), as(b, type)], { o: op });
  };
  const select = (c, a, b) => {
    if (a === b) return a;
    if (isConst(c)) return val(c) ? a : b;
    if (typeOf(a) === 'bool' && isConst(a) && isConst(b)) return val(a) ? c : mk('un', 'bool', [c], { o: '!' });   // c ? true : false is c
    return mk('select', typeOf(a), [c, a, b]);
  };
  const any = (flags) => flags.reduce((acc, f) => (acc === null ? f : binary('||', acc, f)), null);
  const zero = (type) => (isVec(type) ? lit(type, Array(DIM[type]).fill(0)) : lit(type, ZERO[type]));

  const uniforms = []; const funcs = new Map(); const globals = new Map();   // globals: uniforms and top-level consts
  for (const u of prog.uniforms) {
    if (globals.has(u.name) || reserved(u.name)) fail(`'${u.name}' is already taken`, u.at);
    uniforms.push({ name: u.name, type: u.type }); globals.set(u.name, { type: u.type, node: mk('uniform', u.type, [], { name: u.name }), fixed: true });
  }
  for (const f of prog.funcs) {
    if (funcs.has(f.name) || Object.hasOwn(SHADER_FUNCTIONS, f.name) || isType(f.name) || reserved(f.name) || globals.has(f.name)) fail(`'${f.name}' is already taken`, f.at);
    funcs.set(f.name, f);
  }
  function reserved(n) { return Object.hasOwn(SHADER_INPUTS, n) || Object.hasOwn(SHADER_OUTPUTS, n) || n.startsWith('$') || ['true', 'false', 'if', 'else', 'for', 'return', 'discard', 'break', 'continue', 'const', 'uniform'].includes(n); }

  const calling = [];
  function construct(type, args, at) {
    const n = DIM[type];
    if (!isVec(type)) {
      if (args.length !== 1) fail(`${type}(…) takes one value`, at);
      const a = args[0], t = typeOf(a);
      if (isVec(t)) fail(`${type}(…) takes one number, and this is a ${t}: pick a component (.x)`, at);
      if (t === type) return a;
      if (isConst(a)) return lit(type, type === 'bool' ? val(a) !== 0 : Number(val(a)), at);
      return mk('ctor', type, [a]);
    }
    for (const a of args) if (typeOf(a) === 'bool') fail(`${type}(…) is made of numbers, not a condition`, at);
    if (args.length === 1) {
      const t = typeOf(args[0]);
      if (!isVec(t)) return vector(type, [num(args[0])], at);
      if (DIM[t] === n) return args[0];
      if (DIM[t] > n) return pick(args[0], 'xyzw'.slice(0, n));
    }
    const total = args.reduce((s, a) => s + DIM[typeOf(a)], 0);
    if (total !== n) fail(`${type}(…) needs ${n} numbers in all (or one, repeated); these make ${total}`, at);
    return vector(type, args.map(num), at);
  }
  function call(e, env, depth) {
    if (!isType(e.name) && !funcs.has(e.name) && !Object.hasOwn(SHADER_FUNCTIONS, e.name))
      fail(`there is no function '${e.name}'${/^(texture|sampler|gl_|mat\d)/.test(e.name) ? " (no textures or matrices here: baseColor is the material's own texture)" : ''}`, e.at);
    const args = e.args.map((a) => rvalue(a, env, depth));
    if (isType(e.name)) return construct(e.name, args, e.at);
    const f = funcs.get(e.name);
    if (f) {
      if (calling.includes(e.name)) fail(`${e.name} calls itself: functions are inlined, so there is no recursion (use a for loop)`, e.at);
      if (depth >= SHADER_LIMITS.depth) fail(`functions nest more than ${SHADER_LIMITS.depth} deep`, e.at);
      if (args.length !== f.params.length) fail(`${e.name} takes ${f.params.length} argument${f.params.length === 1 ? '' : 's'}, not ${args.length}`, e.at);
      // a function sees the inputs, the uniforms and the top-level consts, then its own parameters (which may shadow them)
      const inner = new Map(globals); for (const [n, b] of inputsEnv()) inner.set(n, b);
      for (const q of f.params) if (!isType(q.type)) fail(`${e.name}'s parameter ${q.name} needs a type`, f.at);
      f.params.forEach((q, i) => inner.set(q.name, { type: q.type, node: as(args[i], q.type, e.args[i].at, `${e.name}'s ${q.name}`) }));
      inner.set('$ret', { type: f.ret, node: zero(f.ret) }); inner.set('$returned', { type: 'bool', node: lit('bool', false) });
      calling.push(e.name);
      try { list(f.body, inner, new Set(inner.keys()), depth + 1, { fn: f, loop: false }); } finally { calling.pop(); }
      const done = inner.get('$returned').node;
      if (isConst(done) && !val(done)) fail(`${e.name} never returns a value (add: return …;)`, f.at);
      return inner.get('$ret').node;
    }
    const resolve = SHADER_FUNCTIONS[e.name];
    for (const a of args) if (typeOf(a) === 'bool') fail(`${e.name}(…) takes numbers, not a condition`, e.at);
    const types = args.map((a) => (typeOf(a) === 'int' ? 'float' : typeOf(a)));
    const r = resolve(types);
    if (!r) fail(`${e.name}(${args.map(typeOf).join(', ')}) doesn't exist: check how many values it takes, and their sizes`, e.at);
    const conv = args.map((a, i) => as(a, r.args[i], e.args[i].at, `${e.name}'s argument ${i + 1}`));
    for (const i of r.constArgs ?? []) if (conv[i] !== undefined) {
      if (!isConst(conv[i])) fail(`${e.name}'s argument ${i + 1} must be a constant (a number written out)`, e.args[i].at);
      const v = val(conv[i]); if (!(Number.isInteger(v) && v >= 1 && v <= 8)) fail(`${e.name}'s argument ${i + 1} is a whole number from 1 to 8`, e.args[i].at);
    }
    const edge = EDGES[e.name];
    if (edge && edge[0].every((i) => isConst(conv[i]))) { const [i, j] = edge[0];
      if (!each(edge[1])(i === j ? [parts(conv[i])] : [parts(conv[i]), parts(conv[j])]).every(Boolean)) fail(edge[2], e.at); }
    if (FOLD[e.name] && conv.every(isConst)) {
      try { return fromParts(r.ret, FOLD[e.name](conv.map(parts)), e.at); } catch (x) { if (x instanceof Domain) fail(x.message, e.at); throw x; }
    }
    return mk('call', r.ret, conv, { fn: e.name, ...(r.frag ? { frag: true } : {}) });
  }
  function swizzle(id, f, at) {
    const t = typeOf(id); if (!isVec(t)) fail(`.${f} picks parts of a vector, and this is a ${t}`, at);
    const set = SWZ.find((s) => [...f].every((ch) => s.includes(ch)));
    if (!set || f.length < 1 || f.length > 4) fail(`.${f} isn't a swizzle (use letters from xyzw, or from rgba)`, at);
    const idx = [...f].map((ch) => set.indexOf(ch));
    if (idx.some((i) => i >= DIM[t])) fail(`a ${t} has no .${f[idx.findIndex((i) => i >= DIM[t])]}`, at);
    return { idx, node: pick(id, idx.map((i) => 'xyzw'[i]).join('')) };
  }
  function rvalue(e, env, depth) {
    switch (e.k) {
      case 'num': return lit(e.float ? 'float' : 'int', e.v);
      case 'bool': return lit('bool', e.v);
      case 'var': { const b = env.get(e.name); if (!b) fail(`there is no '${e.name}' here${Object.hasOwn(SHADER_FUNCTIONS, e.name) || funcs.has(e.name) ? ` (it is a function: ${e.name}(…))` : ''}`, e.at); return b.node; }
      case 'call': return call(e, env, depth);
      case 'swz': return swizzle(rvalue(e.of, env, depth), e.f, e.at).node;
      case 'un': { const a = rvalue(e.e, env, depth), t = typeOf(a);
        if (e.op === '!') { if (t !== 'bool') fail(`! flips a condition (true or false), not a ${t}`, e.at); return isConst(a) ? lit('bool', !val(a)) : mk('un', 'bool', [a], { o: '!' }); }
        if (t === 'bool') fail(`- works on numbers, not on a condition`, e.at);
        return isConst(a) ? fromParts(t, parts(a).map((x) => -x), e.at) : mk('un', t, [a], { o: '-' }); }
      case 'bin': return binary(e.op, rvalue(e.a, env, depth), rvalue(e.b, env, depth), e.at);
      case 'sel': { const c = rvalue(e.c, env, depth); if (typeOf(c) !== 'bool') fail(`what comes before ? is a condition (true or false), not a ${typeOf(c)}`, e.at);
        let a = rvalue(e.a, env, depth), b = rvalue(e.b, env, depth);
        if (typeOf(a) !== typeOf(b)) { if (isNum(typeOf(a)) && isNum(typeOf(b))) { a = num(a); b = num(b); } else fail(`the two sides of ?: are a ${typeOf(a)} and a ${typeOf(b)}: they must be the same`, e.at); }
        return select(c, a, b); }
      default: fail('this can\'t be read as a value', e.at);
    }
  }

  // what a run of statements may do besides assigning: which pass it is (`frozen`: outputs this pass doesn't own are
  // read-only inputs), and whether it sits in a function or a loop
  let frozen = new Set();
  function assignTo(s, env, depth) {
    const b = env.get(s.name);
    if (!b) fail(`there is no '${s.name}' to assign to: declare it first (float ${s.name} = …;)`, s.at);
    if (b.fixed) fail(`'${s.name}' can't be changed${Object.hasOwn(SHADER_INPUTS, s.name) ? ' (it is an input: copy it into a variable of your own)' : ''}`, s.at);
    let v = rvalue(s.value, env, depth);
    if (s.f) {
      const sw = swizzle(b.node, s.f, s.at);
      if (new Set(sw.idx).size !== sw.idx.length) fail(`.${s.f} names a part twice: it can't be assigned`, s.at);
      const part = VEC[s.f.length];
      if (s.op) v = binary(s.op, sw.node, v, s.at);
      v = as(v, part, s.at, `${s.name}.${s.f}`);
      const comps = []; for (let i = 0; i < DIM[b.type]; i++) { const k = sw.idx.indexOf(i);
        comps.push(k < 0 ? pick(b.node, 'xyzw'[i]) : part === 'float' ? v : pick(v, 'xyzw'[k])); }
      v = vector(b.type, comps, s.at);
    } else {
      if (s.op) v = binary(s.op, b.node, v, s.at);
      v = as(v, b.type, s.at, `'${s.name}'`);
    }
    if (b.out && frozen.has(s.name)) return;   // the other pass's output: checked, and left as it is here
    if (b.out === 'position' && N(v).frag) fail(`position is worked out at each vertex, so it can't use what is only known per pixel (baseColor and the other base… values, dFdx, dFdy, fwidth)`, s.at);
    env.set(s.name, { ...b, node: v, set: true });
  }
  function exec(s, env, declared, depth, where) {
    here = s.at ?? here;
    switch (s.k) {
      case 'block': scoped(s.body, env, depth, where); return;
      case 'many': for (const d of s.list) exec(d, env, declared, depth, where); return;
      case 'let': {
        if (reserved(s.name) || isType(s.name) || funcs.has(s.name) || Object.hasOwn(SHADER_FUNCTIONS, s.name)) fail(`'${s.name}' is already taken: choose another name`, s.at);
        if (declared.has(s.name)) fail(`'${s.name}' is already declared here`, s.at);
        if (s.isConst && !s.init) fail(`a const needs its value: const ${s.type} ${s.name} = …;`, s.at);
        const node = s.init ? as(rvalue(s.init, env, depth), s.type, s.at, `'${s.name}'`) : zero(s.type);
        env.set(s.name, { type: s.type, node, ...(s.isConst ? { fixed: true } : {}) }); declared.add(s.name);
        if (s.isConst && where.top) globals.set(s.name, env.get(s.name));
        return;
      }
      case 'set': assignTo(s, env, depth); return;
      case 'if': {
        const c = rvalue(s.c, env, depth); if (typeOf(c) !== 'bool') fail(`an if needs a condition (true or false), not a ${typeOf(c)}`, s.at);
        if (isConst(c)) { scoped(val(c) ? s.then : s.other, env, depth, where); return; }
        const a = new Map(env), b = new Map(env);
        scoped(s.then, a, depth, where); scoped(s.other, b, depth, where);
        for (const [n, was] of env) { const x = a.get(n), y = b.get(n); if (x.node !== was.node || y.node !== was.node) env.set(n, { ...was, node: select(c, x.node, y.node), ...(x.set || y.set ? { set: true } : {}) }); }
        return;
      }
      case 'for': {
        const from = rvalue(s.from, env, depth); if (!isConst(from) || typeOf(from) !== 'int') fail('a loop starts from a whole number written out: for (int i = 0; …)', s.at);
        if (env.has(s.name) && (reserved(s.name) || env.get(s.name).fixed)) fail(`'${s.name}' is already taken: choose another name for the counter`, s.at);
        const saved = STOPS.slice(1).map((n) => [n, env.get(n)]);
        env.set('$break', { type: 'bool', node: lit('bool', false) });
        const shadow = env.get(s.name);
        let i = val(from), n = 0; const iters = [];
        for (;; n++) {
          const probe = new Map(env); probe.set(s.name, { type: 'int', node: lit('int', i) });
          const c = rvalue(s.cond, probe, depth);
          if (!isConst(c) || typeOf(c) !== 'bool') fail(`a loop's bounds are constants: its condition may only use the counter and numbers written out (for (int i = 0; i < 8; i++))`, s.at);
          if (!val(c)) break;
          if (n >= SHADER_LIMITS.iterations) fail(`this loop runs more than ${SHADER_LIMITS.iterations} times`, s.at);
          iters.push({ k: 'iter', i, body: s.body, name: s.name, at: s.at });
          const st = new Map(probe); assignTo(s.step, st, depth); const next = st.get(s.name).node;
          if (!isConst(next) || typeOf(next) !== 'int') fail('a loop\'s step is the counter going up or down by a whole number (i++, i += 2)', s.at);
          if (val(next) === i) fail('this loop\'s counter never changes', s.at);
          i = val(next);
        }
        list(iters, env, new Set(), depth, { ...where, loop: true }, ['$returned', '$break']);
        for (const [name, was] of saved) { if (was) env.set(name, was); else env.delete(name); }
        if (shadow) env.set(s.name, shadow); else env.delete(s.name);
        return;
      }
      case 'iter': {
        env.set(s.name, { type: 'int', node: lit('int', s.i), fixed: true });
        env.set('$continue', { type: 'bool', node: lit('bool', false) });
        scoped(s.body, env, depth, where);
        return;
      }
      case 'return': {
        if (!where.fn) fail('return belongs in a function; here, assign to an output (color = …;)', s.at);
        const b = env.get('$ret'); env.set('$ret', { ...b, node: as(rvalue(s.e, env, depth), b.type, s.at, `what ${where.fn.name} returns`) });
        env.set('$returned', { type: 'bool', node: lit('bool', true) }); return;
      }
      case 'break': case 'continue':
        if (!where.loop) fail(`${s.k} belongs in a for loop`, s.at);
        env.set(`$${s.k}`, { type: 'bool', node: lit('bool', true) }); return;
      case 'discard':
        if (where.fn) fail('discard belongs in the main code, not in a function', s.at);
        env.set('$discard', { type: 'bool', node: lit('bool', true), set: true }); return;
      default: fail('this statement isn\'t understood', s.at);
    }
  }
  /** A `{ … }`: what it declares ends with it; what it assigns outside stays. */
  function scoped(body, env, depth, where) {
    const inner = new Map(env), mine = new Set();
    list(body, inner, mine, depth, { ...where, top: false });
    for (const [n, b] of inner) if (env.has(n) && !mine.has(n)) env.set(n, b);
  }
  /** Statements in order. Once one of `stops` may have fired, the rest only happen where it didn't. */
  function list(body, env, declared, depth, where, stops = STOPS) {
    for (let i = 0; i < body.length; i++) {
      exec(body[i], env, declared, depth, where);
      if (i === body.length - 1) return;
      const stop = any(stops.filter((n) => env.has(n)).map((n) => env.get(n).node));
      if (stop === null || (isConst(stop) && !val(stop))) continue;
      if (isConst(stop)) return;
      const rest = new Map(env);
      list(body.slice(i + 1), rest, new Set(declared), depth, where, stops);
      for (const [n, was] of env) { const y = rest.get(n); if (y && y.node !== was.node) env.set(n, { ...was, node: select(stop, was.node, y.node), ...(y.set ? { set: true } : {}) }); }
      return;
    }
  }

  function inputsEnv() { return Object.entries(SHADER_INPUTS).map(([n, d]) => [n, { type: d.type, node: mk('input', d.type, [], { name: n, ...(d.frag ? { frag: true } : {}) }), fixed: true }]); }
  const base = () => {
    const env = new Map(globals);
    for (const [n, b] of inputsEnv()) env.set(n, b);
    for (const [n, d] of Object.entries(SHADER_OUTPUTS)) env.set(n, { type: d.type, node: env.get(d.from).node, out: n });
    env.set('$discard', { type: 'bool', node: lit('bool', false), out: '$discard' });
    return env;
  };
  const uniformGlobals = new Map(globals);
  const run = (freeze) => {
    frozen = freeze; globals.clear(); for (const [n, b] of uniformGlobals) globals.set(n, b);   // each reading declares its own top-level consts
    const env = base(); list(prog.body, env, new Set(env.keys()), 0, { fn: null, loop: false, top: true }); return env;
  };
  // two readings of one program: `position` is worked out per vertex, everything else per pixel, where `position`
  // already is the moved point (so the pixel pass reads it and never assigns it)
  const pixelOuts = Object.keys(SHADER_OUTPUTS).filter((n) => n !== 'position');
  const vertex = run(new Set([...pixelOuts, '$discard']));
  const pixel = run(new Set(['position']));
  const outputs = {};
  if (vertex.get('position').set) outputs.position = vertex.get('position').node;
  for (const n of pixelOuts) if (pixel.get(n).set) outputs[n] = pixel.get(n).node;
  const d = pixel.get('$discard');
  // keep only what an output reaches (the other pass's work, and whatever was folded away, is dropped)
  const keep = new Map(); const out = [];
  const visit = (id) => { if (keep.has(id)) return keep.get(id); const n = nodes[id]; const args = n.args.map(visit); const { frag: _f, ...rest } = n; out.push({ ...rest, args }); keep.set(id, out.length - 1); return out.length - 1; };
  const result = { nodes: out, outputs: {}, discard: null, uniforms };
  for (const [n, id] of Object.entries(outputs)) result.outputs[n] = visit(id);
  if (d.set && !(isConst(d.node) && !val(d.node))) result.discard = visit(d.node);
  return result;
}

/** Read shader code. Never throws: {ok: true, nodes, outputs: {<output>: node index}, discard: node index | null,
 *  uniforms: [{name, type}]} or {ok: false, error: {line, col, message}}. `nodes` is in dependency order (a node's
 *  arguments come before it): {op: const|input|uniform|un|bin|ctor|swz|select|call, type, args, …}. */
export function compileShader(source) {
  try {
    if (typeof source !== 'string') fail('the code is text');
    if (source.length > SHADER_LIMITS.source) fail(`the code is ${source.length} characters; at most ${SHADER_LIMITS.source}`);
    const r = lower(parse(lex(source)));
    if (!Object.keys(r.outputs).length && r.discard === null) fail(`this shader changes nothing: assign to an output (${Object.keys(SHADER_OUTPUTS).join(', ')})`);
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof ShaderError) return { ok: false, error: { line: e.line, col: e.col, message: e.message } };
    if (e instanceof RangeError) return { ok: false, error: { line: 1, col: 1, message: 'this shader nests too deeply to read' } };
    throw e;
  }
}
/** The error as one line a person can act on, or null when the code is fine. */
export function shaderProblem(source) { const r = compileShader(source); return r.ok ? null : `line ${r.error.line}, column ${r.error.col}: ${r.error.message}`; }

/** A uniform's value from what the component (and the thing's own `params`) hold: numbers of the uniform's size, else zeros. */
export function uniformValue(u, shaderParams, thingParams) {
  const n = DIM[u.type]; const own = Object.hasOwn(shaderParams ?? {}, u.name) ? shaderParams[u.name] : Object.hasOwn(thingParams ?? {}, u.name) ? thingParams[u.name] : 0;
  const list = Array.isArray(own) ? own : [own];
  const out = []; for (let i = 0; i < n; i++) { const v = list.length === 1 && n > 1 && !Array.isArray(own) ? list[0] : list[i]; out.push(typeof v === 'number' && Number.isFinite(v) ? v : 0); }
  return out;
}

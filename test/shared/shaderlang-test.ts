// shaderlang — the shader code a thing may carry (the draft antra/shader), read into a typed expression graph.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/shared/shaderlang-test.ts
//
// Binds: what a program MEANS. Each graph is run by a small evaluator here (numbers and lists of numbers) and held to
// the answer worked out by hand, so an if that selects, a loop that unrolls, a break, a continue and an early return
// are checked by value, not by shape. Then: the types (what is spread, what is refused), the two readings of one
// program (position per vertex, the rest per pixel), the limits, and that a refusal says where and what.
import { suite } from "../gate/suite.ts";
import { compileShader, shaderProblem, uniformValue, SHADER_LIMITS, SHADER_OUTPUTS, SHADER_INPUTS, SHADER_FUNCTIONS } from "../../shared/shaderlang.js";

const { check, done } = suite("shaderlang");

// ---- the evaluator: a graph's value for given inputs (the arithmetic every backend agrees on; no noise) ----
type V = number | boolean | number[];
const arr = (v: V) => (Array.isArray(v) ? v : [v as number]);
const lift = (f: (...x: number[]) => number) => (...a: V[]) => { const n = Math.max(...a.map((v) => arr(v).length)); const out = Array.from({ length: n }, (_, i) => f(...a.map((v) => { const l = arr(v); return l.length === 1 ? l[0] : l[i]; }))); return a.every((v) => !Array.isArray(v)) ? out[0] : out; };
const FN: Record<string, (...a: any[]) => V> = {
  sin: lift(Math.sin), cos: lift(Math.cos), abs: lift(Math.abs), floor: lift(Math.floor), fract: lift((x) => x - Math.floor(x)), sqrt: lift(Math.sqrt),
  min: lift(Math.min), max: lift(Math.max), pow: lift(Math.pow), mod: lift((x, y) => x - y * Math.floor(x / y)), step: lift((e, x) => (x < e ? 0 : 1)),
  clamp: lift((x, lo, hi) => Math.min(hi, Math.max(lo, x))), mix: lift((a, b, t) => a + (b - a) * t), saturate: lift((x) => Math.min(1, Math.max(0, x))),
  length: (v) => Math.hypot(...arr(v)), dot: (a, b) => arr(a).reduce((s: number, x: number, i: number) => s + x * arr(b)[i], 0),
};
const BIN: Record<string, (x: any, y: any) => any> = { "+": (x, y) => x + y, "-": (x, y) => x - y, "*": (x, y) => x * y, "/": (x, y) => x / y, "%": (x, y) => x - y * Math.floor(x / y),
  "<": (x, y) => x < y, ">": (x, y) => x > y, "<=": (x, y) => x <= y, ">=": (x, y) => x >= y, "==": (x, y) => x === y, "!=": (x, y) => x !== y, "&&": (x, y) => x && y, "||": (x, y) => x || y };
function run(g: any, inputs: Record<string, V> = {}, uniforms: Record<string, V> = {}) {
  const v: V[] = [];
  for (const n of g.nodes) {
    const a = n.args.map((i: number) => v[i]);
    switch (n.op) {
      case "const": v.push(n.value); break;
      case "input": if (!(n.name in inputs)) throw new Error(`the evaluator was given no ${n.name}`); v.push(inputs[n.name]); break;
      case "uniform": v.push(uniforms[n.name]); break;
      case "un": v.push(n.o === "!" ? !a[0] : (lift((x) => -x)(a[0]) as V)); break;
      case "bin": v.push(n.type === "bool" ? BIN[n.o](a[0], a[1]) : n.type === "int" && n.o === "/" ? Math.trunc(a[0] / a[1]) : n.type === "int" && n.o === "%" ? a[0] % a[1] : (lift(BIN[n.o])(a[0], a[1]) as V)); break;
      case "ctor": { const flatv = a.flatMap((x: V) => arr(x as any)); const d = ({ float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4 } as any)[n.type];
        v.push(d === 1 ? (n.type === "int" ? Math.trunc(Number(flatv[0])) : n.type === "bool" ? !!flatv[0] : Number(flatv[0])) : flatv.length === 1 ? Array(d).fill(flatv[0]) : flatv); break; }
      case "swz": { const s = [...n.f].map((ch: string) => (a[0] as number[])["xyzw".indexOf(ch)]); v.push(s.length === 1 ? s[0] : s); break; }
      case "select": v.push(a[0] ? a[1] : a[2]); break;
      case "call": if (!FN[n.fn]) throw new Error(`the evaluator has no ${n.fn}`); v.push(FN[n.fn](...a)); break;
      default: throw new Error(`no such node ${n.op}`);
    }
  }
  const out: Record<string, V> = {}; for (const [k, i] of Object.entries(g.outputs)) out[k] = v[i as number];
  if (g.discard !== null) out.discard = v[g.discard];
  return out;
}
const near = (a: V, b: V) => { const x = arr(a as any), y = arr(b as any); return x.length === y.length && x.every((n, i) => Math.abs(Number(n) - Number(y[i])) < 1e-9); };
const ok = (src: string) => { const r = compileShader(src); if (!r.ok) throw new Error(`doesn't compile: ${r.error.line}:${r.error.col} ${r.error.message}\n${src}`); return r; };
const BASE = { baseColor: [0.2, 0.4, 0.6], baseRoughness: 0.5, baseMetalness: 0, baseOpacity: 1, baseEmissive: [0, 0, 0], position: [1, 2, 3], normal: [0, 1, 0], uv: [0.25, 0.75], time: 10 };

console.log("\nwhat a program means (run and held to the answer):");
{
  check("S1 an assignment, a swizzle and int beside float: color = baseColor.bgr * 2", near(run(ok("color = baseColor.bgr * 2;"), BASE).color, [1.2, 0.8, 0.4]));
  check("S2 a variable is rebound by each assignment (x = 1; x += 2; x *= x)", near(run(ok("float x = 1; x += 2; x *= x; roughness = x;")).roughness, 9));
  check("S3 a swizzle on the left writes those parts and keeps the rest (c.rg = c.gr; c.b += 1)", near(run(ok("vec3 c = baseColor; c.rg = c.gr; c.b += 1; color = c;"), BASE).color, [0.4, 0.2, 1.6]));
  const ifs = ok("float r = 0.1; if (uv.x > 0.5) { r = 0.9; } else if (uv.y > 0.5) { r = 0.5; } roughness = r;");
  check("S4 an if selects per pixel, both ways and the else-if", near(run(ifs, { uv: [0.7, 0] }).roughness, 0.9) && near(run(ifs, { uv: [0.2, 0.8] }).roughness, 0.5) && near(run(ifs, { uv: [0.2, 0.1] }).roughness, 0.1));
  check("S5 what a block declares ends with it; what it assigns outside stays", near(run(ok("float a = 1; { float b = 5; a = a + b; float a2 = 9; } roughness = a;")).roughness, 6)
    && /no 'b' here/.test(shaderProblem("float a = 1; { float b = 5; } roughness = b;") ?? ""));
  check("S6 an inner declaration shadows, and the outer one is untouched after", near(run(ok("float a = 1; { float a = 7; a = a + 1; } roughness = a;")).roughness, 1));
  const loop = ok("float s = 0; for (int i = 0; i < 5; i++) { s += float(i) * uv.x; } roughness = s;");
  check("S7 a for loop is unrolled: sum of i·x for i 0…4", near(run(loop, { uv: [0.5, 0] }).roughness, 5) && near(run(loop, { uv: [2, 0] }).roughness, 20));
  check("S8 a loop over constants folds to one number (no work left for the GPU)", ok("float s = 0; for (int i = 1; i <= 4; i++) { s += float(i * i); } metalness = s / 30;").nodes.length === 1 && near(run(ok("float s = 0; for (int i = 1; i <= 4; i++) { s += float(i * i); } metalness = s / 30;")).metalness, 1));
  check("S9 a loop may count down and by steps (i -= 2)", near(run(ok("float s = 0; for (int i = 9; i > 0; i -= 2) { s += float(i); } roughness = s;")).roughness, 25));
  const brk = ok("float t = 0; for (int i = 0; i < 8; i++) { if (t > uv.x) break; t += 1; } roughness = t;");
  check("S10 break stops the loop where its condition first holds, per pixel", near(run(brk, { uv: [2.5, 0] }).roughness, 3) && near(run(brk, { uv: [100, 0] }).roughness, 8) && near(run(brk, { uv: [-1, 0] }).roughness, 0));
  const cont = ok("float s = 0; for (int i = 0; i < 6; i++) { if (float(i) < uv.x) continue; s += 1; } roughness = s;");
  check("S11 continue skips the rest of one turn only", near(run(cont, { uv: [2, 0] }).roughness, 4) && near(run(cont, { uv: [0, 0] }).roughness, 6));
  const nest = ok("float s = 0; for (int i = 0; i < 3; i++) { for (int j = 0; j < 4; j++) { if (float(j) >= uv.x) break; s += 1; } s += 10; } roughness = s;");
  check("S12 a break leaves only its own loop", near(run(nest, { uv: [2, 0] }).roughness, 36));
  const fn = ok("float sq(float x) { return x * x; } float hyp(float a, float b) { return sqrt(sq(a) + sq(b)); } roughness = hyp(uv.x, uv.y);");
  check("S13 functions are inlined, one inside another", near(run(fn, { uv: [3, 4] }).roughness, 5));
  const early = ok("float f(float x) { if (x < 0.0) return -1.0; if (x > 1.0) { return 2.0; } float y = x * 10; return y; } roughness = f(uv.x);");
  check("S14 an early return guards everything after it", near(run(early, { uv: [-3, 0] }).roughness, -1) && near(run(early, { uv: [5, 0] }).roughness, 2) && near(run(early, { uv: [0.5, 0] }).roughness, 5));
  const retLoop = ok("float first(float x) { for (int i = 0; i < 6; i++) { if (float(i) * 2.0 > x) return float(i); } return 99.0; } roughness = first(uv.x);");
  check("S15 a return inside a loop ends the loop and the function", near(run(retLoop, { uv: [5, 0] }).roughness, 3) && near(run(retLoop, { uv: [50, 0] }).roughness, 99));
  check("S16 ?: selects, and int and float sides agree as float", near(run(ok("roughness = uv.x > 0.5 ? 1 : 0.25;"), { uv: [0.9, 0] }).roughness, 1) && near(run(ok("roughness = uv.x > 0.5 ? 1 : 0.25;"), { uv: [0.1, 0] }).roughness, 0.25));
  check("S17 && and || and ! on conditions", near(run(ok("bool a = uv.x > 0.5 && !(uv.y > 0.5) || uv.x < 0.0; roughness = a ? 1.0 : 0.0;"), { uv: [0.9, 0.1] }).roughness, 1) && near(run(ok("bool a = uv.x > 0.5 && !(uv.y > 0.5) || uv.x < 0.0; roughness = a ? 1.0 : 0.0;"), { uv: [0.9, 0.9] }).roughness, 0));
  check("S18 int arithmetic stays whole (7 / 2 is 3, 7 % 3 is 1), and float(…) leaves it", near(run(ok("int a = 7 / 2; int b = 7 % 3; roughness = float(a) + float(b) / 10;")).roughness, 3.1));
  check("S19 a float's % is mod (-0.25 % 1 is 0.75)", near(run(ok("roughness = (uv.x - 1.0) % 1.0;"), { uv: [0.75, 0] }).roughness, 0.75));
  check("S20 constructors: one number repeated, parts joined, a longer vector cut", near(run(ok("vec4 v = vec4(uv, 3, 4); color = vec3(v) + vec3(1) + vec3(v.w, uv);"), { uv: [1, 2] }).color, [6, 4, 6]));
  const disc = ok("if (uv.x > 0.5) discard; color = vec3(1.0);");
  check("S21 discard is a condition per pixel", run(disc, { uv: [0.9, 0] }).discard === true && run(disc, { uv: [0.1, 0] }).discard === false);
  const uni = ok("uniform float speed; uniform vec3 tint; color = tint * speed;");
  check("S22 uniforms are declared, typed and read", JSON.stringify(uni.uniforms) === JSON.stringify([{ name: "speed", type: "float" }, { name: "tint", type: "vec3" }]) && near(run(uni, {}, { speed: 2, tint: [1, 2, 3] }).color, [2, 4, 6]));
  check("S23 a top-level const is seen inside functions", near(run(ok("const float K = 3; float f(float x) { return x * K; } roughness = f(2.0);")).roughness, 6));
  check("S24 an output reads the thing's own value until assigned (roughness *= 0.5)", near(run(ok("roughness *= 0.5;"), BASE).roughness, 0.25));
  check("S24b a function reads the inputs and the uniforms; its parameters may shadow one; it never sees the main code's variables", near(run(ok("uniform float k; float f(float a) { return a + position.y + time + k; } roughness = f(1.0);"), BASE, { k: 100 }).roughness, 113)
    && near(run(ok("float f(float time) { return time * 2.0; } roughness = f(4.0);"), BASE).roughness, 8) && /no 'mine' here/.test(shaderProblem("float mine = 1.0; float f(float a) { return a + mine; } roughness = f(1.0);") ?? "")
    && /per pixel/.test(shaderProblem("float f(float a) { return a + baseColor.r; } position.y += f(1.0);") ?? ""));
  check("S25 comments, both kinds", near(run(ok("// one\n/* two\n lines */ roughness = 0.5; // three")).roughness, 0.5));
}

console.log("\none program, read twice (position per vertex; everything else per pixel, where position is already the moved point):");
{
  const g = ok("position += normal * 0.5; color = vec3(position.y);");
  const r = run(g, BASE);
  check("P1 position is the moved vertex", near(r.position, [1, 2.5, 3]));
  check("P2 colour reads position as it arrives per pixel: it is not moved a second time", near(r.color, [2, 2, 2]), JSON.stringify(r.color));
  check("P3 a program that never assigns position has no position output", !("position" in ok("color = vec3(1.0);").outputs));
  check("P4 position can't use what is only known per pixel, and the refusal says why", /per pixel/.test(shaderProblem("position += baseColor;") ?? "") && /per pixel/.test(shaderProblem("float d = dFdx(uv.x); position.y += d;") ?? ""));
  check("P5 …but colour may", shaderProblem("color = baseColor * fwidth(uv.x);") === null);
  check("P6 only what an output reaches is kept (the other reading's work is dropped)", !ok("position += normal; color = baseColor;").nodes.some((n: any, i: number, all: any[]) => n.op === "input" && n.name === "normal" && !all.some((m: any) => m.args.includes(i))));
}

console.log("\ntypes: what is spread, what is refused, in words that say where:");
{
  const bad = (src: string, re: RegExp, at?: [number, number]) => { const r = compileShader(src); return !r.ok && re.test(r.error.message) && (!at || (r.error.line === at[0] && r.error.col === at[1])); };
  check("T1 a number beside a vector is spread across it; a number assigned to a vector too", near(run(ok("color = baseColor + 1; emissive = 0.5;"), BASE).color, [1.2, 1.4, 1.6]) && near(run(ok("emissive = 0.5; "), BASE).emissive, [0.5, 0.5, 0.5]));
  check("T2 vectors of different sizes don't join", bad("color = vec3(1.0) + vec2(1.0);", /different sizes/, [1, 19]));
  check("T3 a vector isn't a number (roughness = baseColor)", bad("roughness = baseColor;", /roughness.*is a float.*vec3/));
  check("T4 comparing vectors is refused with the way to do it", bad("if (baseColor > vec3(0.5)) { color = vec3(1.0); }", /compare one component/));
  check("T5 a condition isn't a number, and a number isn't a condition", bad("roughness = 1.0 + (uv.x > 0.5);", /condition/) && bad("if (uv.x) { roughness = 1.0; }", /needs a condition/));
  check("T6 a swizzle past the vector's size, or of mixed letters", bad("color = baseColor.xyzw;", /no \.w/) && bad("color = baseColor.xgb;", /isn't a swizzle/));
  check("T7 an unknown function, by name; textures get a pointer", bad("color = foo(1.0);", /no function 'foo'/, [1, 9]) && bad("color = texture(map, uv).rgb;", /baseColor is the material's own texture/));
  check("T8 a wrong argument list names the call as written", bad("roughness = dot(baseColor, uv);", /dot\(vec3, vec2\) doesn't exist/) && bad("roughness = sin(1.0, 2.0);", /sin\(float, float\)/));
  check("T9 an unknown name; an input can't be assigned; a const can't change", bad("roughness = nope;", /no 'nope'/) && bad("time = 2.0; roughness = time;", /can't be changed \(it is an input/) && bad("const float k = 1; k = 2; roughness = k;", /can't be changed/));
  check("T10 a name can't be declared twice, or over a built-in", bad("float a = 1; float a = 2; roughness = a;", /already declared/) && bad("float time = 1; roughness = time;", /already taken/) && bad("float sin = 1; roughness = sin;", /already taken/));
  check("T11 a statement that does nothing is refused, not ignored", bad("sin(1.0);", /does nothing/) && bad("roughness;", /does nothing/) && bad("float a = 1.0;", /changes nothing/));
  check("T12 a function must return; it can't call itself; return and discard have their places", bad("float f(float x) { float y = x; } roughness = f(1.0);", /never returns/) && bad("float f(float x) { return f(x); } roughness = f(1.0);", /calls itself/)
    && bad("return 1.0;", /belongs in a function/) && bad("float f(float x) { discard; return x; } roughness = f(1.0);", /main code/) && bad("break;", /belongs in a for loop/));
  check("T13 a loop's bounds are constants, and it ends", bad("float s = 0; for (int i = 0; i < int(time); i++) { s += 1; } roughness = s;", /bounds are constants/) && bad("float s = 0; for (int i = 0; i < 4; i += 0) { s += 1; } roughness = s;", /never changes/)
    && bad("float s = 0; for (float i = 0; i < 4; i++) { s += 1; } roughness = s;", /counts with an int/));
  check("T14 what GLSL has and this doesn't says so (while, void, an unterminated comment, a stray character)", bad("while (true) { }", /no 'while'/) && bad("void main() { }", /no void/) && bad("/* open", /never ends/) && bad("roughness = 1.0 @ 2.0;", /isn't part of this language/));
  check("T15 a syntax error points at the place", bad("color = vec3(1.0\n  , 2.0;", /'\)' is missing/, [2, 8]) && bad("roughness = ;", /can't start with ';'/, [1, 13]));
  check("T16 fbm's octaves are a whole number written out, 1 to 8", bad("roughness = fbm(position, time);", /must be a constant/) && bad("roughness = fbm(position, 12);", /1 to 8/) && shaderProblem("roughness = fbm(position, 6, 2.0, 0.5);") === null);
  check("T17 a division by zero in whole numbers is caught here", bad("int a = 1 / 0; roughness = float(a);", /division by zero/));
  check("T18 compileShader never throws, whatever it is given", [undefined, null, 5, {}, "", "}{", "((((", "float f(", "for (", "a.b.c.d = 1;", "\u0000", "x".repeat(100)].every((s) => { try { return compileShader(s as any).ok === false; } catch { return false; } }));
}

console.log("\nconstants are worked out here, and the ones a graphics compiler would refuse are refused first:");
{
  // WGSL rejects a whole shader over one constant expression out of range, and the thing stops being drawn. So what is
  // written out is evaluated here, and such an expression is a refusal in words instead.
  const bad = (src: string, re: RegExp) => { const r = compileShader(src); return !r.ok && re.test(r.error.message); };
  const one = (src: string) => { const g = ok(src); return g.nodes.length === 1 && g.nodes[0].op === "const" ? g.nodes[0].value : null; };
  check("C1 a call on written-out numbers is one constant (sqrt(16.0) / 8.0 is 0.5)", one("roughness = sqrt(16.0) / 8.0;") === 0.5 && one("roughness = clamp(mix(0.0, 10.0, 0.25), 0.0, 2.0) + step(0.5, 1.0) + pow(2.0, 3.0) + mod(7.5, 2.0);") === 12.5);
  check("C2 vectors too: built, swizzled, joined and called (normalize(vec3(3, 0, 4)).zyx * 2)", near(one("color = normalize(vec3(3.0, 0.0, 4.0)).zyx * 2.0;") as any, [1.6, 0, 1.2]) && near(one("color = cross(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0)) + vec3(dot(vec2(1.0, 2.0), vec2(3.0, 4.0)), length(vec2(3.0, 4.0)), distance(vec3(1.0), vec3(1.0, 1.0, 3.0)));") as any, [11, 5, 3]));
  check("C3 a constant folded here equals the same call left to run (the evaluator's arithmetic)", near(one("roughness = smoothstep(0.0, 4.0, 1.0) + fract(-0.25) + sign(-3.0) + floor(2.7) + ceil(2.2) + abs(-1.5) + saturate(3.0) + min(1.0, 2.0) + max(1.0, 2.0);") as any, 0.15625 + 0.75 - 1 + 2 + 3 + 1.5 + 1 + 1 + 2));
  check("C4 out of a function's range: sqrt and log of what they can't take, asin and acos past ±1, pow of a negative", bad("roughness = sqrt(-1.0);", /sqrt takes a number that isn't negative/) && bad("roughness = log(0.0);", /log takes a number above 0/)
    && bad("roughness = acos(1.5);", /acos takes a number from -1 to 1/) && bad("roughness = asin(-2.0);", /asin/) && bad("roughness = pow(-2.0, 2.0);", /pow of a negative/) && bad("roughness = inversesqrt(0.0);", /above 0/) && bad("color = normalize(vec3(0.0));", /vector of zeros/));
  check("C5 …seen through other constant work (sqrt(sin(4.0)): sin(4) is negative)", bad("roughness = sqrt(sin(4.0));", /sqrt takes/) && bad("float a = 2.0; float b = a - 3.0; roughness = log(b);", /log takes/));
  check("C6 smoothstep's edges written out equal or crossed, even when what it shapes is not a constant", bad("roughness = smoothstep(0.5, 0.5, uv.x);", /first edge must be below its second/) && bad("roughness = smoothstep(1.0, 0.0, uv.x);", /first edge/) && bad("color = smoothstep(vec3(0.0), vec3(1.0, 0.0, 1.0), position);", /first edge/)
    && shaderProblem("roughness = smoothstep(0.0, 1.0, uv.x);") === null && shaderProblem("roughness = smoothstep(uv.y, uv.y, uv.x);") === null);
  check("C7 clamp's low written out above its high", bad("roughness = clamp(uv.x, 1.0, 0.0);", /clamp's low is above its high/) && shaderProblem("roughness = clamp(uv.x, 0.0, 0.0);") === null);
  check("C8 a division by a written-out zero: floats, vectors, whole numbers, % and mod", bad("roughness = 1.0 / 0.0;", /division by zero/) && bad("roughness = uv.x / 0.0;", /division by zero/) && bad("color = position / vec3(1.0, 0.0, 1.0);", /division by zero/)
    && bad("int k = int(uv.x) / 0; roughness = float(k);", /division by zero/) && bad("roughness = uv.x % 0.0;", /division by zero/) && bad("roughness = mod(uv.x, 0.0);", /division by zero/) && bad("float z = 1.0 - 1.0; roughness = uv.x / z;", /division by zero/));
  check("C9 a number past what a shader's float holds, or a whole number past an int", bad("roughness = exp(100.0);", /too large for a shader/) && bad("roughness = 1e20 * 1e20;", /too large/) && bad("roughness = 1e31;", /too large/) && bad("int k = 2000000000 * 2; roughness = float(k);", /whole number here is beyond/));
  check("C10 the refusal points at the call", (() => { const r = compileShader("roughness = 0.5;\ncolor = vec3(sqrt(-4.0));"); return !r.ok && r.error.line === 2 && r.error.col === 14; })());
  check("C11 what can't go out of range is left to the graphics card (hash, noise: no constant is invented for them)", ok("roughness = hash(3.0) + noise(vec2(1.0, 2.0));").nodes.filter((n: any) => n.op === "call").length === 2);
}

console.log("\nlimits (a shader compiles on every viewer's machine):");
{
  check("L1 the source's length", /at most 20000/.test(shaderProblem(`roughness = 0.5; //${"x".repeat(SHADER_LIMITS.source)}`) ?? ""));
  check("L2 a loop's turns", /more than 256 times/.test(shaderProblem("float s = 0; for (int i = 0; i < 257; i++) { s += uv.x; } roughness = s;") ?? "") && shaderProblem("float s = 0; for (int i = 0; i < 256; i++) { s += uv.x; } roughness = s;") === null);
  const big = "float s = uv.x; for (int i = 0; i < 200; i++) { for (int j = 0; j < 200; j++) { s = sin(s + float(i * 200 + j)); } } roughness = s;";
  check("L3 the whole graph, once unrolled, and the refusal says what to do", /too big.*4096 operations.*shorten a loop/.test(shaderProblem(big) ?? ""));
  check("L4 identical work is one node (the same call twice costs once)", ok("float a = sin(uv.x * 3.0); float b = sin(uv.x * 3.0); roughness = a + b;").nodes.filter((n: any) => n.op === "call").length === 1);
  check("L5 deep nesting is refused in words, not a stack overflow", compileShader(`roughness = ${"(".repeat(20000)}1.0${")".repeat(20000)};`).ok === false);
}

console.log("\nuniform values (the component's params, then the thing's own, then zero):");
{
  check("U1 a float from the shader's params, else the thing's, else 0", uniformValue({ name: "a", type: "float" }, { a: 2 }, { a: 5 })[0] === 2 && uniformValue({ name: "a", type: "float" }, {}, { a: 5 })[0] === 5 && uniformValue({ name: "a", type: "float" }, null, null)[0] === 0);
  check("U2 a vec from a list; one number is spread; junk is zeros", JSON.stringify(uniformValue({ name: "t", type: "vec3" }, { t: [1, 2, 3] }, null)) === "[1,2,3]" && JSON.stringify(uniformValue({ name: "t", type: "vec3" }, { t: 4 }, null)) === "[4,4,4]" && JSON.stringify(uniformValue({ name: "t", type: "vec2" }, { t: ["x", null] }, null)) === "[0,0]");
  check("U3 a name like __proto__ is only ever an own key", uniformValue({ name: "__proto__", type: "float" }, {}, {})[0] === 0 && uniformValue({ name: "constructor", type: "float" }, {}, {})[0] === 0);
}

console.log("\nthe vocabulary is closed and documented:");
{
  const doc = await Bun.file(new URL("../../docs/guide/SHADERS.md", import.meta.url)).text();
  const missing = [...Object.keys(SHADER_OUTPUTS), ...Object.keys(SHADER_INPUTS), ...Object.keys(SHADER_FUNCTIONS)].filter((n) => !new RegExp("`" + n + "[`(]").test(doc));
  check("V1 every output, input and function is in docs/guide/SHADERS.md", missing.length === 0, `missing: ${missing.join(", ")}`);
  check("V2 every output starts as an input that exists, of its type", Object.values(SHADER_OUTPUTS).every((o: any) => (SHADER_INPUTS as any)[o.from]?.type === o.type));
}

done();

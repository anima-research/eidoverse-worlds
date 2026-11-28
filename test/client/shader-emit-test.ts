// shader-emit — a checked shader graph as the renderer's nodes (client/lib/render/shader-emit.js), built headlessly.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/shader-emit-test.ts
//
// Binds: the language's vocabulary (shared/shaderlang.js) and the emitter's are one list, both ways; every function,
// every input and every kind of node builds a node of the installed three without throwing; a uniform is one node per
// name, of its type's value. Whether the built graph COMPILES on a graphics card is the browser's to say:
// test/protocol/shiplist-probe.ts, stage SH, draws one.
import { suite } from "../gate/suite.ts";
import * as TSL from "../../client/node_modules/three/build/three.tsl.js";
import * as THREE from "../../client/node_modules/three/build/three.webgpu.js";
import { compileShader, SHADER_FUNCTIONS, SHADER_INPUTS, SHADER_OUTPUTS } from "../../shared/shaderlang.js";
import { emitShader, shaderFunctions, shaderInputs } from "../../client/lib/render/shader-emit.js";

const { check, done } = suite("shader-emit");
const time = TSL.uniform(0);
const emit = (src: string) => { const g = compileShader(src); if (!g.ok) throw new Error(`${g.error.line}:${g.error.col} ${g.error.message}`); return { g, r: emitShader({ TSL, THREE }, g, time) }; };

console.log("\none vocabulary:");
{
  const fns = shaderFunctions(TSL), ins = shaderInputs(TSL, time);
  check("E1 every function the language knows has an emitter, and the emitter has no others", JSON.stringify(Object.keys(SHADER_FUNCTIONS).sort()) === JSON.stringify(Object.keys(fns).sort()),
    `language only: ${Object.keys(SHADER_FUNCTIONS).filter((n) => !(fns as any)[n])}; emitter only: ${Object.keys(fns).filter((n) => !(SHADER_FUNCTIONS as any)[n])}`);
  check("E2 every input has an emitter that answers a node", Object.keys(SHADER_INPUTS).every((n) => (ins as any)[n]?.()?.isNode), Object.keys(SHADER_INPUTS).filter((n) => !(ins as any)[n]?.()?.isNode).join(", "));
  const bare = shaderInputs(TSL, time, () => false, THREE);
  check("E2b a mesh with no uv or vertex colour reads them from a uniform holding what absence means (0, 0 and white), never a constant", (bare as any).uv().isUniformNode && (bare as any).uv().value.x === 0 && (bare as any).vertexColor().isUniformNode && (bare as any).vertexColor().value.toArray().join() === "1,1,1,1" && !(ins as any).uv().isUniformNode);
}

console.log("\nevery function builds, in every form it takes:");
{
  // one call per overload the checker admits, over float, vec2, vec3 and vec4 arguments
  const VALS: Record<string, string> = { float: "uv.x", vec2: "uv", vec3: "position", vec4: "vertexColor" };
  const T = ["float", "vec2", "vec3", "vec4"]; let built = 0; const broke: string[] = [];
  const combos = (n: number): string[][] => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => T.map((t) => [...c, t])));
  for (const [name, resolve] of Object.entries(SHADER_FUNCTIONS)) for (let n = 0; n <= 4; n++) for (const types of combos(n)) {
    const r = (resolve as any)(types); if (!r) continue;
    const args = types.map((t, i) => (r.constArgs?.includes(i) ? "3" : VALS[t]));
    const out = r.ret === "float" ? `roughness = ${name}(${args.join(", ")});` : `color = vec3(${name}(${args.join(", ")})${r.ret === "vec2" ? ", 0.0" : r.ret === "vec4" ? ".xyz" : ""});`;
    try { const { r: e } = emit(out); if (!Object.values(e.outputs).every((x: any) => x?.isNode)) broke.push(out); built++; } catch (x) { broke.push(`${out} → ${(x as Error).message}`); }
  }
  check(`E3 ${built} calls (every function, every argument form) build a node`, built > 150 && broke.length === 0, broke.slice(0, 5).join(" | "));
}

console.log("\nevery kind of node builds:");
{
  const { g, r } = emit(`uniform float speed; uniform vec2 a2; uniform vec3 tint; uniform vec4 a4;
    int k = int(uv.x * 4.0) % 3; bool b = uv.x > 0.5 && !(uv.y < 0.1) || k == 1 || k != 2 || uv.x <= 0.2 || uv.y >= 0.3;
    vec3 c = b ? tint * speed : -position; c.rg = c.gr % 2.0; c /= 2.0; c -= vec3(a2, 0.0) + a4.xyz;
    color = c; emissive = baseEmissive + baseColor * instance; roughness = baseRoughness - float(k); metalness = baseMetalness; opacity = baseOpacity * 0.5;
    normal = normalWorld + normalView + viewDir + positionWorld + normal; position += normal * sin(time) + vec3(vertexColor.a);
    if (uv.x > 0.9) discard;`);
  const ops = new Set(g.nodes.map((n: any) => n.op));
  check("E4 a program using every kind of node (const, input, uniform, un, bin, ctor, swz, select) builds every output and the discard", ["const", "input", "uniform", "un", "bin", "ctor", "swz", "select"].every((o) => ops.has(o))
    && JSON.stringify(Object.keys(r.outputs).sort()) === JSON.stringify(Object.keys(SHADER_OUTPUTS).sort()) && Object.values(r.outputs).every((x: any) => x.isNode) && r.discard?.isNode === true, [...ops].join(","));
  check("E5 one uniform node per name, holding a value of its type", r.uniforms.size === 4 && r.uniforms.get("speed")!.node.value === 0 && r.uniforms.get("a2")!.node.value.isVector2 && r.uniforms.get("tint")!.node.value.isVector3 && r.uniforms.get("a4")!.node.value.isVector4);
  const { r: twice } = emit("uniform float s; float a = sin(uv.x * s); roughness = a; metalness = a;");
  check("E6 work two outputs share is one node, built once", twice.outputs.roughness === twice.outputs.metalness && twice.uniforms.size === 1);
  check("E7 `time` is the caller's node (one clock for every shader)", emit("roughness = time;").r.outputs.roughness === time);
}

done();

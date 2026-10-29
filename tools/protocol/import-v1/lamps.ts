// tools/protocol/import-v1/lamps.ts — the lamps main's client inferred for a glowing model (main client/lib/lightrig.js
// attachLamps at ccd5c53f), measured from the GLB here so the translator writes them as light things (@31, LEGACY-PINS item 6).
// Importer-only: this protocol infers nothing at runtime (an emissive material glows; a light is a light component).
// @ts-nocheck
import { resolveLibFile } from "../../../server/libfile.ts";

/** One lamp as main drew it: where (the model's own frame, before its scale), its colour (0xRRGGBB, sRGB), and main's rig numbers. */
export type Lamp = { at: number[]; color: number; intensity: number; range: number; decay: number };
const cache = new Map<string, Lamp[]>();
let ioP: Promise<any> | null = null;
const io = () => (ioP ??= (async () => {
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const draco3d = (await import("draco3dgltf")).default;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
})());

const mul = (a: number[], b: number[]) => { const o = new Array(16).fill(0);   // column-major 4×4, as glTF stores them
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const apply = (m: number[], p: number[]) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
const toSrgb = (x: number) => { const v = Math.max(0, Math.min(1, x)); return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; };
const hex = (rgb: number[]) => rgb.reduce((h, x) => h * 256 + Math.round(toSrgb(x) * 255), 0);

/** main's rule, over a parsed glTF document: three.js traversal order (a node, its primitives as meshes, then its children), at
 *  most two, each at its primitive's bounding-sphere centre (three's: the box centre). */
export function lampsOfDoc(doc: any): Lamp[] {
  const found: { at: number[]; glow: number; e: number[] }[] = [];
  const visit = (node: any, parent: number[]) => {
    const m = mul(parent, node.getMatrix());
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const mat = prim.getMaterial(), e = mat ? mat.getEmissiveFactor() : [0, 0, 0];
      const strength = mat?.getExtension("KHR_materials_emissive_strength")?.getEmissiveStrength?.() ?? 1, map = !!mat?.getEmissiveTexture();
      const glow = strength * Math.max(e[0], e[1], e[2]);
      if (!((!map && glow > 0.5) || (map && strength > 1))) continue;
      const pos = prim.getAttribute("POSITION"); if (!pos) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], v: number[] = [];
      for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } }
      found.push({ at: apply(m, lo.map((x, k) => (x + hi[k]) / 2)), glow: Math.max(glow, strength), e: [...e] });
    }
    for (const c of node.listChildren()) visit(c, m);
  };
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  for (const n of scene?.listChildren() ?? []) visit(n, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return found.slice(0, 2).map(({ at, glow, e }) => {
    const sat = Math.max(...e) - Math.min(...e);   // saturated emissive keeps its colour; whitish reads as a warm bulb
    return { at: at.map((x) => +x.toPrecision(9)), color: sat > 0.25 ? hex(e) : 0xffd9a0, intensity: Math.min(40, 6 + 2.6 * glow), range: 12, decay: 1.7 };
  });
}
/** Measure each library path's lamps once (await before translating): a model this host can't find or read has none, as main drew none. */
export async function warmLamps(libs: Iterable<unknown>) {
  for (const lib of new Set([...libs].filter((x): x is string => typeof x === "string"))) {
    if (cache.has(lib)) continue;
    let lamps: Lamp[] = [];
    try { const f = resolveLibFile(lib); if (f) lamps = lampsOfDoc(await (await io()).read(f)); } catch { /* unreadable: none */ }
    cache.set(lib, lamps);
  }
}
/** A warmed model's lamps ([] when it has none or was never warmed). */
export const lampsOf = (lib: unknown): Lamp[] => (typeof lib === "string" ? cache.get(lib) ?? [] : []);

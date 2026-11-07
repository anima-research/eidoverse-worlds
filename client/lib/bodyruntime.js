// bodyruntime — the loading half of a body that brings its own runtime (§24 avatar defs: `runtime`). The pure half,
// the frame order, is bodyruntime_core.js. A def like defs/avatars/claude_robot.json names a module in the library;
// it's imported by URL when the body is worn (the URL is data, so the client bundle never tries to resolve it, the way
// mods.js loads its scripts), and the joints file beside the body is fetched with it. One import per module, shared
// by every body that wears it.
import { defsRegistry } from './defs.js';
import { makeBodyRuntime, defForBody } from './bodyruntime_core.js';
// (the same def can also say how the body's glow behaves: `lamps` and `emissiveMax`, read by makeAvatar)

const modules = new Map();   // module path -> Promise<module>

/** The avatar def the body at libPath belongs to ({ name, def }), or null. */
export async function bodyDefFor(libPath) {
  const reg = await defsRegistry().catch(() => null);
  return defForBody(reg?.avatars, libPath);
}

/** Cap a body's emissive strength (its def's `emissiveMax`): every material of the VRM, once per load. */
export function capEmissive(vrm, max) {
  if (typeof max !== 'number' || !vrm?.scene) return;
  vrm.scene.traverse((o) => {
    for (const m of [].concat(o.material ?? [])) {
      if (typeof m?.emissiveIntensity === 'number' && m.emissiveIntensity > max) m.emissiveIntensity = max;
    }
  });
}

/** The runtime for the body at libPath, or null when its def declares none (every body without one: no cost).
 *  @param {string} libPath the roster path makeAvatar loads (query and all)
 *  @param {(msg: string, err?: unknown) => void} report
 *  @param {{ name: string, def: any } | null} [hit] the body's def, when the caller has it already */
export async function bodyRuntimeFor(libPath, report, hit) {
  // ?bodyruntime=0: every body plays as a plain VRM (an A/B, and a way out if a runtime misbehaves)
  if (new URLSearchParams(globalThis.location?.search ?? '').get('bodyruntime') === '0') return null;
  hit ??= await bodyDefFor(libPath);
  const rt = hit?.def?.runtime;
  if (!rt?.module) return null;
  let mod = modules.get(rt.module);
  if (!mod) {
    const url = `/library/${rt.module}`;
    mod = import(/* @vite-ignore */ url);
    modules.set(rt.module, mod);
    mod.catch(() => modules.delete(rt.module));   // a failed import may be retried by the next wear
  }
  const joints = rt.joints
    ? fetch(`/library/${rt.joints}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);
  const [m, j] = await Promise.all([mod, joints]);
  const skip = [...(Array.isArray(rt.skip) ? rt.skip : []),   // the def's, then any ?bodyruntime-skip=a,b (an A/B)
    ...(new URLSearchParams(globalThis.location?.search ?? '').get('bodyruntime-skip') ?? '').split(',').filter(Boolean)];
  return makeBodyRuntime(rt.kind, m, { joints: j, report, skip });
}

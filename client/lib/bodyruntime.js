// bodyruntime — the loading half of a body that uses one of Worlds' reviewed,
// built-in body runtimes (§24 avatar defs: `runtime`). The def selects a CLOSED
// kind; it never supplies executable code. That distinction is load-bearing:
// wearing somebody else's body may select code shipped in this Worlds commit,
// but it cannot make every viewer import mutable JavaScript from the asset library.
import { defsRegistry } from './defs.js';
import { makeBodyRuntime, defForBody } from './bodyruntime_core.js';

// Each kind is code-reviewed and commit-bound here. Body-specific joints are
// vendored with the implementation as data, so code + limits travel together.
const LOADERS = Object.freeze({
  'claude-robot-dof': async () => {
    const [mod, joints] = await Promise.all([
      import('./bodyruntimes/claude_robot_dof.js'),
      import('./bodyruntimes/claude_robot_joints.js'),
    ]);
    return { mod, joints: joints.default };
  },
});
const modules = new Map(); // kind -> Promise<{mod,joints}>

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

/** The runtime for the body at libPath, or null when its def declares none.
 * A declared runtime that cannot load FAILS the body load instead of silently
 * presenting the same named body without its defining joint limits.
 * @param {string} libPath @param {(msg:string,err?:unknown)=>void} report
 * @param {{name:string,def:any}|null} [hit] */
export async function bodyRuntimeFor(libPath, report, hit) {
  hit ??= await bodyDefFor(libPath);
  const rt = hit?.def?.runtime;
  if (!rt) return null;
  const load = LOADERS[rt.kind];
  if (!load) throw new Error(`body runtime kind is not built into this client: ${rt.kind}`);
  let p = modules.get(rt.kind);
  if (!p) {
    p = load();
    modules.set(rt.kind, p);
    p.catch(() => modules.delete(rt.kind));
  }
  let loaded;
  try { loaded = await p; }
  catch (e) { report?.(`body runtime ${rt.kind} failed to load`, e); throw e; }
  const skip = Array.isArray(rt.skip) ? [...rt.skip] : [];
  return makeBodyRuntime(rt.kind, loaded.mod, { joints: loaded.joints, report, skip });
}

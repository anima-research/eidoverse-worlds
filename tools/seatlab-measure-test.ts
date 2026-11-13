// seatlab-measure — tools/seatlab/seatlab.js measureSeat reports the seat's pose and anchor from its station (
// it read the retired socket.body and always said sitchair / null). The page modules it imports (/lib/...) are stubbed;
// three and seatcore are real.
//   bun tools/seatlab-measure-test.ts
import { plugin } from "bun";
import path from "node:path";
const ROOT = path.resolve(import.meta.dir, "..");
const S = (globalThis as any).__seat = { mounts: new Map(), bags: new Map(), entities: new Map() };
plugin({ name: "seatlab-lib", setup(b) {
  b.onResolve({ filter: /^\/lib\// }, (a) => ({ path: a.path, namespace: "seatlab-lib" }));
  b.onLoad({ filter: /.*/, namespace: "seatlab-lib" }, (a) => {
    const three = JSON.stringify(path.join(ROOT, "client/node_modules/three/build/three.module.js"));
    const src: Record<string, string> = {
      "/lib/core.js": `import * as THREE from ${three}; export { THREE }; export const scene = new THREE.Scene();`,
      "/lib/remotes.js": "export const remotes = new Map();",
      "/lib/world.js": `import * as THREE from ${three}; const S = globalThis.__seat; export const entities = S.entities; export const avatarMounts = S.mounts;
        export const bagOf = (id) => S.bags.get(id) ?? null; export const mountTransform = () => null;
        export const socketWorldPos = (id, out) => out.set(0, 0.5, 0);
        export const seatSocket = (id) => { const c = S.bags.get(id); return c?.socket ? { id, host: c.parent.to, name: c.socket.name, sock: c.socket, station: c.station ?? null } : null; };`,
      "/lib/avatar.js": "export const makeAvatar = () => null;",
      "/lib/seatcore.js": `export * from ${JSON.stringify(path.join(ROOT, "client/lib/seatcore.js"))};`,
      "/lib/assets.js": "export const vrmaShaLoaded = () => null;",
    };
    if (!(a.path in src)) throw new Error(`seatlab-measure: no stub for ${a.path}`);
    return { contents: src[a.path], loader: "js" };
  });
} });
const THREE = await import(path.join(ROOT, "client/node_modules/three/build/three.module.js"));
const { measureSeat } = await import("./seatlab/seatlab.js");

let fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : ` — ${JSON.stringify(d)}`}`); if (!ok) fail++; };
S.entities.set("bed", new THREE.Object3D());
S.bags.set("bed/s", { parent: { to: "bed" }, transform: { pos: [0, 0.5, 0], q: [0, 0, 0, 1] }, socket: { name: "lie" }, station: { action: "lie", anim: "lie", anchor: "surface" } });
S.bags.set("chair/s", { parent: { to: "bed" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "sit" } });
S.mounts.set("ann", { to: "bed/s" }); S.mounts.set("bo", { to: "chair/s" });
const a = measureSeat("ann").seat?.socketLocal, b = measureSeat("bo").seat?.socketLocal;
check("a station {anim: lie, anchor: surface} is reported as the seat's pose and anchor", a?.pose === "lie" && a?.anchor === "surface", a);
check("no station: the station's defaults (sitchair, root)", b?.pose === "sitchair" && b?.anchor === "root", b);
console.log(fail ? `\n${fail} failed` : "\nall passed"); process.exit(fail ? 1 : 0);

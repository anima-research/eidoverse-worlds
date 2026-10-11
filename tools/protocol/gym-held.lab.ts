// LAB (not in the suite): R's gym, copied: pick up a corn cob and a crate, and measure where each is DRAWN against my
// palm, standing and after a quarter turn. R, 10-11 00:47: "Picking up objects is still very inconsistent. Corn hovering
// above me, crates still not in my hand sometimes".   WORLDS_SRC=<dir> bun tools/protocol/gym-held.lab.ts [ids...]
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC"); process.exit(2); }
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymheld", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["tray-corn-1", "pyr-0", "tray-box"];
  for (const id of ids) {
    const r = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js'), T = (await import('/lib/core.js')).THREE;
      const o = w.entities.get('${id}'); if (!o) return { missing: true }; const p0 = o.getWorldPosition(new T.Vector3()); const walked = await c.walkTo(p0.x - 0.8, p0.z, { ms: 15000 }); c.myState.yaw = Math.PI / 2; await new Promise((z) => setTimeout(z, 1500));   // walk there, as she does (a local teleport leaves the authority's track behind)
      const gap = () => { const o = w.entities.get('${id}'); o.updateWorldMatrix(true, true); const ctr = new T.Box3().setFromObject(o).getCenter(new T.Vector3()); const by = t.physicsApi.holds?.()?.['${id}']?.by ?? Object.values(t.physicsApi.holds?.() ?? {})[0]?.by; const pr = by ? t.palmOf(by, 'right', { p: new T.Vector3(), q: new T.Quaternion() }) : null; const av = t.myAvatar?.()?.root?.position;
        const me = c.myState.pos; return { centre: [+(ctr.x - me.x).toFixed(2), +ctr.y.toFixed(2), +(ctr.z - me.z).toFixed(2)], palm: pr?.p ? [+(pr.p.x - me.x).toFixed(2), +pr.p.y.toFixed(2), +(pr.p.z - me.z).toFixed(2)] : null, avatar: av ? [+(av.x - me.x).toFixed(2), +(av.z - me.z).toFixed(2)] : null, by }; };
      globalThis.__refresh = {};
      const writers = new Map(); const V = T.Vector3.prototype; for (const m of ['set', 'copy', 'applyMatrix4', 'lerpVectors', 'add', 'addScaledVector', 'setFromMatrixPosition', 'sub', 'setScalar', 'fromArray']) {
        o.position[m] = function (...a) { const st = new Error().stack.split(String.fromCharCode(10)).slice(2, 4).map((l) => l.trim().split('/').slice(-1)[0].slice(0, 70)).join(' < '); const k = m + ' @ ' + st; writers.set(k, (writers.get(k) ?? 0) + 1); return V[m].apply(this, a); }; }
      const decomp = T.Matrix4.prototype.decompose; let dec = 0; o.updateMatrix = function () { return T.Object3D.prototype.updateMatrix.call(this); };
      const g = await t.physicsApi.grab('${id}'); await new Promise((z) => setTimeout(z, 1800)); const held = gap();
      const frames = []; for (let i = 0; i < 12; i++) { await new Promise((z) => requestAnimationFrame(z)); o.updateWorldMatrix(true, false); const q = o.getWorldPosition(new T.Vector3()); frames.push([+(q.x - c.myState.pos.x).toFixed(2), +q.y.toFixed(2), +(q.z - c.myState.pos.z).toFixed(2)]); }
      const chain = []; o.traverse((m) => { if (m.isMesh) { const ch = []; for (let x = m; x && x !== o.parent; x = x.parent) ch.push([x.type, x.name.slice(0, 16), x.position.toArray().map((v) => +v.toFixed(3)), x.scale.toArray().map((v) => +v.toFixed(3)), x.matrixAutoUpdate, x.matrixWorldAutoUpdate]); chain.push(ch); } });
      const meshes = []; o.traverse((m) => { if (m.isMesh || m.isLine || m.isPoints) { const wp = m.getWorldPosition(new T.Vector3()); meshes.push([m.type, m.name.slice(0, 24), m.visible, [+(wp.x - c.myState.pos.x).toFixed(2), +wp.y.toFixed(2), +(wp.z - c.myState.pos.z).toFixed(2)]]); } });
      const cur = w.entities.get('${id}'); let rootO = o; while (rootO.parent) rootO = rootO.parent; let rootC = cur; while (rootC?.parent) rootC = rootC.parent;
      let copies = 0; (await import('/lib/core.js')).scene.traverse((x) => { if (x.userData?.entityId === '${id}') copies++; });
      const info = { same: cur === o, oldInScene: !!rootO.isScene, curInScene: !!rootC?.isScene, copiesInScene: copies, oldTier: o.userData?.tier ?? null, curTier: cur?.userData?.tier ?? null, curWorld: cur?.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(2)), writers: [...writers].sort((a, b) => b[1] - a[1]).slice(0, 8), refresh: globalThis.__refresh?.['${id}'] ?? null, chain, objWorld: o.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(2)), meshes, dbg: globalThis.__dbgHeld?.('${id}'), holds: Object.keys(t.physicsApi.holds?.() ?? {}), shown: !!t.physicsApi.shown?.()?.bodies?.['${id}'], parentObj: o.parent?.userData?.entityId ?? o.parent?.type, scale: o.scale.toArray().map((v) => +v.toFixed(3)) };
      c.myState.yaw += Math.PI / 2; await new Promise((z) => setTimeout(z, 1500)); const turned = gap();
      await t.physicsApi.put('${id}'); await new Promise((z) => setTimeout(z, 800));
      return { walked, me: [+c.myState.pos.x.toFixed(2), +c.myState.pos.z.toFixed(2)], grab: g?.ok ?? g?.refused?.code, parent: w.comps.get('${id}')?.parent?.to ?? null, held, frames, info, turned };`);
    console.log(id, JSON.stringify(r));
  }
} finally { await cleanup(0); }
process.exit(0);

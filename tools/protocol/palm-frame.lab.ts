// LAB (not in the suite): measure the palm frame (thingphysics palmOf) against the avatar's own hand bones, both sides,
// so the grip editor's ghost hand and its mirror are drawn from the real thing, not from my reading of palmOf.
// @ts-nocheck
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const { cdp, evalJson, cleanup, BASE } = await scratchBench("palmframe", {});
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Probe&avatar=${process.env.AV ?? "tigerbee"}` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(9000);
  const r = await page(`const t = await import('/lib/thingphysics.js'), n = await import('/lib/net.js'), { THREE: T } = await import('/lib/core.js');
    const av = t.myAvatar(); const H = av?.vrm?.humanoid; if (!H) return 'no avatar';
    av.root.updateWorldMatrix(true, true); const rq = av.root.getWorldQuaternion(new T.Quaternion()), rqi = rq.clone().invert();
    const out = {};
    for (const side of ['right', 'left']) { const P = { p: new T.Vector3(), q: new T.Quaternion() }; if (!t.palmOf(n.net.you, side, P)) { out[side] = 'no palm'; continue; }
      const inv = P.q.clone().invert(); const r3 = (v) => v.toArray().map((x) => +x.toFixed(3));
      const loc = (name) => { const b = H.getRawBoneNode(name); return b ? r3(b.getWorldPosition(new T.Vector3()).sub(P.p).applyQuaternion(inv)) : null; };
      const axesInRoot = [[1,0,0],[0,1,0],[0,0,1]].map((a) => r3(new T.Vector3(...a).applyQuaternion(P.q).applyQuaternion(rqi)));
      const pts = { hand: loc(side + 'Hand'), lowerArm: loc(side + 'LowerArm') };
      for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) pts[f] = (f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']).map((s) => loc(side + f + s));
      out[side] = { axesInRoot, pts }; }
    return out;`);
  console.log(JSON.stringify(r));
} finally { await cleanup(); }

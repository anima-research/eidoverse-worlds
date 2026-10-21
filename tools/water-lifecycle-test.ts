// water lifecycle — an agent's stature and its float belong to the CURRENT body and the CURRENT water.
// A body swap re-measures (and a late answer for the old body cannot land); draining, refilling or moving
// the water ends the float, so no position or velocity crosses from one water to the next.
//   bun tools/water-lifecycle-test.ts
// A real WorldAgent, unconnected, over a stub /library serving two fixture bodies of different heights.
process.env.AGENT_BODY_ENGINE = "verlet";
const { WorldAgent } = await import("../mcpl/agent.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a GLB holding only the JSON a stature read needs: hips, and a head (stature = head + 0.13 m)
function bodyGlb(stature: number) {
  const head = stature - 0.13;
  const json = { asset: { version: "2.0" },
    nodes: [{ name: "Hips", translation: [0, head * 0.55, 0], children: [1] }, { name: "Head", translation: [0, head * 0.45, 0] }],
    extensions: { VRMC_vrm: { humanoid: { humanBones: { hips: { node: 0 }, head: { node: 1 } } } } } };
  let txt = JSON.stringify(json); while (txt.length % 4) txt += " ";
  const jb = new TextEncoder().encode(txt), out = new Uint8Array(12 + 8 + jb.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  return out;
}
const SHORT = 1.0, TALL = 2.6, SLOW = 1.9;
const files: Record<string, { glb: Uint8Array; delay: number }> = {
  "fix/short.vrm": { glb: bodyGlb(SHORT), delay: 0 },
  "fix/tall.vrm": { glb: bodyGlb(TALL), delay: 0 },
  "fix/slow.vrm": { glb: bodyGlb(SLOW), delay: 400 },   // an old body whose height answers late
};
const srv = Bun.serve({ port: 0, async fetch(req) {
  const f = files[new URL(req.url).pathname.replace(/^\/library\//, "")];
  if (!f) return new Response("no", { status: 404 });
  await sleep(f.delay);
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
  return m ? new Response(f.glb.slice(+m[1], +m[2] + 1), { status: 206 }) : new Response(f.glb);
} });

const a: any = new WorldAgent({ name: "swimmer", world: "lifecycle", url: `ws://127.0.0.1:${srv.port}/ws`, avatar: "fix/short.vrm" });
// the terrain toolkit stands in as a flat bed 1.6 m under the water: over a 1.0 m body's head (it swims),
// under a 2.6 m body's chest (it wades)
a.terrainSrc = "stub";
(globalThis as any).makeTerrain = () => ({ heightAt: () => -1.6 });
a.joined = true;
const WET = { size: 40, water: { level: 0 } };
const settle = async () => { for (let i = 0; i < 50 && a.bodyH == null; i++) await sleep(10); };
const tickN = (n: number) => { for (let i = 0; i < n; i++) a.tick(); };

console.log("\nstature follows the body");
{
  await a.buildTerrain(WET); await settle();
  check(`the short body is measured (${a.bodyH?.toFixed(2)} m)`, Math.abs(a.bodyH - SHORT) < 0.01);
  tickN(5);
  check("...and swims in 1.6 m of water", a.float.on && /swimming/.test(a.waterHere(0, 0, a.pos.y)), a.waterHere(0, 0, a.pos.y));
  a.setAvatar("fix/tall.vrm");
  check("a new body ends the old float at once", !a.float.on);
  check("...and does not keep the old height while the new one is read", a.bodyH === null && a.stature() !== SHORT);
  await settle(); tickN(5);
  check(`the tall body is measured (${a.bodyH?.toFixed(2)} m)`, Math.abs(a.bodyH - TALL) < 0.01);
  check("...and wades where the short one swam", !a.float.on && /standing/.test(a.waterHere(0, 0, a.pos.y)) && Math.abs(a.pos.y + 1.6) < 1e-6, a.waterHere(0, 0, a.pos.y));
  a.setAvatar("fix/slow.vrm");
  a.setAvatar("fix/short.vrm");
  await settle(); await sleep(1100);   // long past the slow body's answer (two 400 ms reads)
  check("a late answer for a replaced body does not overwrite the current one", Math.abs(a.bodyH - SHORT) < 0.01, `${a.bodyH}`);
}

console.log("\nthe float follows the water");
{
  tickN(10);
  check("afloat in the water", a.float.on);
  a.float = { on: true, y: -1, vy: 2 };   // a float mid-bob
  await a.buildTerrain({ size: 40 });     // drained
  check("draining ends the float", !a.float.on && a.water === null);
  a.float = { on: true, y: 0.5, vy: 2 };   // (and even one left set by anything else — a bob far from any real one)
  tickN(1);
  check("a dry tick leaves no float", !a.float.on, JSON.stringify(a.float));
  tickN(30);   // (a body the water held up comes down to the ground — at once, or by falling)
  check("...and the body comes to stand on the ground", Math.abs(a.pos.y + 1.6) < 1e-3, `${a.pos.y}`);
  a.pos.y = -1.2;   // wherever it happens to be when the water comes back
  await a.buildTerrain(WET); tickN(1);
  // (from the body as it stands then — its own y, or the resting depth if the feet set that first)
  check("refilled, the float starts from the body, not the old bob", a.float.on && Math.abs(a.float.vy) < 0.5 && a.float.y > -1.3 && a.float.y < -0.7, JSON.stringify(a.float));
  tickN(30);
  a.float.vy = 3;
  await a.buildTerrain({ size: 40, water: { level: 0.5 } });
  check("a new level ends the float", !a.float.on);
  tickN(30);
  const y = a.float.y;
  a.float.vy = 3;
  await a.buildTerrain({ size: 40, water: { level: 0.5 } });
  check("...but the same water rebuilt keeps it", a.float.on && a.float.y === y);
  a.clip = "ragdoll"; tickN(1); a.clip = "idle";
  check("a ragdoll's turn ends the float (it moved the body)", !a.float.on);
}

console.log("\nwhere the body is, not just the bed under it");
{
  a.float = { on: false, y: 0, vy: 0 };
  check("a body held above the water is not in it", a.waterHere(0, 0, 1.2) === "");
  a.flight = { phase: "PILOT" };
  check("...nor is one flying over it", a.waterHere(0, 0, -1.6) === "");
  a.flight = null;
}

srv.stop(true);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : "\n\x1b[32mall passed\x1b[0m");
process.exit(failures ? 1 : 0);

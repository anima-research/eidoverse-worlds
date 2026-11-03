// snapframe-render-test — where the renderer leg actually puts the camera.
//
//   bun tools/snapframe-render-test.ts
//
// snapframe-test.ts checks the normaliser, the first-person pitch and the wire,
// but its fake renderer places no camera, so it passes whatever
// client/lib/net_snap.js does with dist / height. This runs the shipped
// snapshot() with only the browser boundary stubbed (core.js's camera, the
// remotes map, capture.js, fp_view.js's composer) and checks the eye and the
// aim for third and selfie, with and without framing, that pitch reaches
// composeFirstPerson, and that only the nested `frame` is read as framing: a
// message that carries an image size's `height` keeps the default camera.
//
// The third-view aim's look-ahead scales with distance (4 m at the default
// 3.4 m): a fixed 4 m look-ahead lost the body off the bottom of a close
// camera's frame. The framing checks below pin that with the camera's real
// 55° vertical FOV.

import { mock } from "bun:test";
import * as THREE from "three";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const near = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-9) => a.distanceTo(b) < eps;
const fmt = (v: THREE.Vector3) => `[${v.toArray().map((n) => n.toFixed(3)).join(", ")}]`;

const VFOV = 55;   // client/lib/core.js's PerspectiveCamera
const lib = (p: string) => new URL(`../client/lib/${p}`, import.meta.url).pathname;

// ---- stubs at the browser boundary ------------------------------------------
const shots: { eye: THREE.Vector3; at: THREE.Vector3 }[] = [];
const composed: Record<string, unknown>[] = [];
const root = { position: V(3, 0.5, -7), rotation: { y: 0.7 }, visible: true };
const remote = {
  avatar: {
    root,
    headWorldPosition: (out: THREE.Vector3) => out.set(3, 2.0, -7),
    visualBounds: () => null,
  },
};
mock.module(lib("core.js"), () => ({ THREE, camera: { isStub: true } }));
mock.module(lib("remotes.js"), () => ({ remotes: new Map([["t", remote]]) }));
mock.module(lib("capture.js"), () => ({
  captureFrame: () => "frame",
  captureFrom: (eye: THREE.Vector3, at: THREE.Vector3) => { shots.push({ eye: eye.clone(), at: at.clone() }); return "frame"; },
}));
mock.module(lib("fp_view.js"), () => ({
  composeFirstPerson: (opts: Record<string, unknown>) => { composed.push(opts); return "frame"; },
}));
const { snapshot } = await import("../client/lib/net_snap.js");

const fwd = V(Math.sin(root.rotation.y), 0, Math.cos(root.rotation.y));
const at = (up: number, ahead: number) => root.position.clone().add(V(0, up, 0)).addScaledVector(fwd, ahead);
async function shoot(msg: Record<string, unknown>) {
  const before = shots.length;
  const r = await snapshot({ follow: "t", ...msg });
  return { ok: (r as any).dataUrl === "frame", shot: shots.length > before ? shots.at(-1)! : null, r };
}
// Is the body point `up` metres above the feet inside the vertical FOV?
function inFrame(s: { eye: THREE.Vector3; at: THREE.Vector3 }, up: number) {
  const aim = s.at.clone().sub(s.eye).normalize();
  const to = at(up, 0).sub(s.eye).normalize();
  return aim.angleTo(to) * 180 / Math.PI <= VFOV / 2 + 1e-9;
}
// Lowest body point (to 1 cm) in frame, or null if none up to 1.6 m.
function lowestInFrame(s: { eye: THREE.Vector3; at: THREE.Vector3 }) {
  for (let cm = 0; cm <= 160; cm++) if (inFrame(s, cm / 100)) return cm / 100;
  return null;
}

// ---- third ------------------------------------------------------------------
console.log("third");
let t = await shoot({ view: "third" });
check("default eye: 2.1 m up, 3.4 m behind", t.ok && !!t.shot && near(t.shot.eye, at(2.1, -3.4)), t.shot ? fmt(t.shot.eye) : String(t.r));
check("default aim: 1.2 m up, 4 m ahead (unchanged)", !!t.shot && near(t.shot.at, at(1.2, 4)), t.shot ? fmt(t.shot.at) : "");
t = await shoot({ view: "third", frame: { dist: 1, height: 1.5 } });
check("dist+height move the eye", !!t.shot && near(t.shot.eye, at(1.5, -1)), t.shot ? fmt(t.shot.eye) : "");
check("look-ahead scales with dist (4·1/3.4 m)", !!t.shot && near(t.shot.at, at(1.2, 4 / 3.4)), t.shot ? fmt(t.shot.at) : "");
t = await shoot({ view: "third", frame: { height: 3 } });
check("height alone keeps the default look-ahead", !!t.shot && near(t.shot.eye, at(3, -3.4)) && near(t.shot.at, at(1.2, 4)), t.shot ? `${fmt(t.shot.eye)} → ${fmt(t.shot.at)}` : "");
for (const dist of [2, 1, 0.5]) {
  t = await shoot({ view: "third", frame: { dist } });
  const low = t.shot ? lowestInFrame(t.shot) : null;
  check(`dist ${dist}: the body is in frame from below 1 m up`, low !== null && low < 1 && inFrame(t.shot!, 1.6), `lowest in frame ${low}`);
}
t = await shoot({ view: "third", frame: { dist: 0.5 } });
check("dist 0.5 at default height: in frame from 0.92 m up", !!t.shot && lowestInFrame(t.shot) === 0.92, `lowest ${t.shot && lowestInFrame(t.shot)}`);
t = await shoot({ view: "third", frame: { height: 0 } });
check("height 0 puts the eye at the feet, not the default", !!t.shot && near(t.shot.eye, at(0, -3.4)), t.shot ? fmt(t.shot.eye) : "");

// ---- selfie -----------------------------------------------------------------
console.log("selfie");
t = await shoot({ view: "selfie" });
check("default eye: 1.6 m up, 2.6 m in front", t.ok && !!t.shot && near(t.shot.eye, at(1.6, 2.6)), t.shot ? fmt(t.shot.eye) : String(t.r));
check("aim at the body, 1.25 m up", !!t.shot && near(t.shot.at, at(1.25, 0)), t.shot ? fmt(t.shot.at) : "");
t = await shoot({ view: "selfie", frame: { dist: 1.2, height: 0.8 } });
check("dist+height move the eye", !!t.shot && near(t.shot.eye, at(0.8, 1.2)), t.shot ? fmt(t.shot.eye) : "");
check("aim stays on the body", !!t.shot && near(t.shot.at, at(1.25, 0)), t.shot ? fmt(t.shot.at) : "");
t = await shoot({ view: "selfie", frame: { height: 0 } });
check("height 0 puts the eye at the feet, not the default", !!t.shot && near(t.shot.eye, at(0, 2.6)), t.shot ? fmt(t.shot.eye) : "");
t = await shoot({ view: "selfie", frame: { dist: 500, height: 99 } });
check("dist and height are clamped to 30 m", !!t.shot && near(t.shot.eye, at(30, 30)), t.shot ? fmt(t.shot.eye) : "");

// ---- first ------------------------------------------------------------------
console.log("first");
let n = composed.length;
t = await shoot({ view: "first", frame: { pitch: -60 } });
check("pitch reaches composeFirstPerson", t.ok && composed.length === n + 1 && composed.at(-1)!.pitch === -60, JSON.stringify(composed.at(-1)?.pitch));
check("first places no captureFrom camera", t.shot === null);
n = composed.length;
await shoot({ view: "first" });
check("omitted pitch reaches it as undefined", composed.length === n + 1 && composed.at(-1)!.pitch === undefined);
await shoot({ view: "first", frame: { pitch: -200 } });
check("pitch is clamped before the composer", composed.at(-1)!.pitch === -85, JSON.stringify(composed.at(-1)?.pitch));

// ---- fields on the message itself -------------------------------------------
console.log("fields on the message itself");
// A snap that also carries an image size (width, height) asks for no framing.
t = await shoot({ view: "selfie", width: 960, height: 540 });
check("selfie with an image size: the default eye, 1.6 m up", !!t.shot && near(t.shot.eye, at(1.6, 2.6)), t.shot ? fmt(t.shot.eye) : String(t.r));
t = await shoot({ view: "third", width: 960, height: 540, dist: 1 });
check("third with an image size and a dist: the default eye and aim", !!t.shot && near(t.shot.eye, at(2.1, -3.4)) && near(t.shot.at, at(1.2, 4)), t.shot ? `${fmt(t.shot.eye)} → ${fmt(t.shot.at)}` : String(t.r));
t = await shoot({ view: "selfie", dist: 1 });
check("selfie with a dist: the default eye, 2.6 m in front", !!t.shot && near(t.shot.eye, at(1.6, 2.6)), t.shot ? fmt(t.shot.eye) : String(t.r));
n = composed.length;
await shoot({ view: "first", pitch: -60 });
check("first with a pitch outside frame: the default gaze", composed.length === n + 1 && composed.at(-1)!.pitch === undefined, JSON.stringify(composed.at(-1)?.pitch));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

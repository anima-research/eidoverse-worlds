// build-chapel101 — stages the #101 acceptance world on a SCRATCH sequencer.
// Never run against a port anyone lives on. Specimens:
//  - cushion: the chapel-cushion clone (store/0445768b0c87d590.glb), Mica's
//    exact authored transform, seat socket at model-local y=-0.29 (× scale
//    6.694 → the 7mm-above-pad plane Phase A verified). The clone OPTS INTO
//    seatAnchor:"surface" — the authored migration act.
//  - ctrl: a doctrinally-authored known-good legacy seat (no anchor) — the
//    no-regress specimen; must render byte-identically to main.
//  - swing: a pendulum whose axis TILTS the parent through the arc — the live
//    B2 discriminator + moving-parent no-drift fixture, surface-anchored.
import { WorldAgent } from "../../mcpl/agent.ts";

const ag = new WorldAgent({ url: "ws://127.0.0.1:8994/ws", name: "stagehand", world: "chapel101b" });
await ag.connect();
ag.verb("spawn", { id: "cushion", lib: "store/0445768b0c87d590.glb", pos: [-22.116, 3.638, 16.694], yaw: 0, scale: 6.694 });
ag.verb("comp", { id: "cushion", type: "sockets", data: {
  seat: { pos: [0, -0.29, 0], pose: "sitchair", seatAnchor: "surface" },
} });
ag.verb("spawn", { id: "ctrl", lib: "eidoverse/assets/models/crate_large_blue.glb", pos: [-18, 0, 16.694], yaw: 0 });
ag.verb("comp", { id: "ctrl", type: "sockets", data: {
  seat: { pos: [0, 0.55, 0], pose: "sitchair" },          // legacy: authored under root-at-socket, stays put
} });
ag.verb("spawn", { id: "swing", lib: "eidoverse/assets/models/crate_large_blue.glb", pos: [-26, 3, 16.694], yaw: 0 });
ag.verb("comp", { id: "swing", type: "sockets", data: {
  seat: { pos: [0, 0.55, 0], pose: "sitchair", seatAnchor: "surface" },
} });
ag.verb("motion", { id: "swing", type: "pendulum", axis: [1, 0, 0], pivot: [0, 2.4, 0], amp: 0.5, period: 3.2, t0: Date.now() });
await new Promise((r) => setTimeout(r, 800));
console.log("chapel101 staged:", [...(ag as any).entities.keys()].join(", "));
ag.close();

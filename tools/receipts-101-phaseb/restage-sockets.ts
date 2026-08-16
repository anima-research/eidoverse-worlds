// The REAL chapel cushion authorship, read from prod commons e6482948 via the
// public /geom tier (read-only — the live chapel is never written). Exact
// transform to full precision; Digi's four sockets verbatim. For the battery:
// `seat` is the migrated surface specimen; `seat2` stays legacy-root — the
// same-cushion in-place control (B1: byte-identical composition, declared).
import { WorldAgent } from "../../mcpl/agent.ts";
const ag = new WorldAgent({ url: "ws://127.0.0.1:8994/ws", name: "stagehand", world: "chapel101b" });
await ag.connect();
ag.verb("place", { id: "cushion", pos: [-22.1163814045823, 3.6378553539267884, 16.69438442197905], yaw: 0, scale: 6.694159214837762 });
ag.verb("comp", { id: "cushion", type: "sockets", data: {
  seat:  { pos: [-0.247, -0.29, -0.04],  yaw: 1.675,  pose: "sitchair", seatAnchor: "surface" },
  seat2: { pos: [-0.249, -0.29, 0.041],  yaw: 1.708,  pose: "sitchair" },
  seat3: { pos: [-0.075, -0.291, -0.226], yaw: 0.13,  pose: "sitchair", seatAnchor: "surface" },
  seat4: { pos: [-0.107, -0.29, 0.226],  yaw: -3.034, pose: "sitchair", seatAnchor: "surface" },
} });
await new Promise((r) => setTimeout(r, 600));
console.log("real sockets staged");
ag.close();

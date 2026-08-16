// noon light for the acceptance photographs — owner verb, stagehand owns chapel101b
import { WorldAgent } from "../../mcpl/agent.ts";
const ag = new WorldAgent({ url: "ws://127.0.0.1:8994/ws", name: "stagehand", world: "chapel101b" });
await ag.connect();
ag.verb("sky", { hours: 12 });
await new Promise((r) => setTimeout(r, 500));
console.log("noon set");
ag.close();

// sitter — a real headless participant for the #101 acceptance battery.
// Joins the scratch battery world wearing the named avatar, mounts the named
// seat, and prints its own look() header every 2s — the HEADLESS CONSUMER's
// seated line, straight from the real delivery path (httpBase /avatars fetch,
// update events, effective.ts composition). Usage:
//   bun run sitter.ts <name> <avatarFile> <to> <slot>
import { WorldAgent } from "../../mcpl/agent.ts";

const [name, avatarFile, to, slot] = process.argv.slice(2);
const ag = new WorldAgent({ url: "ws://127.0.0.1:8994/ws", name, world: "chapel101b",
  avatar: `eidoverse/assets/vrms/${avatarFile}` });
await ag.connect();
await new Promise((r) => setTimeout(r, 500));
ag.verb("mount", { id: name, to, slot });
setInterval(() => {
  console.log(`[${new Date().toISOString()}] ${ag.look().split("\n")[0]}`);
}, 2000);

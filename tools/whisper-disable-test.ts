import { readFileSync } from "node:fs";
import { strict as A } from "node:assert";
// the ws handler bodies live in the message table now (R2, server/messages.ts)
const server = readFileSync(new URL("../server/messages.ts", import.meta.url), "utf8");
const mcpl = readFileSync(new URL("../mcpl/net-server.ts", import.meta.url), "utf8");
A.match(server, /const WHISPERS_ENABLED = process\.env\.EIDO_WHISPERS_ENABLED !== "0"/);
A.match(server, /"whisper": \(\{ c, ws, now, expel \}, msg\) => \{\s*if \(!WHISPERS_ENABLED\)/);
A.match(server, /whispers are disabled in this world/);
A.match(mcpl, /TOOLS\.filter\(\(t\) => t\.name !== "whisper"\)/);
A.match(mcpl, /case "whisper": \{\s*if \(!WHISPERS_ENABLED\)/);
console.log("whisper disable gates: 5/5");

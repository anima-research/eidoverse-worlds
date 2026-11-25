// anon-stats-preload: a test's window on a scratch server's guest ids (server/directory.ts anonStats). Loaded with
// `bun --preload` into the server process (harness.ts scratchSequencer `preload`), it writes the directory's
// {held, departed} to anon-stats.json in the scratch dir (RELAY_STATE_DIR) every 50 ms, so a suite can see whether a
// guest's id was let go. Never shipped.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { directoryFor } from "../../server/directory.ts";
import { WORLDS_DIR } from "../../server/config.ts";

const dir = process.env.RELAY_STATE_DIR;
if (dir) setInterval(() => { try { writeFileSync(join(dir, "anon-stats.json"), JSON.stringify(directoryFor(WORLDS_DIR).anonStats())); } catch { /* next tick */ } }, 50).unref();

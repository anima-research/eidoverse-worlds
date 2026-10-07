// server/v4/filehost.ts — a v4 world on disk: the storage half of the lab's openWorld (code/v4-lab/authority.js @ 11db981),
// split out so shared/v4/authority.js stays pure. Same layout as the lab: <root>/worlds/<name>.jsonl (the log),
// <root>/worlds/<name>.presence.json (the presence plane, a file only because a test process may call once per
// request) and <root>/store/sha256-<hex>.json (blobs, §2.2: named by full hash, stored once, verified on read).
//
// Slice 1: used by the v4 suites only. Nothing in the running server imports this yet (slice 2 is the authority).
import fs from "node:fs";
import path from "node:path";
import { readLog, jcs, sha256 } from "../../shared/v4/fold.js";
import { worldOf, posAt } from "../../shared/v4/authority.js";
import { readLogBytes, appendDurable, putBlobFile } from "./durable.ts";
import { custodyAt, modLogAt } from "./custody.ts";
import { SANDBOX } from "../../shared/v4/sandbox.js";

/** scripts: the sandbox (default: QuickJS, shared/v4/sandbox.js); null = an authority with none (activations say unavailable) */
export type OpenOpts = { now?: () => number; scripts?: unknown; present?: () => { id: string; at: number[] | null }[] };

/** The lab clock: V4_NOW pins wall time so physics tests are repeatable. A real authority passes its own clock. */
const envClock = () => (process.env.V4_NOW ? Number(process.env.V4_NOW) : Date.now());

export function openWorld(root: string, name: string, opts: OpenOpts = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`);
  const storeDir = path.join(root, "store");
  const presPath = path.join(root, "worlds", `${name}.presence.json`);
  const entries = readLog(readLogBytes(logPath)).map(posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const getBlob = (h: string) => {
    const s = fs.readFileSync(blobPath(h), "utf8");
    if (`sha256:${sha256(s)}` !== h) throw new Error(`blob ${h} doesn't match its name`);
    return JSON.parse(s);
  };
  const putBlob = (v: unknown) => {
    const s = jcs(v); const h = `sha256:${sha256(s)}`;
    putBlobFile(blobPath(h), s, h);
    return h;
  };
  return worldOf({
    name, entries, getBlob, putBlob,
    now: opts.now ?? envClock,
    scripts: opts.scripts === undefined ? SANDBOX : opts.scripts, present: opts.present,
    writeLine: (line: string) => appendDurable(logPath, line),
    presence: fs.existsSync(presPath) ? JSON.parse(fs.readFileSync(presPath, "utf8")) : { bodies: {}, holds: {} },
    savePresence: (p: object) => { fs.mkdirSync(path.dirname(presPath), { recursive: true }); fs.writeFileSync(presPath, JSON.stringify(p)); },
    custody: custodyAt(path.join(root, "keys", "custody.json")),
    ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)),
  });
}

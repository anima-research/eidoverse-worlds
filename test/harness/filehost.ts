// test/harness/filehost.ts — a world on disk: the storage half of the lab's openWorld (the protocol lab's authority.js),
// split out so shared/protocol/authority.js stays pure. Same layout as the lab: <root>/worlds/<name>.jsonl (the log),
// <root>/worlds/<name>.presence.json (the presence plane, a file only because a test process may call once per
// request) and <root>/store/sha256-<hex>.json (blobs, §2.2: named by full hash, stored once, verified on read).
//
// The suites' host only; the running server opens worlds through server/livehost.ts.
import fs from "node:fs";
import path from "node:path";
import { readLog, jcs, sha256 } from "../../shared/protocol/fold.js";
import { worldOf, posAt } from "../../shared/protocol/authority.js";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { SANDBOX } from "../../shared/protocol/sandbox.js";
import { now as hostNow } from "./hostclock.ts";
import { LAB_CATALOGUE, MODELS } from "./labmodels.js";

/** scripts: the sandbox (default: QuickJS, shared/protocol/sandbox.js); null = an authority with none (activations say unavailable).
 *  catalogue / simModels: the models it knows (a suite's world: the lab table, test/harness/labmodels.js, unless it names another). */
export type OpenOpts = { now?: () => number; scripts?: unknown; present?: () => { id: string; at: number[] | null }[]; catalogue?: unknown; simModels?: Record<string, unknown> };

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
    name, entries, getBlob, putBlob, catalogue: opts.catalogue ?? LAB_CATALOGUE, simModels: opts.simModels ?? MODELS,
    now: opts.now ?? hostNow,
    scripts: opts.scripts === undefined ? SANDBOX : opts.scripts, present: opts.present,
    writeLine: (line: string) => appendDurable(logPath, line),
    presence: fs.existsSync(presPath) ? JSON.parse(fs.readFileSync(presPath, "utf8")) : { bodies: {}, holds: {} },
    savePresence: (p: object) => { fs.mkdirSync(path.dirname(presPath), { recursive: true }); fs.writeFileSync(presPath, JSON.stringify(p)); },
    custody: custodyAt(path.join(root, "keys", "custody.json")),
    ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)),
  });
}

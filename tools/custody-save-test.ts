//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/custody-save-test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { custodyAt } from "../server/custody.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  — ${detail}` : ""}`); };
const attempt = (f: () => string | null) => { try { return { key: f() }; } catch (e) { return { threw: (e as Error).message }; } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-save-"));
try {
  for (const [kind, call] of [
    ["sequencer", (c: ReturnType<typeof custodyAt>) => c.sequencer()],
    ["operator", (c: ReturnType<typeof custodyAt>) => c.operator()],
    ["a founder's key", (c: ReturnType<typeof custodyAt>) => c.keyOf("founder-1", true)],
  ] as const) {
    const file = path.join(dir, kind.replace(/\W+/g, "-"), "keys.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const c = custodyAt(file);
    const blocker = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(blocker);
    const first = attempt(() => call(c)), second = attempt(() => call(c));
    check(`${kind}: a call whose save fails throws`, "threw" in first, JSON.stringify(first));
    check(`${kind}: …and the next call hands out no key while the save still fails`, "threw" in second, JSON.stringify(second));
    fs.rmdirSync(blocker);
    const third = attempt(() => call(c)), fourth = attempt(() => call(c));
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const key = "key" in third ? third.key : null;
    check(`${kind}: once the save can succeed, the key returned is the one the file holds`, typeof key === "string" && onDisk.includes(key.slice("ed25519:".length)), JSON.stringify({ third, onDisk: onDisk.slice(0, 120) }));
    check(`${kind}: …and the next call returns the same key`, "key" in fourth && fourth.key === key, JSON.stringify({ third, fourth }));
  }
  const file = path.join(dir, "kept", "keys.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const c = custodyAt(file);
  const sequencer = attempt(() => c.sequencer()), founder = c.keyOf("founder", true);
  const blocker = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(blocker);
  const operator = attempt(() => c.operator()), stillHeld = c.keyOf("founder", false), again = attempt(() => c.sequencer());
  const held = fs.readFileSync(file, "utf8");
  fs.rmdirSync(blocker);
  check("a key already held still answers, without minting, after another key's save fails", founder != null && stillHeld === founder, JSON.stringify({ founder, stillHeld }));
  check("a key already on disk is still handed out after another key's save fails, and the file still holds it",
    "key" in sequencer && "threw" in operator && "key" in again && again.key === sequencer.key && held.includes(String(sequencer.key).slice("ed25519:".length)) && !held.includes('"operator"'),
    JSON.stringify({ sequencer, operator, again, held: held.slice(0, 160) }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`[custody-save-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

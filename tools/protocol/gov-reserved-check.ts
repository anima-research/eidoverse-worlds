// Governance is RESERVED (PROTOCOL §13; review #260, Mica item 8): handoff, quorum, reclaim and rewind are specified but the
// reference server neither writes nor validates `sequencer` entries. A log that holds one may have moved the writer role
// somewhere this server can't check, so the server refuses to serve it, truthfully, instead of folding past it and writing on.
//   bun tools/protocol/gov-reserved-check.ts
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawnSync } from "node:child_process";
import { jcs, readLog } from "../../shared/protocol/fold.js"; import { sha256, sha256Bytes, hexBytes } from "../../shared/protocol/hash.js";
import { openLive } from "../../server/livehost.ts";
const ENGINE = path.resolve(import.meta.dir, "../.."); let pass = 0, fail = 0;
const check = (name: string, ok: unknown, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${info === undefined ? "" : " — " + JSON.stringify(info).slice(0, 300)}`); } };
const W = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "gov-"));
const found = (name: string) => { const r = spawnSync(process.execPath, ["tools/protocol/world.ts", "found", name, "--owner", "u-aaaaaaaaaaaaaaaaaaaaaa", "--title", name], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W }, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return path.join(W, name); };
const step = (prev: string, e: Record<string, unknown>) => { const { head, sig, ...s } = e as any; const b = new Uint8Array(64); b.set(hexBytes(prev), 0); b.set(hexBytes(sha256(jcs(s))), 32); return sha256Bytes(b); };
try {
  const plain = found("plain");
  let ok = true; try { openLive(plain, "plain"); } catch { ok = false; }
  check("G1 (control) a world with no governance entry opens", ok);

  const gov = found("gov"); const log = path.join(gov, "world.jsonl");
  const entries = readLog(fs.readFileSync(log)); const last = entries.at(-1) as any;
  const e: Record<string, unknown> = { world: last.world, kind: "sequencer", actor: "system", verb: "sequencer", body: { key: "ed25519:" + "A".repeat(43), sigs: [{ key: "ed25519:" + "B".repeat(43), v: "C".repeat(86) }] }, ts: last.ts + 1 };
  e.head = step(last.head, e); fs.appendFileSync(log, JSON.stringify(e) + "\n");
  let err = ""; try { openLive(gov, "gov"); } catch (x) { err = String((x as Error)?.message ?? x); }
  check("G2 a world whose log holds a `sequencer` (governance) entry is refused, not served", !!err, { err });
  check("G3 …and the refusal is truthful: it names the entry's seq, says governance is reserved here, and that nothing was changed",
    /seq \d+/.test(err) && /governance/i.test(err) && /reserved/i.test(err) && /nothing (was|is) (changed|written)/i.test(err), { err });
  check("G4 …and the world's files are untouched", readLog(fs.readFileSync(log)).length === entries.length + 1);
} finally { fs.rmSync(W, { recursive: true, force: true }); }
console.log(`[gov-reserved-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

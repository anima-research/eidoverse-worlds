// shared/protocol/sandbox-child.js — a sandbox PROCESS: runs the VM side of activations (sandbox.js vmRun) for an authority, one at
// a time, over line-delimited JSON on two named pipes. It holds no world: every world.* call is a line out
// ({h: <json>}) and a line back (the authority's answer), so reads, writes and recorded inputs stay with the authority
// (sandbox.js makeHost). The authority SIGKILLs this process when an activation passes its deadline: a slow native builtin
// can stop nothing but this process. Started by sandbox.js with EIDO_SANDBOX_CHILD=1 <in fifo> <out fifo>; exits when
// its input closes (the authority went away).
//   in:  {text, input, event, limits, max}      a job        out: {ready: true}   once QuickJS is loaded
//   in:  <json>                                  a host answer      {h: <json>}   a host call
//                                                                   {go: true} on taking a job, then {done: {fuel, ran?, fail?}}
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { vmRun } from "./sandbox.js";

const [inPath, outPath] = process.argv.slice(2);
const out = fs.openSync(outPath, "w"), inp = fs.openSync(inPath, "r");
const buf = Buffer.alloc(1 << 16), sd = new StringDecoder("utf8"); let pending = "";
function readLine() {
  for (;;) { const i = pending.indexOf("\n"); if (i >= 0) { const l = pending.slice(0, i); pending = pending.slice(i + 1); return l; }
    let n; try { n = fs.readSync(inp, buf, 0, buf.length, null); } catch { return null; }
    if (n === 0) return null; pending += sd.write(buf.subarray(0, n)); }
}
function write(obj) { const b = Buffer.from(JSON.stringify(obj) + "\n"); let o = 0; while (o < b.length) o += fs.writeSync(out, b, o); }
// tests only: start slowly (a loaded host), so an authority's bounded wait for a warm process can be exercised
const delay = Number(process.env.EIDO_SANDBOX_TEST_DELAY ?? 0); if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
write({ ready: true });
for (;;) {
  const line = readLine(); if (line === null) process.exit(0);
  let job; try { job = JSON.parse(line); } catch { process.exit(1); }
  write({ go: true }); // "I got it and I'm running": a process the host never scheduled never says this (sandbox.js killAt)
  const call = (q) => { if (q.length > job.max) return JSON.stringify({ err: "that call is too big to pass to the world", name: "WorldError" });
    write({ h: q }); const r = readLine(); if (r === null) process.exit(0); return r; };
  write({ done: vmRun(job.text, job.input, job.event, job.limits, call) });
}

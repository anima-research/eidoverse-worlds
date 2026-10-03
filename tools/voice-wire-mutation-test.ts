// Every seam of the voice-state contract (docs/pose-wire.md "Voice state — who sees it") must be load-bearing: break
// it in place (source rewrite at load, tools/contact-mutation-preload.ts — passed to the scratch sequencer too) and
// the named check in voice-wire-test.ts must go red.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/voice-wire-mutation-test.ts
import { join } from "node:path";
const TEST = "voice-wire-test.ts";
const cases = [
  { name: "the sender drops `hear`", file: "shared/presencewire.js",
    from: "if (typeof v?.hear === 'boolean') o.hear = v.hear;", to: "",
    witness: "a browser peer 1 km away reads mic on, hearing off" },
  { name: "the fence relays non-booleans", file: "server/posecheck.ts",
    from: 'for (const k of ["mic", "hear"]) if (k in p && typeof p[k] !== "boolean") delete p[k];', to: "",
    witness: "a string mic and a numeric hear never reach the peer" },
  { name: "the fence deletes voice state outright", file: "server/posecheck.ts",
    from: 'for (const k of ["mic", "hear"]) if (k in p && typeof p[k] !== "boolean") delete p[k];', to: 'delete p.mic; delete p.hear;',
    witness: "a spectator reads the same" },
  { name: "settledPose remembers voice state for joiners", file: "server/server.ts",
    from: "const { emote: _emote, mic: _mic, hear: _hear, ...still } = pose as Record<string, unknown>;",
    to: "const { emote: _emote, ...still } = pose as Record<string, unknown>;",
    witness: "without mic or hear (the next live frame brings them)" },
  { name: "look drops the voice note", file: "mcpl/agent.ts",
    from: "${winged}${riding}${voiceNote(p.pose)}`);", to: "${winged}${riding}`);",
    witness: "the agent's look says it in words" },
];
async function run(m?: object) {
  const p = Bun.spawn([process.execPath, ...(m ? ["--preload", join(import.meta.dir, "contact-mutation-preload.ts")] : []), join(import.meta.dir, TEST)],
    { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...(m ? { CONTACT_MUTATION: JSON.stringify(m) } : {}) }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}
const base = await run();
if (base.code) throw new Error(`baseline ${TEST} is not green\n${base.out}\n${base.err}`);
console.log(`baseline ${TEST}: green`);
let missed = 0;
for (const c of cases) {
  const r = await run(c);
  const red = r.out.split("\n").filter(l => l.includes("✗"));
  // the sequencer is a child: its own preload announces into sequencer.stderr.log, so only the shared module can
  // prove application from here; a red witness is the proof for the server-side cases
  const applied = c.file.startsWith("server/") || r.err.includes("CONTACT_MUTATION_APPLIED");
  if (!r.code || !applied || !red.some(l => l.includes(c.witness))) {
    missed++;
    console.log(`MISSED ${c.name}: exit ${r.code}, applied ${applied}\n${red.join("\n") || r.out.slice(-1500)}\n${r.err.slice(-800)}`);
  } else console.log(`PASS ${c.name}: ${red.length} check(s) red, including "${c.witness}"`);
}
console.log(`${cases.length - missed}/${cases.length} mutations detected`);
process.exit(missed ? 1 : 0);

//   bun tools/consent-scripts-list-test.ts
if (process.env.__EIDO_TEST_CACHE_OFF !== "1") {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", __EIDO_TEST_CACHE_OFF: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(child.exitCode ?? 1);
}
process.env.WORLD_TOKEN = "";
const { WorldAgent } = await import("../mcpl/agent.ts");
const { scratchSequencer } = await import("./harness.ts");
const { until } = await import("./protocol/wait.ts");

const W = "consent-scripts";
const H = await scratchSequencer(W, { worlds: [W], serverEnv: { SKIP_OPT_SWEEP: "1" } });
const URL = `ws://127.0.0.1:${H.PORT}/ws`;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } };
const agents: any[] = [];
const agent = async (name: string) => { const a: any = new WorldAgent({ url: URL, name, world: W }); agents.push(a); await a.connect(); return a; };
try {
  await agent("sponsor");
  const body = await agent("body");
  const who = await body.request("whois", { name: "sponsor" });
  const sponsor = who?.people?.[0]?.id;
  if (typeof sponsor !== "string") throw new Error(`whois sponsor: ${JSON.stringify(who)}`);
  const table = async () => (await body.request("consent", {}))?.table ?? null;
  for (const [op, entry] of [["allow", `scripts-by:${sponsor}`], ["allow", "script:pad1"], ["block", `scripts-by:${sponsor}`], ["block", "script:pad2"]] as const) {
    const r = await body.request("consent", { [op]: entry });
    const t = await table();
    check(`consent {${op}: "${entry.replace(sponsor, "<sponsor>")}"} through the server reaches the authority, and the body's ${op} list holds it`, r?.ok === true && (t?.[op] ?? []).includes(entry), JSON.stringify({ r, t }));
  }
  for (const op of ["allow", "block"]) {
    const r = await body.request("consent", { [op]: "" });
    check(`consent {${op}: ""} reaches the authority, which refuses its shape`, r?.refused?.code === "shape", JSON.stringify(r));
  }
  const nobody = "u-nobodyhasthisidentity";
  const allow = await body.request("consent", { allow: nobody }), block = await body.request("consent", { block: nobody });
  check("an allow naming no one the server knows is refused gone, and told whois gives the identity of someone who has been here", allow?.refused?.code === "gone" && /whois/.test(allow?.refused?.fix ?? ""), JSON.stringify(allow));
  check("…a block of no one is refused gone with the gate advice", block?.refused?.code === "gone" && /move or touch gate/.test(block?.refused?.fix ?? ""), JSON.stringify(block));
  const guest = await agent("visitor");
  const seen = await body.request("whois", { name: "visitor" });
  const gid = seen?.people?.[0]?.id;
  if (typeof gid !== "string") throw new Error(`whois visitor: ${JSON.stringify(seen)}`);
  check("a guest who is here may be allowed", (await body.request("consent", { allow: gid }))?.ok === true);
  guest.close();
  await until("the guest's visit has ended", async () => (await body.request("whois", { name: "visitor" }))?.people?.every((p: any) => !p.here), { ms: 10_000, step: 100 });
  const left = await body.request("consent", { allow: gid });
  check("a departed guest is refused gone, and told a guest is allowed while they're here, by the identity they have then",
    left?.refused?.code === "gone" && /guest's/.test(left?.refused?.reason ?? "") && /while they're here/.test(left?.refused?.fix ?? "") && !/whois/.test(left?.refused?.fix ?? ""), JSON.stringify(left));
} finally {
  for (const a of agents) { try { a.close(); } catch {} }
  await H.cleanup(failed ? 1 : 0);
}
console.log(`[consent-scripts-list-test] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

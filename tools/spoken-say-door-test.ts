// spoken-say-door-test.ts — the load-bearing receipt for #100 (r4, Antra's B2).
// Drives the ACTUAL advertised MCPL surface (initialize → tools/call "say") against
// an owned scratch sequencer + door, and watches the world socket for what truly
// lands in the log. smoke.ts speaks raw world verbs and voice-wiring reads source —
// neither crosses the changed dispatch; this test exists to fail on unmodified main
// (the valid trio is stripped at exactly this door).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Owned ports: derived from pid so parallel CI runs don't collide; ownership is
// verified by the world's own snapshot handshake below (a foreign listener would
// not speak the join protocol).
const WPORT = 8800 + (process.pid % 150);
const MPORT = WPORT + 150;
const worldsDir = mkdtempSync(join(tmpdir(), "eido-spokensay-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  [" + extra + "]"}`);
  ok ? pass++ : fail++;
};

// Child diagnostics preserved: piped, tails printed on any fatal.
const world = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(WPORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "" },
  stdout: "pipe", stderr: "pipe",
});
const mcpl = Bun.spawn(["bun", "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws` },
  stdout: "pipe", stderr: "pipe",
});
const drain = async (p: ReturnType<typeof Bun.spawn>, name: string) => {
  for (const [label, stream] of [["out", p.stdout], ["err", p.stderr]] as const) {
    const text = await new Response(stream as ReadableStream).text().catch(() => "");
    if (text.trim()) console.log(`--- ${name} ${label} (tail) ---\n${text.split("\n").slice(-15).join("\n")}`);
  }
};

try {
  await sleep(2500);

  // World-side watcher: the ground truth for what reached the log.
  const seen: any[] = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout — is the owned world up?")), 8000);
    watcher.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", world: "commons", id: "watcher", spectate: true }));
  });

  // The advertised MCPL surface, exactly as a schema-driven client would use it.
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=dev-token`);
  const replies = new Map<number, any>();
  let rpcId = 10;
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  host.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id != null) replies.set(m.id, m); };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 8000);
    host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "spokensay-test", version: "0" } } });
    const iv = setInterval(() => { if (replies.has(1)) { clearInterval(iv); clearTimeout(t);
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); res(); } }, 50);
  });
  await sleep(1500);

  const call = async (args: Record<string, unknown>) => {
    const id = ++rpcId;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "say", arguments: args } });
    for (let i = 0; i < 80 && !replies.has(id); i++) await sleep(100);
    return replies.get(id);
  };
  const saysSeen = () => seen.filter((m) => m.type === "log" && m.entry?.verb === "say").map((m) => m.entry);

  // 0. Schema discoverability (B1): the advertised tool declares the trio.
  {
    const id = ++rpcId;
    rpc({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    for (let i = 0; i < 60 && !replies.has(id); i++) await sleep(100);
    const say = replies.get(id)?.result?.tools?.find((t: any) => t.name === "say");
    const props = say?.inputSchema?.properties ?? {};
    check("advertised say schema declares the optional trio (discoverable, not accidental)",
      "spoken" in props && "utt" in props && "t0" in props && !(say.inputSchema.required ?? []).includes("spoken"),
      Object.keys(props).join(","));
    check("schema description disclaims performance-proof (points at the receipt path)",
      /does NOT prove performance|attest/i.test(say?.description ?? ""), (say?.description ?? "").slice(0, 80));
  }

  // 1. Valid trio through the advertised tool → ONE durable say, trio preserved.
  //    THE FAIL-ON-MAIN VECTOR: unmodified main's dispatch rebuilds {text} bare,
  //    so this arrives with the trio stripped and the assertion fails.
  {
    seen.length = 0;
    const r = await call({ text: "performed line", spoken: true, utt: 3, t0: 1754980000000 });
    await sleep(700);
    const says = saysSeen();
    check("valid trio: exactly one durable say lands", says.length === 1, `${says.length} says`);
    const a = (says[0]?.args ?? {}) as Record<string, unknown>;
    check("valid trio: spoken/utt survive the door to the log (fail-on-main vector)",
      a.spoken === true && a.utt === 3, JSON.stringify(a));
    check("valid trio: the call reports success", !r?.result?.isError, JSON.stringify(r?.result)?.slice(0, 100));
  }

  // 2. Plain say still works, carries no trio residue.
  {
    seen.length = 0;
    await call({ text: "just words" });
    await sleep(700);
    const says = saysSeen();
    const a = (says[0]?.args ?? {}) as Record<string, unknown>;
    check("plain say: lands once, no trio keys", says.length === 1 && !("spoken" in a) && !("utt" in a) && !("t0" in a), JSON.stringify(a));
  }

  // 3. Malformed / partial trio → loud refusal, ZERO says.
  {
    seen.length = 0;
    const r = await call({ text: "should not land", spoken: true, utt: "nope" });
    await sleep(700);
    check("malformed trio: loud refusal in the tool result",
      /refused|trio/i.test(JSON.stringify(r?.result ?? {})), JSON.stringify(r?.result)?.slice(0, 120));
    check("malformed trio: zero say entries created", saysSeen().length === 0, `${saysSeen().length} says`);
    seen.length = 0;
    await call({ text: "partial should not land", utt: 5 });   // partner without spoken
    await sleep(700);
    check("partial trio (utt without spoken): refused, zero says", saysSeen().length === 0, `${saysSeen().length}`);
    // COERCION vectors (adversarial review): Number(null)===0, Number(true)===1
    // used to SNEAK a fabricated utt/t0 past the guard. Type-exact validation
    // must refuse these outright — a fabricated utterance is worse than a
    // refused one.
    for (const bad of [
      { text: "utt null", spoken: true, utt: null },
      { text: "utt bool", spoken: true, utt: true },
      { text: "utt string", spoken: true, utt: "5" },
      { text: "t0 null", spoken: true, utt: 1, t0: null },
      { text: "utt negative", spoken: true, utt: -1 },
      { text: "t0 infinite", spoken: true, utt: 1, t0: Infinity },
    ]) {
      seen.length = 0;
      const rr = await call(bad as Record<string, unknown>);
      await sleep(400);
      // The security-relevant assertion: a coerced value must NEVER become a
      // durable say. (Number(null)===0 / Number(true)===1 used to fabricate
      // an utterance; type-exact validation refuses instead.)
      check(`coercion: ${bad.text} → refused loudly, ZERO fabricated says`,
        /refused|trio/i.test(JSON.stringify(rr?.result ?? {})) && saysSeen().length === 0,
        `says=${saysSeen().length} reply=${JSON.stringify(rr?.result)?.slice(0, 80)}`);
    }
  }

  // 4. Unrelated extra key never reaches the log.
  {
    seen.length = 0;
    await call({ text: "clean", glitter: "maximal", spoken: true, utt: 9 });
    await sleep(700);
    const a = (saysSeen()[0]?.args ?? {}) as Record<string, unknown>;
    check("unrelated extra key stays at the door", !("glitter" in a) && a.utt === 9, JSON.stringify(a));
  }

  watcher.close(); host.close();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
  world.kill(); mcpl.kill();
  await drain(world, "world"); await drain(mcpl, "mcpl");
} finally {
  world.kill(); mcpl.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

// spoken-say-door-test.ts — the load-bearing receipt for #100 (r4, Antra's B2).
// Drives the ACTUAL advertised MCPL surface (initialize → tools/call "say") against
// an owned scratch sequencer + door, and watches the world socket for what truly
// lands in the log: a tool dispatch that rebuilt {text} bare would strip the valid
// trio at exactly this door, and only a call through the door can see that.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort, saysIn, scratchState } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const WPORT = freePort(8800), MPORT = freePort(11800);
const NONCE = `spokensay-${process.pid}-${Date.now()}`;   // the door's /healthz echoes it: the responder is our child
const worldsDir = mkdtempSync(join(tmpdir(), "eido-spokensay-"));
foundWorlds(worldsDir, ["commons"]);   // joining never founds a world
// a scratch enrolment both doors honour ("dev-token" is in the tracked example, which the registry refuses anywhere)
const tokensPath = join(worldsDir, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "spokensay-labtok": { id: "claude", name: "Claude", world: "commons" } }));
const S = suite("spoken-say-door");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

// Child diagnostics preserved: piped, tails printed on any fatal.
const world = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, ...scratchState(), PORT: String(WPORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: tokensPath },
  stdout: "pipe", stderr: "pipe",
});
const mcpl = Bun.spawn(["bun", "mcpl/net-server.ts"], {
  env: { ...process.env, MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`, MCPL_TOKENS: tokensPath, MCPL_STATE: tokensPath + ".state.json", MCPL_INSTANCE_NONCE: NONCE },
  stdout: "pipe", stderr: "pipe",
});
const drain = async (p: ReturnType<typeof Bun.spawn>, name: string) => {
  for (const [label, stream] of [["out", p.stdout], ["err", p.stderr]] as const) {
    const text = await new Response(stream as ReadableStream).text().catch(() => "");
    if (text.trim()) console.log(`--- ${name} ${label} (tail) ---\n${text.split("\n").slice(-15).join("\n")}`);
  }
};

try {
  await until("the owned world answers", async () => (await fetch(`http://127.0.0.1:${WPORT}/worlds`)).status < 500, { ms: 20_000 });
  await until("the owned door answers /healthz with our nonce", async () => (await (await fetch(`http://127.0.0.1:${MPORT}/healthz`)).text()).includes(NONCE), { ms: 20_000 });

  // World-side watcher: the ground truth for what reached the log.
  const seen: any[] = [];
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout — is the owned world up?")), 8000);
    watcher.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", id: "watcher", spectate: true, replica: true }));
  });

  // The advertised MCPL surface, exactly as a schema-driven client would use it.
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=spokensay-labtok`);
  const replies = new Map<number, any>();
  let rpcId = 10;
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  host.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id != null) replies.set(m.id, m); };
  host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "spokensay-test", version: "0" } } });
  await until("mcpl answers initialize", () => replies.has(1));
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });   // the door joins the world next; requests queue behind the join

  const call = async (args: Record<string, unknown>) => {
    const id = ++rpcId;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "say", arguments: args } });
    return until(`the door answers tools/call ${id}`, () => replies.get(id));
  };
  // A plain say through the same door after the calls under test: the sequencer orders one actor's says, so once it
  // lands, anything those calls put in the log is in `seen`. Returns the says before it.
  let fences = 0;
  const landed = async () => {
    const tag = `fence ${++fences}`;
    await call({ text: tag });
    await until(`the fence say "${tag}" lands`, () => saysSeen().some((x) => x.args?.text === tag));
    return saysSeen().filter((x) => !/^fence \d+$/.test(String(x.args?.text)));
  };
  // what reached the log: the `say` entries of the log stream ({actor: display name, args: the say body})
  const saysSeen = () => saysIn(seen).map((x) => ({ actor: x.actor, seq: x.seq, args: x.body }));

  // 0. Schema discoverability (B1): the advertised tool declares the trio.
  {
    const id = ++rpcId;
    rpc({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    const say = (await until("the door answers tools/list", () => replies.get(id)))?.result?.tools?.find((t: any) => t.name === "say");
    const props = say?.inputSchema?.properties ?? {};
    check("advertised say schema declares the optional trio (discoverable, not accidental)",
      "spoken" in props && "utt" in props && "t0" in props && !(say.inputSchema.required ?? []).includes("spoken"),
      Object.keys(props).join(","));
    check("schema description disclaims performance-proof (points at the receipt path)",
      /does NOT prove performance|attest/i.test(say?.description ?? ""), (say?.description ?? "").slice(0, 80));
  }

  // 1. Valid trio through the advertised tool → ONE durable say, trio preserved.
  //    The vector: a dispatch that rebuilds {text} bare delivers this with
  //    the trio stripped, and the assertion fails.
  {
    seen.length = 0;
    // A deliberately OLD t0 (2025): the authoritative server clamps it up into
    // the accepted window [now - 5min, now]. Asserting the clamp proves the say
    // reached the real sequencer, not merely that the door preserved two fields.
    const sentT0 = 1754980000000;
    const before = Date.now();
    const r = await call({ text: "performed line", spoken: true, utt: 3, t0: sentT0 });
    const says = await landed();
    const after = Date.now();
    check("valid trio: exactly one durable say lands", says.length === 1, `${says.length} says`);
    const a = (says[0]?.args ?? {}) as Record<string, unknown>;
    check("valid trio: spoken/utt survive the door to the log (fail-on-main vector)",
      a.spoken === true && a.utt === 3, JSON.stringify(a));
    // t0 (item 2, r6): finite, clamped server-side into the 5-minute window
    // ending at arrival — NOT the stale value we sent. Proves the authoritative
    // sequencer, not a local pass-through, produced it.
    const t0 = a.t0 as number;
    const MAX_UTTER_MS = 300_000;
    check("valid trio: durable t0 is finite and server-clamped into the 5-min window (not the raw stale value)",
      typeof t0 === "number" && Number.isFinite(t0) && t0 !== sentT0 &&
      t0 >= before - MAX_UTTER_MS - 2000 && t0 <= after,
      `t0=${t0} sent=${sentT0} window=[${before - MAX_UTTER_MS}, ${after}]`);
    check("valid trio: the call reports success", !r?.result?.isError, JSON.stringify(r?.result)?.slice(0, 100));
  }

  // 2. Plain say still works, carries no trio residue.
  {
    seen.length = 0;
    await call({ text: "just words" });
    const says = await landed();
    const a = (says[0]?.args ?? {}) as Record<string, unknown>;
    check("plain say: lands once, no trio keys", says.length === 1 && !("spoken" in a) && !("utt" in a) && !("t0" in a), JSON.stringify(a));
  }

  // 3. Malformed / partial trio → loud refusal, ZERO says.
  {
    seen.length = 0;
    const r = await call({ text: "should not land", spoken: true, utt: "nope" });
    const rp = await call({ text: "partial should not land", utt: 5 });   // partner without spoken
    const says = await landed();
    check("malformed trio: loud refusal in the tool result",
      /refused|trio/i.test(JSON.stringify(r?.result ?? {})), JSON.stringify(r?.result)?.slice(0, 120));
    // machine-legible failure (item 1, r6): a schema client that inspects
    // result.isError must see the refusal AS an error, not a successful say.
    check("malformed trio: result.isError === true (not just failure-shaped prose)",
      r?.result?.isError === true, JSON.stringify(r?.result)?.slice(0, 120));
    check("malformed trio: zero say entries created", says.length === 0, JSON.stringify(says));
    check("partial trio (utt without spoken): refused (result.isError), zero says",
      rp?.result?.isError === true && says.length === 0, JSON.stringify({ result: rp?.result, says })?.slice(0, 160));
    // COERCION vectors: Number(null)===0 and Number(true)===1 would sneak a
    // fabricated utt/t0 past a coercing guard. Type-exact validation must
    // refuse these outright — a fabricated utterance is worse than a refused one.
    const bads = [
      { text: "utt null", spoken: true, utt: null },
      { text: "utt bool", spoken: true, utt: true },
      { text: "utt string", spoken: true, utt: "5" },
      { text: "t0 null", spoken: true, utt: 1, t0: null },
      { text: "utt negative", spoken: true, utt: -1 },
      { text: "t0 infinite", spoken: true, utt: 1, t0: Infinity },
    ];
    seen.length = 0;
    const replied = [];
    for (const bad of bads) replied.push(await call(bad as Record<string, unknown>));
    const coerced = await landed();
    for (const [i, bad] of bads.entries()) {
      const rr = replied[i], n = coerced.filter((x) => x.args?.text === bad.text).length;
      // The security-relevant assertion: a coerced value must NEVER become a
      // durable say.
      check(`coercion: ${bad.text} → refused loudly (isError), ZERO fabricated says`,
        rr?.result?.isError === true && n === 0,
        `says=${n} isError=${rr?.result?.isError} reply=${JSON.stringify(rr?.result)?.slice(0, 80)}`);
    }
    check("coercion: no say of any text was created", coerced.length === 0, JSON.stringify(coerced));
  }

  // 4. Unrelated extra key never reaches the log.
  {
    seen.length = 0;
    await call({ text: "clean", glitter: "maximal", spoken: true, utt: 9 });
    const a = ((await landed())[0]?.args ?? {}) as Record<string, unknown>;
    check("unrelated extra key stays at the door", !("glitter" in a) && a.utt === 9, JSON.stringify(a));
  }

  // 5. spoken:false is an ORDINARY say, not an error (Opus-5 review): a voice
  //    leg doing `spoken: leg.isActive` must not go mute+error when idle.
  {
    seen.length = 0;
    const r = await call({ text: "not performed this time", spoken: false });
    const says = await landed();
    const a = (says[0]?.args ?? {}) as Record<string, unknown>;
    check("spoken:false → ordinary say lands (not refused)",
      says.length === 1 && a.text === "not performed this time" && !("spoken" in a) && !r?.result?.isError,
      `says=${says.length} isError=${r?.result?.isError} a=${JSON.stringify(a)}`);
  }

  // 6. Missing/empty text is refused loudly — never a fabricated spoken say of
  //    "undefined" (Opus-5 review: text is required; a schema is not a boundary).
  {
    seen.length = 0;
    const r = await call({ spoken: true, utt: 7, t0: Date.now() } as Record<string, unknown>);
    const r2 = await call({ text: "" });
    const says = await landed();
    check("missing text with a valid trio → isError, zero says (no 'undefined' body)",
      r?.result?.isError === true && says.length === 0,
      `says=${JSON.stringify(says)} isError=${r?.result?.isError}`);
    check("empty text → isError, zero says",
      r2?.result?.isError === true && says.length === 0, `says=${JSON.stringify(says)}`);
  }

  watcher.close(); host.close();
} catch (e) {
  S.fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
  world.kill(); mcpl.kill();
  await drain(world, "world"); await drain(mcpl, "mcpl");
} finally {
  world.kill(); mcpl.kill();
}
S.done();

// consent-replay-test: the switch an agent replays on arrival is the one it holds when the authority's answer comes back,
// so a switch set while that read is out isn't overwritten by the old one (house 6340433633, on b1ea081b)
import { WorldAgent } from "../mcpl/agent.ts";
let pass = 0, fail = 0; const ok = (c: boolean, n: string, info?: unknown) => { if (c) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`, info === undefined ? "" : JSON.stringify(info)); } };
function agent(held: string | null, during?: (ag: any) => void) {
  const ag = new WorldAgent({ name: "replay" }) as any; const sent: any[] = [];
  ag.request = async (verb: string, args: any) => { sent.push([verb, args]);
    if (verb === "consent" && args.switch === undefined) { await new Promise((r) => setTimeout(r, 20)); during?.(ag); return { ok: true, table: { switch: held } }; }
    if (verb === "consent") { held = args.switch; return { ok: true }; } return { ok: false }; };
  return { ag, sent, held: () => held };
}
{ const t = agent("accept"); t.ag.consentSwitch = "refuse"; await t.ag.replaySwitch();
  ok(t.held() === "refuse" && t.sent.length === 2, "R1 mine differs from what the authority holds: mine is sent", t.sent); }
{ const t = agent("refuse"); t.ag.consentSwitch = "refuse"; await t.ag.replaySwitch();
  ok(t.sent.length === 1, "R2 the same: only the read is sent", t.sent); }
{ const t = agent(null); await t.ag.replaySwitch();
  ok(t.sent.length === 0, "R3 never chosen: nothing is sent, the world's default stands", t.sent); }
// R4: the body sets ask while the read is out (that set lands first, so the authority answers ask): the replay must not
// send the refuse it started with
{ const t = agent("refuse"); t.ag.consentSwitch = "refuse";
  const p = t.ag.replaySwitch(); t.ag.consentSwitch = "ask";   // noteConsent from the concurrent set
  const tt = t as any; await new Promise((r) => setTimeout(r, 5)); tt.ag.request("consent", { switch: "ask" });
  await p;
  ok(t.held() === "ask", "R4 a switch set while the replay's read is out stands: the old one isn't sent after it", { held: t.held(), sent: t.sent }); }
console.log(`[consent-replay-test] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

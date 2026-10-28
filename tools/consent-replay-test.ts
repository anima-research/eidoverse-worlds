// consent-replay-test: what an agent chose with `consent` (its two gates, the people it listed or unlisted) is sent again on
// arrival where the authority's table differs, and what it holds when the read comes back is what is sent, so a change made
// while that read is out isn't overwritten by the old one (house 6340433633, on b1ea081b; R 10-28: the same model as a person)
import { WorldAgent } from "../mcpl/agent.ts";
let pass = 0, fail = 0; const ok = (c: boolean, n: string, info?: unknown) => { if (c) { pass++; console.log(`ok   ${n}`); } else { fail++; console.log(`FAIL ${n}`, info === undefined ? "" : JSON.stringify(info)); } };
type Held = { move: boolean | null; touch: boolean | null; allow: string[]; block: string[] };
function agent(held: Held, during?: (ag: any) => void) {
  const ag = new WorldAgent({ name: "replay" }) as any; const sent: any[] = [];
  ag.request = async (verb: string, args: any) => { sent.push([verb, args]);
    if (verb !== "consent") return { ok: false };
    if (!Object.keys(args).length) { await new Promise((r) => setTimeout(r, 20)); during?.(ag); return { ok: true, table: JSON.parse(JSON.stringify(held)) }; }
    for (const g of ["move", "touch"] as const) if (typeof args[g] === "boolean") held[g] = args[g];
    for (const op of ["allow", "block", "unlist"]) if (typeof args[op] === "string") { const w = args[op]; held.allow = held.allow.filter((x) => x !== w); held.block = held.block.filter((x) => x !== w); if (op !== "unlist") held[op as "allow" | "block"].push(w); }
    ag.noteConsent?.(args); return { ok: true }; };
  return { ag, sent, held: () => held };
}
const H = (o: Partial<Held> = {}): Held => ({ move: null, touch: null, allow: [], block: [], ...o });
{ const t = agent(H({ move: true })); t.ag.noteConsent({ move: false }); t.ag.noteConsent({ touch: true }); await t.ag.replayConsent();
  ok(t.held().move === false && t.held().touch === true && t.sent.length === 2, "R1 gates it chose that differ from the authority's are sent, in one request", t.sent); }
{ const t = agent(H({ move: false })); t.ag.noteConsent({ move: false }); await t.ag.replayConsent();
  ok(t.sent.length === 1, "R2 the same: only the read is sent", t.sent); }
{ const t = agent(H()); await t.ag.replayConsent();
  ok(t.sent.length === 0, "R3 never chosen: nothing is sent, the world's default stands", t.sent); }
{ const t = agent(H({ allow: ["u-old"] })); t.ag.noteConsent({ allow: "u-wren" }); t.ag.noteConsent({ block: "u-kit" }); t.ag.noteConsent({ unlist: "u-old" }); await t.ag.replayConsent();
  ok(JSON.stringify(t.held().allow) === '["u-wren"]' && JSON.stringify(t.held().block) === '["u-kit"]',
    "R5 the people it listed are listed again, and one it unlisted is taken off (an agent's lists are the same as a person's)", { held: t.held(), sent: t.sent }); }
{ const t = agent(H()); t.ag.noteConsent({ allow: "u-wren" }); t.ag.noteConsent({ block: "u-wren" }); await t.ag.replayConsent();
  ok(JSON.stringify(t.held().block) === '["u-wren"]' && !t.held().allow.length, "R6 the last list it chose for a person is the one sent (block after allow)", t.held()); }
// R4: the body turns move on while the read is out (that set lands first, so the authority answers on): the replay must not
// send the off it started with
{ const t = agent(H({ move: false })); t.ag.noteConsent({ move: false });
  const p = t.ag.replayConsent(); const tt = t as any; await new Promise((r) => setTimeout(r, 5)); await tt.ag.request("consent", { move: true });
  await p; ok(t.held().move === true, "R4 a gate set while the replay's read is out stands: the old one isn't sent after it", { held: t.held(), sent: t.sent }); }
// R7 (parity with main): a refused act on the agent's body is said to it as an act event, naming who and the gate
{ const ag = new WorldAgent({ name: "told" }) as any; const ev: any[] = []; ag.onEvent = (e: any) => ev.push(e); ag.actorIds.set("Wren", "u-wren");
  ag.bodyInbox([{ type: "body-refused", from: "u-wren", gate: "move", class: "shove" }, { type: "body-refused", from: "u-kit", gate: null, class: "pose" }]);
  ok(ev.length === 2 && ev[0].kind === "act" && ev[0].who === "u-wren" && /Wren tried to move you/.test(ev[0].text) && /move gate is off/.test(ev[0].text) && /block list/.test(ev[1].text) && ag.inbox.length === 2,
    "R7 a refused act on the agent's body is an event in its inbox: who tried, and its move gate (or its block list) turned it away", ev); }
console.log(`[consent-replay-test] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

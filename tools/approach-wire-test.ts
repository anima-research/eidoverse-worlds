// approach-wire-test — the delivery seam gets an executable receipt.
//
// PR #145's review (antra, 2026-08-26): "The two product decisions exist only
// as source assertions, not executable transport receipts." The decisions:
// approach is `chat:addressed` + `mentioned:true`; depart is `chat:ambient`,
// lacks `mentioned`. They lived in net-server.ts's onPing closure, which a
// test cannot import (the module listens at load). The mapping is now the
// pure ping-wire.ts, consumed by both servers and held to account here —
// alongside the pending_pings line rendering, and the disconnect rule:
// a leave after a delivered approach is ONE presence exit, never a synthetic
// "walked away".
//
// Run: bun tools/approach-wire-test.ts

// The presence gate holds a leave for EW_LEAVE_HOLD_SEC (45s default) to
// collapse reconnect flaps. Set to zero BEFORE the modules load — the gate
// reads its env at import — so the exit lands on the next tick.
process.env.EW_LEAVE_HOLD_SEC = "0";

const { pingLine, pingDelivery } = await import("../mcpl/ping-wire.ts");
const { CHAT, EIDO } = await import("../mcpl/declaration.ts");
const { WorldAgent } = await import("../mcpl/agent.ts");
const { APPROACH_DWELL_MS } = await import("../mcpl/denoise.ts");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const P = (kind: any, text?: string) => ({ ts: 1, kind, who: "digi", ...(text != null ? { text } : {}) });

// ---------------------------------------------------------------- the channel frame: approach addresses, depart does not

{
  const d = pingDelivery(P("approach"), false)!;
  check("approach is chat:addressed", d.tags.includes(CHAT.addressed), JSON.stringify(d.tags));
  check("approach carries its event tag", d.tags.includes(EIDO.approach));
  check("approach is mentioned:true (the shim two hosts still route on)", d.mentioned === true);
  check("approach is NOT ambient — addressed wins", !d.tags.includes(CHAT.ambient), JSON.stringify(d.tags));
  check("approach wording", d.text === "* digi walked up to you", d.text);
}

{
  const d = pingDelivery(P("depart", "walked away"), false)!;
  check("depart is chat:ambient", d.tags.includes(CHAT.ambient), JSON.stringify(d.tags));
  check("depart carries its event tag", d.tags.includes(EIDO.depart));
  check("depart is NOT addressed — being left is not being addressed", !d.tags.includes(CHAT.addressed), JSON.stringify(d.tags));
  check("depart never sets mentioned", d.mentioned === undefined);
  check("depart renders the agent's own who-moved text", d.text === "* digi walked away", d.text);
  const n = pingDelivery(P("depart", "is no longer nearby"), false)!;
  check("...including the actor-neutral sentence, verbatim", n.text === "* digi is no longer nearby", n.text);
}

{
  const r = pingDelivery(P("reach", "reaches toward your shoulder_l (right hand)"), false)!;
  const t = pingDelivery(P("touch", "touches your head_top (left hand)"), true)!;
  check("reach is addressed + mentioned, worded by the agent",
    r.tags.includes(CHAT.addressed) && r.tags.includes(EIDO.reach) && r.mentioned === true
      && r.text === "* digi reaches toward your shoulder_l (right hand)", JSON.stringify(r));
  check("touch is addressed + mentioned, worded by the agent",
    t.tags.includes(CHAT.addressed) && t.tags.includes(EIDO.touch) && t.mentioned === true, JSON.stringify(t));
  check("a ping from an agent-driven body says so", t.tags.includes(CHAT.fromAgent), JSON.stringify(t.tags));
  check("...and a browser body does not (no evidence, no claim)", !r.tags.includes(CHAT.fromAgent), JSON.stringify(r.tags));
}

{
  check("mention pings ride the say event, never this path", pingDelivery(P("mention", "hi"), false) === null);
  check("whisper pings ride their own delivery, never this path", pingDelivery(P("whisper", "psst"), false) === null);
}

// ---------------------------------------------------------------- the pending_pings lines

{
  check("pending: mention", pingLine(P("mention", "come look at this")) === "@ digi: come look at this");
  check("pending: whisper", pingLine(P("whisper", "psst")) === "@ digi whispers: psst");
  check("pending: approach", pingLine(P("approach")) === "≈ digi walked up to you");
  check("pending: depart, agent-worded", pingLine(P("depart", "walked away")) === "≈ digi walked away");
  check("pending: depart, actor-neutral", pingLine(P("depart", "is no longer nearby")) === "≈ digi is no longer nearby");
  check("pending: touch keeps its own phrasing",
    pingLine(P("touch", "touches your head_top (left hand)")) === "≈ digi touches your head_top (left hand)");
}

// ---------------------------------------------------------------- disconnect after a delivered approach: one exit, one line

{
  const ag = new WorldAgent({ name: "wiretest" }) as any;
  ag.pos = { x: 0, y: 0, z: 0 };
  const T0 = Date.now();
  const pings: any[] = []; const events: any[] = [];
  ag.onPing = (p: any) => pings.push(p);
  ag.onEvent = (e: any) => events.push(e);
  const at = (t: number, x: number, z: number) =>
    ag.notePose("digi", { p: [x, 0, z], yaw: 0, speed: 0, clip: "walk" }, T0 + t);

  at(0, 10, 0);
  at(100, 1.5, 0);
  for (let i = 0; i <= APPROACH_DWELL_MS + 400; i += 200) at(100 + i, 1.5, 0);
  check("(setup) approach delivered", pings.filter((p) => p.kind === "approach").length === 1);

  ag.noteLeave("digi");                    // the `leave` message path, sans socket
  await new Promise((r) => setTimeout(r, 30));

  check("disconnect yields one presence exit",
    events.filter((e) => e.kind === "leave" && e.who === "digi").length === 1, JSON.stringify(events));
  check("...and no synthetic depart — one exit, one line",
    pings.filter((p) => p.kind === "depart").length === 0, JSON.stringify(pings));
  check("the re-arm state went with them (a return visit starts clean)",
    !ag.nearArmed.has("digi") && !ag.approachOpen.has("digi") && !ag.approachPending.has("digi"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

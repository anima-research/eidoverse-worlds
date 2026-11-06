// event-wire-test — the tag set each world event goes out with, held to the
// kind facet (MCPL RFC-001 rev 3): a notice nobody sent carries chat:system
// beside chat:ambient, so a host never puts an agent's plain speech in the
// world because a forecast line arrived there last; speech never does.
//
// Run: bun tools/event-wire-test.ts

const { eventTags, catchupHeaderTags, catchupReplayTags } = await import("../mcpl/event-wire.ts");
const { CHAT, EIDO } = await import("../mcpl/declaration.ts");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const has = (t: string[], tag: string) => t.includes(tag);
const show = (t: string[]) => JSON.stringify(t);

// ---------------------------------------------------------------- notices: nobody spoke
for (const [kind, own] of [
  ["weather", EIDO.weather],
  ["world-change", EIDO.worldChange],
  ["arrive", EIDO.presence],
  ["leave", EIDO.presence],
  ["activity", EIDO.activityDigest],
] as const) {
  const t = eventTags(kind, { fromAgent: false });
  check(`${kind} is a chat:system notice`, has(t, CHAT.system), show(t));
  check(`${kind} keeps chat:ambient, so ambient wake rules still match`, has(t, CHAT.ambient), show(t));
  check(`${kind} carries its own tag`, has(t, own), show(t));
  check(`${kind} is not addressed`, !has(t, CHAT.addressed), show(t));
}
check("world-change also names the emitter", has(eventTags("world-change", { fromAgent: false }), EIDO.particles));
check("an agent's arrival says it was an agent",
  has(eventTags("arrive", { fromAgent: true }), CHAT.fromAgent));

{
  const h = catchupHeaderTags();
  check("the catch-up header is a notice", has(h, CHAT.system) && has(h, CHAT.ambient) && has(h, EIDO.catchup), show(h));
  const r = catchupReplayTags();
  check("a replayed mention keeps its addressing and is NOT a notice",
    has(r, CHAT.mention) && has(r, CHAT.addressed) && has(r, EIDO.catchup) && !has(r, CHAT.system), show(r));
}

// ---------------------------------------------------------------- people: someone did something
{
  const t = eventTags("act", { fromAgent: false });
  check("act is ambient", has(t, CHAT.ambient), show(t));
  check("act is not a notice: someone did it", !has(t, CHAT.system), show(t));
}
{
  const overheard = eventTags("say", { fromAgent: false });
  check("overheard speech is ambient, not a notice", has(overheard, CHAT.ambient) && !has(overheard, CHAT.system), show(overheard));
  const named = eventTags("say", { fromAgent: true, mention: true });
  check("speech that names you is addressed, neither ambient nor a notice",
    has(named, CHAT.mention) && has(named, CHAT.addressed) && !has(named, CHAT.ambient) && !has(named, CHAT.system), show(named));
  check("...and says an agent spoke it", has(named, CHAT.fromAgent), show(named));
  const w = eventTags("whisper", { fromAgent: false });
  check("a whisper is a DM: addressed + private, not a notice",
    has(w, CHAT.dm) && has(w, CHAT.private) && has(w, CHAT.addressed) && has(w, EIDO.whisper) && !has(w, CHAT.system), show(w));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

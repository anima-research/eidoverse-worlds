// shared/v4/refusal.js — how a door refusal reads, in one place, so a person in edit mode and an agent calling a tool
// see the same words for the same refusal (PARITY: "refusals show the same text the agents get"). The door's reply is
// {ok: false, refused: {code, reason, teach, …}}; `what` names the request ("place", "undo", "move crate-1").
export function refusalText(what, reply) {
  const r = reply?.refused ?? {};
  return `${what} refused by the door (${r.code ?? "refused"}): ${r.reason ?? ""}${r.teach ? ` — ${r.teach}` : ""}`;
}

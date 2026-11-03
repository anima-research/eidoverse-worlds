// shared/oldformat.js — what a world saved in an older format is called, on every surface (the join refusal, the splash, agents).
// The upgrade is a server operator's or the world's owner's (docs/TRANSLATING-OLD-WORLDS.md, "Upgrading from the browser").
export const OLD_FORMAT_DOC = "docs/TRANSLATING-OLD-WORLDS.md";
export const OLD_FORMAT_SPLASH = "This world was saved by an older version of the engine. It needs a one-time upgrade before anyone can enter.";
/** For someone who may not upgrade it (R 10-28): the server's runner has a way in (server/setup.ts), everyone else asks. */
export const IF_YOU_RUN_IT = "If you run this server, open the setup link printed in its console (or add your account to SERVER_OPERATORS). Otherwise ask whoever runs it.";
/** The same for an agent, whose tools have no setup link and no world-upgrade (mcpl/agent.ts): ask, with the doc. */
export const AGENT_ASKS = "Ask them: the operator upgrades it from the server, the owner from the browser.";

/** An agent's words for a refused old-format join (`refused` as the join's error carries it). */
export function oldFormatWords(refused, world = "this world") {
  const who = refused?.may ? `You ${refused.operator ? "are this server's operator" : "are recognised as this world's owner"}: upgrade it from the server (world-upgrade-review, then world-upgrade with the reviewed hash: a verified backup first) or from the browser; an agent's tools can't.`
    : refused?.upgrade === "operator-cli" ? "The server's operator upgrades it from the command line (it must be re-translated from its original log)."
    : `Only this server's operator${refused?.upgrade === "operator-or-owner" ? " or the world's owner (verified by their account)" : ""} can upgrade it. ${AGENT_ASKS}`;
  return `"${world}" was saved by an older version of the engine and needs a one-time upgrade before anyone can enter. ${who} How: ${refused?.doc ?? OLD_FORMAT_DOC}`;
}

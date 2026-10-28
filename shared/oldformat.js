// shared/oldformat.js — what a world saved in an older format is called, on every surface (the join refusal, the splash, agents).
// The upgrade is the server operator's (docs/TRANSLATING-OLD-WORLDS.md, "Upgrading from the browser").
export const OLD_FORMAT_DOC = "docs/TRANSLATING-OLD-WORLDS.md";
export const OLD_FORMAT_SPLASH = "This world was saved by an older version of the engine. It needs a one-time upgrade before anyone can enter.";
export const ASK_OPERATOR = "Only this server's operator can upgrade it: ask the server's operator.";

/** An agent's words for a refused old-format join (`refused` as the join's error carries it). */
export function oldFormatWords(refused, world = "this world") {
  const who = refused?.operator ? "You are this server's operator: world-upgrade-review, then world-upgrade with the reviewed hash, upgrades it (a verified backup first)."
    : refused?.upgrade === "operator-cli" ? "The server's operator upgrades it from the command line (it must be re-translated from its original log)."
    : ASK_OPERATOR;
  return `"${world}" was saved by an older version of the engine and needs a one-time upgrade before anyone can enter. ${who} How: ${refused?.doc ?? OLD_FORMAT_DOC}`;
}

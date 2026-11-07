// shared/protocol/hello.js — the join's global hello and its two refusals (docs/DESIGN-log-vocabulary.md §F F-3). Pure: the server
// validates the hello before any world lookup, and compares features only after access is granted; neither refusal names a world.
import { DIALECT, VERSION } from "./fold.js";
import { checkRequires, KNOWN_FEATURES } from "./features.js";

/** What this reader speaks: the `need` an update-required refusal repeats. */
export const NEED = Object.freeze({ dialect: DIALECT, v: VERSION });
const HELLO_KEYS = new Set(["dialect", "v", "features"]);

/** {dialect, v, features}, exactly: null when this server speaks it, else the update-required refusal (no legacy default; a
 *  stray key, `minor` included, is no hello this server reads). */
export function checkHello(hello, need = NEED) {
  const refused = () => ({ type: "refused", code: "update-required", need: { dialect: need.dialect, v: need.v } });
  if (!hello || typeof hello !== "object" || Array.isArray(hello)) return refused();
  if (hello.dialect !== need.dialect || hello.v !== need.v || Object.keys(hello).some((k) => !HELLO_KEYS.has(k))) return refused();
  if (checkRequires(hello.features, "features")) return refused();
  return null;
}

/** The ids `requires` names that `features` lacks: null when none, else the unsupported-feature refusal. */
export function missingFeatures(requires, features) {
  const have = new Set(features ?? []); const need = (requires ?? []).filter((id) => !have.has(id));
  return need.length ? { type: "refused", code: "unsupported-feature", need } : null;
}

/** The hello every joiner sends: what this reader speaks and the features it implements. */
export const helloOf = () => ({ ...NEED, features: [...KNOWN_FEATURES].sort() });

/** The authoritative version line a snapshot repeats. */
export const versionLine = (requires) => ({ dialect: NEED.dialect, v: NEED.v, requires: [...(requires ?? [])] });

/** A hello refusal ({type: "refused", code, need}) in words a person or an agent reads; it names no world. */
export function refusalWords(msg) {
  const n = msg?.need;
  if (msg?.code === "update-required") return `this server speaks ${n?.dialect ?? "another dialect"} v${n?.v ?? "?"}, which this client doesn't: update the client`;
  if (msg?.code === "unsupported-feature") return `this world needs features this client doesn't have (${(Array.isArray(n) ? n : []).join(", ") || "unnamed"}): update the client`;
  return `the server refused the join (${msg?.code ?? "no reason given"})`;
}

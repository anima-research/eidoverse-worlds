// shared/protocol/hello.js — the join's global hello and its two refusals (docs/DESIGN-log-vocabulary.md §F F-3). Pure: the server
// validates the hello before any world lookup, and compares features only after access is granted; neither refusal names a world.
import { DIALECT, VERSION, MINORS } from "./fold.js";
import { checkRequires, KNOWN_FEATURES } from "./features.js";

/** What this reader speaks: the `need` an update-required refusal repeats. */
export const NEED = Object.freeze({ dialect: DIALECT, v: VERSION, minor: Math.max(...MINORS) });

/** {dialect, v, minor, features}: null when this server speaks it, else the update-required refusal (no legacy default). */
export function checkHello(hello, need = NEED, minors = MINORS) {
  const refused = () => ({ type: "refused", code: "update-required", need: { dialect: need.dialect, v: need.v, minor: need.minor } });
  if (!hello || typeof hello !== "object" || Array.isArray(hello)) return refused();
  if (hello.dialect !== need.dialect || hello.v !== need.v || !minors.has(hello.minor)) return refused();
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
export const versionLine = (requires) => ({ dialect: NEED.dialect, v: NEED.v, minor: NEED.minor, requires: [...(requires ?? [])] });

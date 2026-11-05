// shared/protocol/vocab-minor-1.js — the minor-0 → minor-1 rename table, as data (docs/DESIGN-log-vocabulary.md D3, §4.6).
// Keys are renamed, values never; the table is fixed and versioned so a verifier re-runs the same function (F13).
import { sha256 } from "./hash.js";
import { jcs } from "./fold.js";

export const VOCAB_VERSION = "minor-1";
export const MINOR = Object.freeze({ from: 0, to: 1 });

/** Entry kinds: old → new (a kind absent here keeps its name). */
export const KINDS = Object.freeze({ genesis: "genesis", change: "change", act: "request", sim: "physics", say: "say", purge: "redaction", sequencer: "governance" });

/** Envelope: `verb` becomes `op` on a change (and each batch item); stays on request/physics; is dropped elsewhere. `by` is
 *  stripped; `for` and `grant` were never written and refuse the line (D4). */
export const ENVELOPE = Object.freeze({ verbToOp: ["change"], verbKept: ["request", "physics"], verbDropped: ["genesis", "say", "redaction", "governance"], strip: ["by"], refuse: ["for", "grant"] });

/** Body keys by new kind (the old key → the new key). `commit` → `commitment` applies to a set op, a batch item and a whole
 *  purgeable body alike. */
export const BODY = Object.freeze({
  change: Object.freeze({ followUps: "cascade", commit: "commitment" }),
  changeOp: Object.freeze({ verb: "op", commit: "commitment" }),
  request: Object.freeze({ admitted: Object.freeze({ request: "args" }), refused: Object.freeze({ args: "argNames" }), commit: "commitment" }),
  physics: Object.freeze({ checkpoint: Object.freeze({ at: "seq" }), commit: "commitment" }),
  say: Object.freeze({ commit: "commitment" }),
  redaction: Object.freeze({ target: Object.freeze({ op: "index" }) }),
  governance: Object.freeze({}),
});

/** Genesis body: the minor, one field spelling, and the tautological verb (an envelope key, listed in ENVELOPE). */
export const GENESIS = Object.freeze({ rewind_window: "rewindWindow" });

/** The view marker (the state digest hashes it): §1.3. */
export const VIEW_MARKER = Object.freeze({ purged: "redacted" });

/** The table itself, in one object, and its content hash: the receipt's `vocabulary` names this table, so a verifier can
 *  check it holds the table it re-ran. */
export const TABLE = Object.freeze({ version: VOCAB_VERSION, minor: MINOR, kinds: KINDS, envelope: ENVELOPE, body: BODY, genesis: GENESIS, viewMarker: VIEW_MARKER });
export const TABLE_SHA256 = sha256(jcs(TABLE));

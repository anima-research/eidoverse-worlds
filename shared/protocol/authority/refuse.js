// shared/protocol/authority/refuse.js — how the authority says no (refactor C11, 2026-10-12; moved from authority.js's
// "the authority" section unchanged). A leaf below every other seam: the spatial index's work budget, storage's version
// check and the rights views all refuse through here, and none of them may reach the gate.
import { dec } from "../names.js";
import { CTX } from "./ctx.js";
class Refusal extends Error { constructor(code, reason, fix, extra = {}) { super(reason); Object.assign(this, { code, reason, fix, ...extra }); } }
const refuse = (code, reason, fix, extra) => { throw new Refusal(code, reason, fix, extra); };
// A person's name as they spell it, for a refusal's words. An actor is an opaque id (u-…); its name lives in the authority's
// directory, outside the log (§2.3), injected as io.nameOf and read here for one request at a time (like CTX.cat). An old
// escaped identity (x--416e6e…) still reads back as "Ann". The identity itself rides as a field (`by`) for whoever
// must match it.
const said = (id) => CTX.nameOf?.(String(id)) ?? dec(String(id)) ?? String(id);
export { Refusal, refuse, said };

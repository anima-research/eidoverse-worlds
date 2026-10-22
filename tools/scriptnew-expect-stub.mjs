// scriptnew-expect-test substitutes this for scriptnew.js's editwrites.js and net.js: a viewer's state the test changes
// while the upload is out, and the requests the card sends, recorded.
export const net = { myRights: { permissions: ['scripts'] } };
export const T = { comps: {}, sent: [], uploadGate: null };
export const compsOf = (id) => (T.comps[id] ? structuredClone(T.comps[id]) : null);
export async function send(req) { T.sent.push({ kind: 'send', req }); if (T.uploadGate) await T.uploadGate(); return { ok: true, src: 'sha256:' + 'a'.repeat(64) }; }
export async function sendOps(ops, opts = {}) { T.sent.push({ kind: 'sendOps', ops, opts: structuredClone(opts) }); return { ok: true }; }

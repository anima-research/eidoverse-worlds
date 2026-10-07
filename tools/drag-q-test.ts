// drag-q-test — the rotate gizmo's live drag carries the full orientation
// (design §5, step 3): the REAL "drag" message handler (server/messages.ts)
// relays a usable q (normalized) alongside the yaw older peers read, and
// relays no q at all for a malformed one. The relay is gated on the door's role
// (builder+, read by the person's directory id).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/drag-q-test.ts
process.env.WORLDS_DIR ??= require('node:fs').mkdtempSync(require('node:os').tmpdir() + '/drag-q-');
process.env.JOIN_TOKEN ??= 'test-door';
const { MESSAGES } = await import('../server/messages.ts');
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const out: any[] = [];
// the gate reads the door's role for the person's directory identity (actorId), never their name
const roles: Record<string, string> = { 'u-builder': 'builder', 'u-visitor': 'visitor' };
const world: any = { name: 'w', log: { rightsOf: (id: string) => ({ can: { build: (roles[id] ?? "visitor") !== "visitor" } }) }, broadcast: (m: any) => out.push(m) };
const ctx: any = { c: { id: 'b', actorId: 'u-builder', world, spectator: false }, ws: { send() {} }, now: Date.now(), expel() {} };
MESSAGES['drag'](ctx, { type: 'drag', id: 'crate', pos: [1, 0, 2], yaw: 0.3, q: [0, 0, 2, 2] });
const m = out.at(-1);
check('a usable q is relayed, normalized, with the yaw', !!m && Array.isArray(m.q) && Math.abs(m.q[2] - Math.SQRT1_2) < 1e-15 && Math.abs(m.q[3] - Math.SQRT1_2) < 1e-15 && m.yaw === 0.3, JSON.stringify(m));
for (const bad of [[0, 0, 0, 0], [1, 2, 3], 'q', [NaN, 0, 0, 1]]) {
  MESSAGES['drag'](ctx, { type: 'drag', id: 'crate', pos: [1, 0, 2], yaw: 0.3, q: bad });
  check(`a malformed q ${JSON.stringify(bad)} is not relayed (the yaw still is)`, !('q' in out.at(-1)) && out.at(-1).yaw === 0.3, JSON.stringify(out.at(-1)));
}
MESSAGES['drag'](ctx, { type: 'drag', id: 'crate', pos: [1, 0, 2], yaw: 0.3 });
check('a yaw-only drag (an old client) relays exactly as before', !('q' in out.at(-1)), JSON.stringify(out.at(-1)));
// the live drag agrees with the release's gate: a visitor (who can't commit the move) slides nothing for anyone
{ const n = out.length;
  MESSAGES['drag']({ ...ctx, c: { id: 'v', actorId: 'u-visitor', world, spectator: false } }, { type: 'drag', id: 'crate', pos: [9, 0, 9], yaw: 0, q: [0, 0, 0, 1] });
  check("a visitor's drag is not relayed (the door's role, by identity)", out.length === n, JSON.stringify(out.slice(n))); }
import('node:fs').then((fs) => { try { fs.rmSync(process.env.WORLDS_DIR!, { recursive: true, force: true }); } catch {} });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

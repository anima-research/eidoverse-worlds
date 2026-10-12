// consent-switch-test — my two switches ARE the cells the authority reads, and a sync that fails is heard, then retried.
//
// The client owns the last word (consent.js: "my client applies them to my body, or doesn't"); the table the server
// checks is a projection of the switches, sent on arrival. Two things kept that honest only by luck (DEBT-SURVEY
// 2026-10-12 #9): nothing pinned switch → cell, and localbody.js swallowed a refused `consent` sync, leaving the server
// on Normal (strangers: nobody) while the switch said everyone.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/consent-switch-test.ts
// Mutation (must go red): in client/lib/consentsync.js drop the `on('hydrated', …)` line, or the timer retry, or the toast.
import { setConsent, decide } from '../shared/protocol/consent.js';
import { makeConsentSync } from '../client/lib/consentsync.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

// consent.js is a browser leaf (localStorage at load): give it one
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const C = await import('../client/lib/consent.js');

// 1. the four switch combinations → the cells consentDecide reads for a stranger
for (const push of [false, true]) for (const pose of [false, true]) {
  C.setPushable(push); C.setPosable(pose);
  const P: any = {}; const now = 1000;
  for (const [cls, mode] of C.bodyTable()) { const r = setConsent(P, 'me', { set: { class: cls, tier: 'strangers', mode } }, now); check(`set ${cls}=${mode} accepted`, r.ok, JSON.stringify(r)); }
  const want = { shove: push ? 'everyone' : 'nobody', move: push ? 'everyone' : 'nobody', pose: pose ? 'everyone' : 'nobody' };
  for (const [cls, m] of Object.entries(want)) {
    const d = decide(P, 'stranger', 'me', cls, now);
    check(`pushable=${push} posable=${pose}: a stranger's ${cls} is ${m}`, d.mode === m, `decide → ${d.mode} (${d.why})`);
  }
  check(`pushable=${push} posable=${pose}: bodyTable names exactly shove, move, pose`, JSON.stringify(C.bodyTable().map((x: any) => x[0]).sort()) === JSON.stringify(['move', 'pose', 'shove']));
}

// 2. a refused sync is heard (toast) and retried: on the next hydration, and on a timer before that
const run = async (reply: (n: number) => any) => {
  const sent: any[] = [], toasts: any[] = [], handlers: Record<string, Function[]> = {}, timers: Function[] = [];
  const s = makeConsentSync({
    table: () => [['shove', 'everyone'], ['move', 'everyone'], ['pose', 'nobody']],
    send: async (verb: string, args: any) => { sent.push([verb, args]); return reply(sent.length); },
    toast: (m: string, kind: string) => { toasts.push([m, kind]); },
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    later: (fn: Function) => { timers.push(fn); },
  });
  const fire = async (ev: string) => { for (const f of handlers[ev] ?? []) await f(); await new Promise((r) => setTimeout(r, 5)); };
  const tick = async () => { const t = timers.splice(0); for (const f of t) await f(); await new Promise((r) => setTimeout(r, 5)); };
  return { s, sent, toasts, handlers, timers, fire, tick };
};

{ // happy path: three sets on arrival, no toast, no timer
  const t = await run(() => ({ ok: true }));
  await t.fire('hydrated');
  check('arrival sends one set per table row', t.sent.length === 3 && t.sent.every(([v, a]) => v === 'consent' && a.set.tier === 'strangers'), JSON.stringify(t.sent));
  check('a sync that lands says nothing', t.toasts.length === 0 && t.timers.length === 0, JSON.stringify(t.toasts));
}
{ // the authority refuses: heard once, retried on the timer, then on hydration; silent once it lands
  let down = true;
  const t = await run(() => (down ? { ok: false, refused: { code: 'offline', reason: 'the connection dropped before the authority answered' } } : { ok: true }));
  await t.fire('hydrated');
  check('a refused sync is a toast', t.toasts.length === 1 && t.toasts[0][1] === 'warn' && /consent/.test(t.toasts[0][0]) && /connection dropped/.test(t.toasts[0][0]), JSON.stringify(t.toasts));
  check('it schedules a retry', t.timers.length === 1);
  const before = t.sent.length;
  await t.tick();
  check('the timer resends the table', t.sent.length === before + 3, `${t.sent.length - before} sent`);
  check('still failing: toast is not repeated, retry rescheduled', t.toasts.length === 1 && t.timers.length === 1, JSON.stringify(t.toasts));
  const b2 = t.sent.length; down = false;
  await t.fire('hydrated');
  check('the next arrival resends (and this one lands)', t.sent.length === b2 + 3 && t.toasts.length === 1, `${t.sent.length - b2} sent, ${t.toasts.length} toasts`);
  check('landed: the pending timer retry does nothing new', await (async () => { const n = t.sent.length; await t.tick(); return t.sent.length === n; })());
  check('the next failure is heard again', await (async () => { down = true; await t.fire('hydrated'); return t.toasts.length === 2; })());
}
{ // spectators and renderers have no body: nothing sent
  const sent: any[] = [];
  const s = makeConsentSync({ table: () => [['shove', 'everyone']], send: async (v: string, a: any) => { sent.push(a); return { ok: true }; }, toast: () => {}, on: () => {}, later: () => {}, enabled: () => false });
  await s.sync();
  check('a bodiless client sends no table', sent.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

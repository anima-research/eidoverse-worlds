// consent-switch-test — my body's switch (recut A2) is what the authority decides by, and a sync that fails is heard, then retried.
//
// The client owns the last word (consent.js: "my client applies them to my body, or doesn't"); the table the server
// checks is a projection of the switches, sent on arrival. Two things kept that honest only by luck (DEBT-SURVEY
// 2026-10-12 #9): nothing pinned switch → cell, and localbody.js swallowed a refused `consent` sync, leaving the server
// on Normal (everyone: deny) while the switch said allow.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/consent-switch-test.ts
// Mutation (must go red): in client/lib/consentsync.js drop the `on('hydrated', …)` line, or the timer retry, or the toast.
import { setConsent, decide, SWITCHES } from '../shared/protocol/consent.js';
import { makeConsentSync } from '../client/lib/consentsync.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

// consent.js is a browser leaf (localStorage at load): give it one
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const C = await import('../client/lib/consent.js');

// 1. (recut A2) each switch value, set through the authority's own setConsent, is what decide answers a stranger
for (const v of SWITCHES) {
  check(`setSwitch(${v}) is remembered`, (C.setSwitch(v) || C.mySwitch() === v) && C.mySwitch() === v && C.bodyTable().switch === v);
  const P: any = {}; const r = setConsent(P, 'me', { switch: C.bodyTable().switch }, 1000);
  check(`the authority accepts switch ${v}`, r.ok, JSON.stringify(r));
  const want = { accept: 'allow', ask: 'ask', refuse: 'deny' }[v];
  for (const cls of ['shove', 'pose', 'displace', 'touch']) { const d = decide(P, 'stranger', 'me', cls, 1000); check(`switch ${v}: a stranger's ${cls} is ${want}`, d.mode === want, `decide → ${d.mode}`); }
}
check('setPushable(false) is refuse, (true) is accept — the old /pushable meaning', (C.setPushable(false), C.mySwitch() === 'refuse') && (C.setPushable(true), C.mySwitch() === 'accept'));

// 2. a refused sync is heard (toast) and retried: on the next hydration, and on a timer before that
const run = async (reply: (n: number) => any, want = 'refuse') => {
  const sent: any[] = [], toasts: any[] = [], handlers: Record<string, Function[]> = {}, timers: Function[] = [];
  const s = makeConsentSync({
    table: () => ({ switch: want }),
    send: async (verb: string, args: any) => { sent.push([verb, args]); const r = reply(sent.length); return r.ok && args.switch === undefined ? { ...r, table: { switch: null } } : r; },
    toast: (m: string, kind: string) => { toasts.push([m, kind]); },
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    later: (fn: Function) => { timers.push(fn); },
  });
  const fire = async (ev: string) => { for (const f of handlers[ev] ?? []) await f(); await new Promise((r) => setTimeout(r, 5)); };
  const tick = async () => { const t = timers.splice(0); for (const f of t) await f(); await new Promise((r) => setTimeout(r, 5)); };
  return { s, sent, toasts, handlers, timers, fire, tick };
};
{ const t = await run(() => ({ ok: true }));
  await t.fire('hydrated');
  check('arrival reads the authority, then sends the switch once', t.sent.length === 2 && t.sent[1][1].switch === 'refuse', JSON.stringify(t.sent));
  check('a sync that lands says nothing', t.toasts.length === 0 && t.timers.length === 0, JSON.stringify(t.toasts)); }
{ const sent: any[] = []; const s = makeConsentSync({ table: () => ({ switch: 'ask' }), send: async (v: string, a: any) => { sent.push(a); return { ok: true, table: { switch: 'ask' } }; }, toast: () => {}, on: () => {}, later: () => {} });
  await s.sync(); check('a switch the authority already holds is not sent again', sent.length === 1, JSON.stringify(sent)); }
{ let down = true;
  const t = await run(() => (down ? { ok: false, refused: { code: 'offline', reason: 'the connection dropped before the authority answered' } } : { ok: true }));
  await t.fire('hydrated');
  check('a refused sync is a toast', t.toasts.length === 1 && t.toasts[0][1] === 'warn' && /consent/.test(t.toasts[0][0]) && /connection dropped/.test(t.toasts[0][0]), JSON.stringify(t.toasts));
  check('it schedules a retry', t.timers.length === 1);
  const before = t.sent.length; await t.tick();
  check('the timer tries again', t.sent.length === before + 1, `${t.sent.length - before} sent`);
  check('still failing: toast is not repeated, retry rescheduled', t.toasts.length === 1 && t.timers.length === 1, JSON.stringify(t.toasts));
  const b2 = t.sent.length; down = false; await t.fire('hydrated');
  check('the next arrival resends and lands (the read and the switch)', t.sent.length === b2 + 2 && t.toasts.length === 1, `${t.sent.length - b2} sent`);
  check('landed: the pending timer retry does nothing new', await (async () => { const n = t.sent.length; await t.tick(); return t.sent.length === n; })());
  check('the next failure is heard again', await (async () => { down = true; await t.fire('hydrated'); return t.toasts.length === 2; })()); }
{ let v = 'accept'; const sent: any[] = []; let release: Function = () => {}; const gate = new Promise((r) => { release = r; });
  const s = makeConsentSync({ table: () => ({ switch: v }), send: async (_: string, a: any) => { sent.push(a); await gate; return { ok: true, table: { switch: null } }; }, toast: () => {}, on: () => {}, later: () => {} });
  const p1 = s.sync(); v = 'ask'; const p2 = s.sync(); v = 'refuse'; const p3 = s.sync();
  release(); await Promise.all([p1, p2, p3]); await new Promise((r) => setTimeout(r, 5));
  check('a burst of changes syncs twice (now, then once with the latest)', sent.filter((a) => a.switch === undefined).length === 2, `${sent.length} sent`);
  check('…and the last switch sent is the latest', sent[sent.length - 1]?.switch === 'refuse', JSON.stringify(sent[sent.length - 1])); }
{ const sent: any[] = [];
  const s = makeConsentSync({ table: () => ({ switch: 'accept' }), send: async (v: string, a: any) => { sent.push(a); return { ok: true }; }, toast: () => {}, on: () => {}, later: () => {}, enabled: () => false });
  await s.sync(); check('a bodiless client sends nothing', sent.length === 0); }

// 3. the ask round-trip (10-14, R: wire `ask`): a body-inbox message holds the ask; answering sends consent {answer, yes}
// and the ask is gone; an ask nobody answers expires locally with no send (the authority already took it as a no).
// Mutation (must go red): in client/lib/consentinbox.js drop the `delete` in answer(), or the expiry in sweep().
{
  const { makeConsentInbox } = await import('../client/lib/consentinbox.js');
  let t = 1000; const sent: any[] = [], changes: any[] = [];
  const box = makeConsentInbox({ now: () => t, onChange: (ev: any) => changes.push(ev) });
  const ask = { id: 'ask-1000-0', from: 'u-wren', kind: 'pose', summary: 'u-wren asks to pose', why: null, expires: 21000 };
  box.take([{ type: 'body-ask', ask }]);
  check('a body-ask lands as a pending ask, keyed by id, with its class derived from the kind', box.asks().length === 1 && box.asks()[0].id === ask.id && box.asks()[0].from === 'u-wren' && box.asks()[0].cls === 'pose' && box.asks()[0].kind === 'pose', JSON.stringify(box.asks()));
  check('askFrom finds it by the asker\'s identity', box.askFrom('u-wren')?.id === ask.id && box.askFrom('u-nobody') === null);
  check('the arrival is heard (added)', changes.length === 1 && changes[0].added?.[0]?.id === ask.id, JSON.stringify(changes));
  check('the same ask twice is held once', (box.take([{ type: 'body-ask', ask }]), box.asks().length === 1));
  const send = async (verb: string, args: any) => { sent.push([verb, args]); return { ok: true, answered: args.answer, yes: args.yes }; };
  const r = await box.answer(ask.id, true, send);
  check('answering yes sends consent {answer: <id>, yes: true}', sent.length === 1 && sent[0][0] === 'consent' && sent[0][1].answer === ask.id && sent[0][1].yes === true, JSON.stringify(sent));
  check('…and the ask is gone', r?.ok === true && box.asks().length === 0 && box.askFrom('u-wren') === null);
  check('answering an ask that isn\'t there sends nothing', (await box.answer('ask-nope', false, send)) === null && sent.length === 1);
  // a second ask, refused
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-0', kind: 'drag' } }]);
  check('a drag ask is the displace class', box.askFrom('u-wren')?.cls === 'displace', JSON.stringify(box.asks()));
  await box.answer('ask-1001-0', false, send);
  check('answering no sends consent {answer, yes: false}', sent.length === 2 && sent[1][1].yes === false && box.asks().length === 0, JSON.stringify(sent));
  // a reach to an intimate point: the authority classes it (bodyconsent.js: cls intimate for chest_front), and the
  // inbox keeps that class, so Allow and Never are for intimate touch, not ordinary touch (review of #260)
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-1', kind: 'touch', cls: 'intimate', summary: 'u-wren asks to touch (chest_front)' } }]);
  check('a reach the authority classes intimate is held as intimate, not as its kind\'s touch', box.askFrom('u-wren')?.cls === 'intimate', JSON.stringify(box.asks()));
  await box.answer('ask-1001-1', false, send); sent.pop();
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1001-2', kind: 'touch', cls: 'nonsense' } }]);
  check('…and a class the protocol doesn\'t name falls back to the kind\'s', box.askFrom('u-wren')?.cls === 'touch', JSON.stringify(box.asks()));
  await box.answer('ask-1001-2', false, send); sent.pop();
  // a third ask nobody answers: gone at its expiry, nothing sent
  box.take([{ type: 'body-ask', ask: { ...ask, id: 'ask-1002-0', expires: 21000 } }]);
  t = 20999; box.sweep();
  check('before its expiry it is still there', box.asks().length === 1);
  t = 21000; const gone = box.sweep();
  check('at its expiry it is gone, and nothing was sent', gone.length === 1 && gone[0] === 'ask-1002-0' && box.asks().length === 0 && sent.length === 2, JSON.stringify({ gone, sent: sent.length }));
  check('the expiry is heard (removed)', changes.some((c) => c.removed?.includes('ask-1002-0')), JSON.stringify(changes));
  // replies and acts land in a short ring, in the authority's words
  box.take([{ type: 'body-reply', ask: 'ask-9', ok: false, why: 'u-x said no' }, { type: 'body', from: 'u-wren', kind: 'pose', cls: 'pose', consent: 'asked' }, { type: 'body-revoked', by: 'u-x', class: 'pose' }]);
  check('replies, acts and revocations are kept in the ring (not as asks)', box.ring().length === 3 && box.asks().length === 0, JSON.stringify(box.ring()));
  check('a malformed inbox is ignored', (box.take(null as any), box.take([{ type: 'body-ask' }, 7, { type: 'body-ask', ask: { id: 42 } }]), box.asks().length === 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

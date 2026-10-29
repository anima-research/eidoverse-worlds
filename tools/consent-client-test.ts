// consent-client-test — my body's two gates and two lists (client/lib/consent.js, R 10-28) are what the authority decides
// by, an older stored setting is carried into the gates never wider, and a sync that fails is heard, then retried.
//
// The authority is the one decider (#260 recut A1); the table it checks is what my client sends on arrival and on every
// change (consentsync.js). Kept honest here: nothing else pinned consent.js → decide, and localbody.js once swallowed a
// refused `consent` sync (DEBT-SURVEY 2026-10-12 #9), leaving the server on its defaults while my switch said otherwise.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/consent-client-test.ts
// Mutation (must go red): in client/lib/consentsync.js drop the `on('hydrated', …)` line, or the timer retry, or the toast.
import { setConsent, decide, tableOf, migratePresence } from '../shared/protocol/consent.js';
import { makeConsentSync } from '../client/lib/consentsync.js';

let pass = 0, fail = 0;
// the sync's sends are promises with no timer behind them: a few microtask turns settle them (never a wall-clock wait)
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };

// consent.js is a browser leaf (localStorage at load): give it one
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
const C = await import('../client/lib/consent.js');
/** what the authority decides for `from` doing `cls`, once my client's table has landed through the authority's own setConsent */
const landed = (from: string, cls: string) => { const P: any = {}; const t = C.bodyTable();
  for (const a of [{ move: t.move, touch: t.touch }, ...t.allow.map((id: string) => ({ allow: id })), ...t.block.map((id: string) => ({ block: id }))]) { const r = setConsent(P, 'me', a); if (!r.ok) return `refused ${JSON.stringify(a)}`; }
  return decide(P, from, 'me', cls).mode; };

// 0. (review F2, R 10-28) a fresh client never chose: its sync leaves the authority's lists and the world's default alone.
// Mutation (must go red): in consentsync.js send a gate whenever held !== want, or unlist every held id the client doesn't name.
/** an authority with Bob blocked by migration and a world default of move off; `send` is the authority's own consent verb */
const authority = () => { const P: any = { consent: { me: { switch: 'accept', over: { 'u-bob': { shove: { mode: 'deny' } } } } }, consentShape: 3, bodyDefault: { move: false } }; migratePresence(P);
  delete P.consent.me.move;   // as if 'me' never chose a gate, so the world default answers
  const sent: any[] = []; const send = async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me') }; };
  return { P, sent, send }; };
{ const A = authority(); const s = makeConsentSync({ table: C.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {} }); await s.sync();
  check('a fresh client: neither gate is chosen (absent, not the defaults)', C.bodyTable().move === undefined && C.bodyTable().touch === undefined, JSON.stringify(C.bodyTable()));
  check('an authority block survives a fresh client\'s sync (no unlist for a person the client never listed)', JSON.stringify(tableOf(A.P, 'me').block) === '["u-bob"]' && decide(A.P, 'u-bob', 'me', 'pose').mode === 'deny' && !A.sent.some((a) => a.unlist), JSON.stringify(A.sent));
  check('a never-chosen client in a move:false world stays move:false (no gate sent)', A.sent.length === 1 && decide(A.P, 'pal', 'me', 'shove').mode === 'deny', JSON.stringify(A.sent)); }
{ const A = authority(); C.setGate('move', true); const s = makeConsentSync({ table: C.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {} }); await s.sync();
  check('a client that chose move:true sends it (and only it), and a stranger may shove in a move:false world', JSON.stringify(A.sent.slice(1)) === '[{"move":true}]' && decide(A.P, 'pal', 'me', 'shove').mode === 'allow', JSON.stringify(A.sent)); }
{ const A = authority(); C.setListed('u-bob', 'block', 'Bob'); C.setListed('u-bob', null); const s = makeConsentSync({ table: C.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {} }); await s.sync();
  check('…and a person I unlisted here (People panel) is unlisted at the authority too', A.sent.some((a) => a.unlist === 'u-bob') && tableOf(A.P, 'me').block.length === 0, JSON.stringify(A.sent)); }
{ // (F2 follow-up) the People panel shows the authority's lists: a block only the world holds is listed and can be removed
  const A = authority(); A.P.consent.me.block['u-mig'] = true;
  const s = makeConsentSync({ table: C.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {}, held: (C as any).noteHeld }); await s.sync();
  check('a block that exists only at the authority is listed in the panel', C.listed('block').some((p: any) => p.id === 'u-mig') && C.listOf('u-mig') === 'block', JSON.stringify(C.listed('block')));
  const removed = C.setListed('u-mig', null); await s.sync();
  check('…and removing it records an unlist and sends it: the authority no longer blocks them, the panel no longer lists them', removed && C.bodyTable().unlist.includes('u-mig') && A.sent.some((a) => a.unlist === 'u-mig') && !tableOf(A.P, 'me').block.includes('u-mig') && !C.listed('block').some((p: any) => p.id === 'u-mig'), JSON.stringify(A.sent)); }

// 1. the gates and lists, as the authority takes them
check('a fresh client: Move me on, Touch me off (the defaults)', C.gate('move') && !C.gate('touch') && landed('pal', 'shove') === 'allow' && landed('pal', 'pose') === 'deny');
for (const [g, on, cls, want] of [['move', false, 'shove', 'deny'], ['move', false, 'displace', 'deny'], ['touch', true, 'pose', 'allow'], ['touch', true, 'intimate', 'allow']] as const) {
  C.setGate(g, on); check(`${g} ${on ? 'on' : 'off'} lands: a stranger's ${cls} is ${want}`, landed('pal', cls) === want, landed('pal', cls)); }
check('…and touch on never opens move (pose is touch, a shove is move)', landed('pal', 'pose') === 'allow' && landed('pal', 'shove') === 'deny');
C.setGate('move', false); C.setGate('touch', false);
check('Always allow: a person on my allow list may, with both switches off', C.setListed('u-wren', 'allow', 'Wren') && landed('u-wren', 'shove') === 'allow' && landed('u-wren', 'pose') === 'allow' && landed('pal', 'pose') === 'deny');
C.setGate('move', true); C.setGate('touch', true);
check('Never allow: a person on my block list may not, with both switches on', C.setListed('u-wren', 'block', 'Wren') && landed('u-wren', 'shove') === 'deny' && landed('u-wren', 'pose') === 'deny' && landed('pal', 'pose') === 'allow');
check('…and a person is on one list at a time (block took Wren off allow)', C.listOf('u-wren') === 'block' && C.listed('allow').length === 0 && JSON.stringify(C.listed('block')) === JSON.stringify([{ id: 'u-wren', name: 'Wren' }]));
check('Default: off both lists, the switches answer them again', C.setListed('u-wren', null) && C.listOf('u-wren') === null && landed('u-wren', 'pose') === 'allow');
check('/pushable and /posable keep main\'s meaning: the move and touch switches', (C.setPushable(false), !C.gate('move') && !C.pushable()) && (C.setPosable(false), !C.posable()) && (C.setPushable(true), C.gate('move')));
check('it is remembered under ew-body-consent, lists and names too', (C.setListed('u-kit', 'allow', 'Kit'), JSON.parse(store.get('ew-body-consent') ?? '{}').allow?.['u-kit'] === 'Kit') && JSON.parse(store.get('ew-body-consent') ?? '{}').v === 4);

// 1b. an older stored setting (main's two keys, the body switch) is carried into the gates silently, never wider
const was = (kv: Record<string, string>) => C.readStored((k: string) => kv[k] ?? null);
const g2 = (s: any) => `${(s.move ?? true) ? 'move' : '-'}/${(s.touch ?? false) ? 'touch' : '-'}`;   // never chosen shows as the defaults
for (const [kv, want, why] of [
  [{ 'ew-body-switch': 'refuse' }, '-/-', 'switch refuse → both off'],
  [{ 'ew-body-switch': 'ask' }, '-/-', 'switch ask → both off (F3, R 10-28 16:02: ask was no until yes)'],
  [{ 'ew-body-switch': 'accept' }, 'move/-', 'switch accept → Move on, Touch its default (off)'],
  [{ 'ew-body-switch': 'accept', 'ew-posable': '1' }, 'move/touch', 'switch accept with main\'s posable on → Touch as stored (on)'],
  [{ 'ew-body-switch': 'refuse', 'ew-posable': '1', 'ew-pushable': '1' }, '-/-', 'switch refuse beats main\'s on keys: an opt-out is never lost'],
  [{ 'ew-pushable': '0' }, '-/-', 'main pushable off → Move off'],
  [{ 'ew-posable': '1' }, 'move/touch', 'main posable on → Touch on'],
  [{ 'ew-pushable': '0', 'ew-posable': '1' }, '-/touch', 'main pushable off, posable on → Move off, Touch on'],
  [{}, 'move/-', 'nothing stored → the defaults'],
  [{ 'ew-body-consent': '{"v":4,"move":false,"touch":true,"allow":{"u-a":"A"},"block":{}}', 'ew-body-switch': 'accept' }, '-/touch', 'today\'s key wins over the old ones'],
] as const) { const s = was(kv as any); check(`migration: ${why}`, g2(s) === want, `${g2(s)} (want ${want})`); }
check('migration: a key never present is a gate never chosen (main posable alone leaves move to the world)', ((s) => s.move === undefined && s.touch === true)(was({ 'ew-posable': '1' })) && ((s) => s.move === undefined && s.touch === undefined)(was({})) && ((s) => s.move === true && s.touch === false)(was({ 'ew-body-switch': 'accept' })));
check('migration carries no lists from the old keys (the switch kept per-person answers only at the authority)', JSON.stringify(was({ 'ew-body-switch': 'accept' }).allow) === '{}');

// 2. a refused sync is heard (toast) and retried: on the next hydration, and on a timer before that
const T = (o: any = {}) => ({ move: true, touch: false, allow: [] as string[], block: [] as string[], unlist: [] as string[], ...o });
const held0 = { move: null, touch: null, allow: [], block: [] };
const isRead = (a: any) => Object.keys(a ?? {}).length === 0;
const run = async (reply: (n: number) => any, want = T({ move: false })) => {
  const sent: any[] = [], toasts: any[] = [], handlers: Record<string, Function[]> = {}, timers: Function[] = [];
  const s = makeConsentSync({
    table: () => want,
    send: async (verb: string, args: any) => { sent.push([verb, args]); const r = reply(sent.length); return r.ok && isRead(args) ? { ...r, table: held0 } : r; },
    toast: (m: string, kind: string) => { toasts.push([m, kind]); },
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    later: (fn: Function) => { timers.push(fn); },
  });
  const fire = async (ev: string) => { for (const f of handlers[ev] ?? []) await f(); await flush(); };
  const tick = async () => { const t = timers.splice(0); for (const f of t) await f(); await flush(); };
  return { s, sent, toasts, handlers, timers, fire, tick };
};
{ const t = await run(() => ({ ok: true }));
  await t.fire('hydrated');
  check('arrival reads the authority, then sends the gates once (both: the authority held neither)', t.sent.length === 2 && JSON.stringify(t.sent[1][1]) === JSON.stringify({ move: false, touch: false }), JSON.stringify(t.sent));
  check('a sync that lands says nothing', t.toasts.length === 0 && t.timers.length === 0, JSON.stringify(t.toasts)); }
{ const sent: any[] = []; const s = makeConsentSync({ table: () => T({ allow: ['u-a'] }), send: async (v: string, a: any) => { sent.push(a); return { ok: true, table: { move: true, touch: false, allow: ['u-a'], block: [] } }; }, toast: () => {}, on: () => {}, later: () => {} });
  await s.sync(); check('gates and lists the authority already holds are not sent again', sent.length === 1, JSON.stringify(sent)); }
{ const sent: any[] = []; const s = makeConsentSync({ table: () => T({ allow: ['u-a'], block: ['u-b'], unlist: ['u-old', 'u-gone'] }), send: async (v: string, a: any) => { sent.push(a); return isRead(a) ? { ok: true, table: { move: true, touch: true, allow: ['u-b', 'u-old', 'u-theirs'], block: [] } } : { ok: true }; }, toast: () => {}, on: () => {}, later: () => {} });
  await s.sync(); const s2 = sent.slice(1).map((a) => JSON.stringify(a));
  check('only what differs is sent: the touch gate, each person to the list I keep them on, an unlist for one I unlisted here (held), none for one the authority listed', JSON.stringify(s2) === JSON.stringify(['{"touch":false}', '{"allow":"u-a"}', '{"block":"u-b"}', '{"unlist":"u-old"}']), JSON.stringify(s2)); }
{ let down = true;
  const t = await run(() => (down ? { ok: false, refused: { code: 'offline', reason: 'the connection dropped before the authority answered' } } : { ok: true }));
  await t.fire('hydrated');
  check('a refused sync is a toast', t.toasts.length === 1 && t.toasts[0][1] === 'warn' && /consent/.test(t.toasts[0][0]) && /connection dropped/.test(t.toasts[0][0]), JSON.stringify(t.toasts));
  check('it schedules a retry', t.timers.length === 1);
  const before = t.sent.length; await t.tick();
  check('the timer tries again', t.sent.length === before + 1, `${t.sent.length - before} sent`);
  check('still failing: toast is not repeated, retry rescheduled', t.toasts.length === 1 && t.timers.length === 1, JSON.stringify(t.toasts));
  const b2 = t.sent.length; down = false; await t.fire('hydrated');
  check('the next arrival resends and lands (the read and the gates)', t.sent.length === b2 + 2 && t.toasts.length === 1, `${t.sent.length - b2} sent`);
  check('landed: the pending timer retry does nothing new', await (async () => { const n = t.sent.length; await t.tick(); return t.sent.length === n; })());
  check('the next failure is heard again', await (async () => { down = true; await t.fire('hydrated'); return t.toasts.length === 2; })()); }
{ let v = T(); const sent: any[] = []; let release: Function = () => {}; const gate = new Promise((r) => { release = r; });
  const s = makeConsentSync({ table: () => v, send: async (_: string, a: any) => { sent.push(a); await gate; return { ok: true, table: held0 }; }, toast: () => {}, on: () => {}, later: () => {} });
  const p1 = s.sync(); v = T({ touch: true }); const p2 = s.sync(); v = T({ move: false }); const p3 = s.sync();
  release(); await Promise.all([p1, p2, p3]); await flush();
  check('a burst of changes syncs twice (now, then once with the latest)', sent.filter(isRead).length === 2, `${sent.length} sent`);
  check('…and the last gates sent are the latest', JSON.stringify(sent[sent.length - 1]) === '{"move":false,"touch":false}', JSON.stringify(sent[sent.length - 1])); }
{ const sent: any[] = [];
  const s = makeConsentSync({ table: () => T(), send: async (v: string, a: any) => { sent.push(a); return { ok: true }; }, toast: () => {}, on: () => {}, later: () => {}, enabled: () => false });
  await s.sync(); check('a bodiless client sends nothing', sent.length === 0); }

// 3. (house review of #260, client/lib I1) an act the authority delivered ({type: 'body', kind, spec}: the body verb, which
// my lists and gates allowed) is APPLIED to my body: it becomes the puppet message localbody.js applies.
// Mutation (must go red): in bodyact.js bodyActAsPuppet return null for every kind.
{
  const { bodyActAsPuppet, refusedNotice } = await import('../client/lib/bodyact.js');
  check('a refused act is said to me in plain words: who, and which of my switches turned it away', refusedNotice?.({ type: 'body-refused', from: 'u-wren', gate: 'move', class: 'shove' }, () => 'Wren') === 'Wren tried to move you — your Move me switch is off'
    && refusedNotice({ type: 'body-refused', from: 'u-wren', gate: 'touch', class: 'pose' }, () => 'Wren') === 'Wren tried to touch you — your Touch me switch is off'
    && refusedNotice({ type: 'body-refused', from: 'u-wren', gate: null, class: 'pose' }, () => 'Wren') === 'Wren tried to touch you — they are on your Never allow list', String(refusedNotice?.({ type: 'body-refused', from: 'u-wren', gate: 'move', class: 'shove' }, () => 'Wren')));
  check('…and anything else says nothing', refusedNotice?.({ type: 'body', from: 'u-wren' }, () => 'Wren') === null && refusedNotice?.(null, () => 'x') === null);
  const q = [0, 0, 0.38, 0.92];
  const pose = bodyActAsPuppet({ type: 'body', from: 'u-wren', kind: 'pose', cls: 'pose', consent: 'allowed', spec: { head: q } });
  check('a delivered pose (spec: bones) is a replacing puppet pose', JSON.stringify(pose) === JSON.stringify({ pose: { head: q }, merge: false }), JSON.stringify(pose));
  const merged = bodyActAsPuppet({ type: 'body', kind: 'pose', spec: { pose: { head: q }, merge: true } });
  check('…or {pose, merge} as a puppet sends it', JSON.stringify(merged) === JSON.stringify({ pose: { head: q }, merge: true }), JSON.stringify(merged));
  const anim = { dur: 1, tracks: { head: [{ t: 0, q }] }, replace: false };
  check('a delivered anim with tracks is a puppet anim', JSON.stringify(bodyActAsPuppet({ type: 'body', kind: 'anim', spec: anim })) === JSON.stringify({ anim }));
  // streamed kinds apply nothing from the inbox (they arrive live, where consent gates each sample), and an unknown kind
  // applies nothing: only pose, anim (with tracks) and shove become puppet messages (client review, 10-21)
  check('a delivered drag, occupy or carry, or an unknown kind, applies nothing', ['drag', 'occupy', 'carry', 'teleport'].every((kind) => bodyActAsPuppet({ type: 'body', kind, spec: { tracks: { head: [] }, pose: { head: q } } }) === null));
  check('a delivered shove is a ragdoll, directed by spec.lean when it has one', JSON.stringify(bodyActAsPuppet({ type: 'body', kind: 'shove', spec: { lean: [1, 0, 2] } })) === JSON.stringify({ ragdoll: { lean: [1, 0, 2] } })
    && bodyActAsPuppet({ type: 'body', kind: 'shove' })?.ragdoll === true && bodyActAsPuppet({ type: 'body', kind: 'shove', spec: { lean: [1, 'x', 2] } })?.ragdoll === true);
  check('drag, occupy and carry are live presence, not a one-shot: nothing to apply', ['drag', 'occupy', 'carry'].every((kind) => bodyActAsPuppet({ type: 'body', kind, spec: {} }) === null));
  check('a pose with no bones, an anim with no tracks, or another message type applies nothing',
    bodyActAsPuppet({ type: 'body', kind: 'pose' }) === null && bodyActAsPuppet({ type: 'body', kind: 'pose', spec: [q] }) === null
    && bodyActAsPuppet({ type: 'body', kind: 'anim', spec: { clip: 'wave' } }) === null && bodyActAsPuppet({ type: 'body-revoked', kind: 'pose', spec: { head: q } }) === null && bodyActAsPuppet(null) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

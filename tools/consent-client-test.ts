// consent-client-test — my body's two gates and two lists (client/lib/consent.js, R 10-28) are what the authority decides
// by, an older stored setting is carried into the gates never wider, and a sync that fails is heard, then retried.
//
// The authority is the one decider (#260 recut A1); the table it checks is what my client sends on arrival and on every
// change (consentsync.js). Kept honest here: nothing else pinned consent.js → decide, and localbody.js once swallowed a
// refused `consent` sync (DEBT-SURVEY 2026-10-12 #9), leaving the server on its defaults while my switch said otherwise.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/consent-client-test.ts
// Mutation (must go red): in client/lib/consentsync.js drop the `on('hydrated', …)` line, or the timer retry, or the toast.
import { setConsent, decide, tableOf, migratePresence, worldGates, DEFAULT_GATES } from '../shared/protocol/consent.js';
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
check('a fresh client: Allow being moved on, Allow being posed and touched off (the defaults)', C.gate('move') && !C.gate('touch') && landed('pal', 'shove') === 'allow' && landed('pal', 'pose') === 'deny');
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

// 1b. an older stored setting (main's two keys, the body switch) is carried into the gates never wider; one that can't carry is told once
const was = (kv: Record<string, string>) => C.readStored((k: string) => kv[k] ?? null);
const g2 = (s: any) => `${(s.move ?? true) ? 'move' : '-'}/${(s.touch ?? false) ? 'touch' : '-'}`;   // never chosen shows as the defaults
for (const [kv, want, why] of [
  [{ 'ew-body-switch': 'refuse' }, '-/-', 'switch refuse → both off'],
  [{ 'ew-body-switch': 'ask' }, '-/-', 'switch ask → both off (F3, R 10-28 16:02: ask was no until yes)'],
  [{ 'ew-body-switch': 'accept' }, 'move/-', 'switch accept → Move on, Touch its default (off)'],
  [{ 'ew-body-switch': 'accept', 'ew-posable': '1' }, 'move/-', 'switch accept with main\'s posable on → Touch off (posable was posing only; Allow being posed and touched is touch and intimate too)'],
  [{ 'ew-body-switch': 'refuse', 'ew-posable': '1', 'ew-pushable': '1' }, '-/-', 'switch refuse beats main\'s on keys: an opt-out is never lost'],
  [{ 'ew-pushable': '0' }, '-/-', 'main pushable off → Move off'],
  [{ 'ew-posable': '1' }, 'move/-', 'main posable on → Touch off (never wider: main\'s posable never opened touch or intimate)'],
  [{ 'ew-pushable': '0', 'ew-posable': '1' }, '-/-', 'main pushable off, posable on → Move off, Touch off'],
  [{ 'ew-pushable': '1' }, 'move/-', 'main pushable on → Move on (as main: shove and drag), Touch its default'],
  [{}, 'move/-', 'nothing stored → the defaults'],
  [{ 'ew-body-consent': '{"v":4,"move":false,"touch":true,"allow":{"u-a":"A"},"block":{}}', 'ew-body-switch': 'accept' }, '-/touch', 'today\'s key wins over the old ones'],
] as const) { const s = was(kv as any); check(`migration: ${why}`, g2(s) === want, `${g2(s)} (want ${want})`); }
check('migration: a key never present is a gate never chosen (main posable alone leaves move to the world, and Allow being posed and touched chosen off)', ((s) => s.move === undefined && s.touch === false)(was({ 'ew-posable': '1' })) && ((s) => s.move === undefined && s.touch === undefined)(was({})) && ((s) => s.move === true && s.touch === false)(was({ 'ew-body-switch': 'accept' })));
check('migration carries no lists from the old keys (the switch kept per-person answers only at the authority)', JSON.stringify(was({ 'ew-body-switch': 'accept' }).allow) === '{}');
// (fixF) main's posable '1' can't carry over (wider), so the person is told once, in plain words, and how to turn it on
{ const words = (C as any).TOUCH_NOTICE ?? '';
  check('the notice says the old setting could not carry over, why, and where Allow being posed and touched is', /allow posing/.test(words) && /couldn't carry over/.test(words) && /intimate/.test(words) && /Settings ▸ body/.test(words) && /Allow being posed and touched/.test(words), words);
  check('migration: a notice is due only where main\'s posable on was not carried (not for switch refuse, not for posable off, not for nothing stored)', was({ 'ew-posable': '1' }).notice === true && was({ 'ew-body-switch': 'accept', 'ew-posable': '1' }).notice === true
    && !was({ 'ew-body-switch': 'refuse', 'ew-posable': '1' }).notice && !was({ 'ew-posable': '0' }).notice && !was({}).notice && !was({ 'ew-body-switch': 'accept' }).notice);
  const saved = store.get('ew-body-consent'); store.clear(); store.set('ew-posable', '1');
  const M = await import('../client/lib/consent.js?fixF=posable');   // a fresh page whose storage holds only main's posable on
  check('…on that page Allow being posed and touched is off and a stranger may not pose (the authority sees touch:false)', !M.gate('touch') && M.bodyTable().touch === false);
  const first = M.takeNotice?.(), second = M.takeNotice?.();
  check('…the page is told once: the first take is the notice, the second nothing', first === words && second === null, JSON.stringify([first, second]));
  const M2 = await import('../client/lib/consent.js?fixF=reload');   // the next page load, same storage
  check('…and not again on the next load (taken is remembered), with Allow being posed and touched still off', M2.takeNotice?.() === null && !M2.gate('touch'), store.get('ew-body-consent'));
  store.clear(); store.set('ew-posable', '1'); const M3 = await import('../client/lib/consent.js?fixF=unseen');
  const M4 = await import('../client/lib/consent.js?fixF=unseen2');   // a reload before anything took the notice
  check('…a notice not yet taken survives a reload (said once, never zero times)', M4.takeNotice?.() === words && M3 !== M4, store.get('ew-body-consent'));
  store.clear(); if (saved) store.set('ew-body-consent', saved); }
{ const src = await Bun.file(new URL('../client/lib/localbody.js', import.meta.url)).text();
  check('…and the page says it: localbody takes the notice at start and toasts it (not on a renderer)', /if \(!\(CONFIG\.renderer \|\| CONFIG\.spectate\)\) \{ const told = takeNotice\(\); if \(told\) toast\(told,/.test(src)); }

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
  check('a refused act is said to me in plain words: who, and which of my switches turned it away', refusedNotice?.({ type: 'body-refused', from: 'u-wren', gate: 'move', class: 'shove' }, () => 'Wren') === 'Wren tried to move you — your “Allow being moved” switch is off'
    && refusedNotice({ type: 'body-refused', from: 'u-wren', gate: 'touch', class: 'pose' }, () => 'Wren') === 'Wren tried to touch you — your “Allow being posed and touched” switch is off'
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

// review full-260 #2: a guest has no stable identity (a fresh actor id per connection, server/directory.ts resolve), so a
// guest's list entry lasts for their visit: kept in memory, never in localStorage; and an id the server says no one wears
// any more (refused code "gone") is pruned from storage, not retried. Mutation: save the visit lists, or drop the gone prune.
{ const before = store.get('ew-body-consent');
  check('a guest on a list is listed and sent, marked for this visit', C.setListed('u-guest', 'block', 'Gus', { guest: true }) && C.listOf('u-guest') === 'block' && C.bodyTable().block.includes('u-guest') && C.listed('block').some((p: any) => p.id === 'u-guest' && p.visit === true), JSON.stringify(C.listed('block')));
  check('…and never stored: a refresh (theirs gives them a new id; mine reloads storage) keeps no dead id', !(store.get('ew-body-consent') ?? '').includes('u-guest') && before === store.get('ew-body-consent'), store.get('ew-body-consent'));
  C.setListed('u-guest', null, 'Gus', { guest: true });
  check('…and taking a guest off keeps no unlist in storage either', !(store.get('ew-body-consent') ?? '').includes('u-guest') && C.listOf('u-guest') === null, store.get('ew-body-consent')); }
{ C.setListed('u-dead', 'block', 'Old guest');   // as stored before this fix
  const P: any = { consent: Object.create(null) }; const sent: any[] = []; const toasts: string[] = [];
  const send = async (_: string, a: any) => { sent.push(a); if (a.block === 'u-dead') return { ok: false, refused: { code: 'gone', reason: 'no one wears that identity now' } }; return Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me') }; };
  const s = makeConsentSync({ table: C.bodyTable, send, toast: (t: string) => toasts.push(t), on: () => {}, later: () => {}, gone: C.forget }); await s.sync();
  check('a stored id the server says is gone is pruned from storage, with no failure toast', !(store.get('ew-body-consent') ?? '').includes('u-dead') && C.listOf('u-dead') === null && !C.bodyTable().unlist.includes('u-dead') && toasts.length === 0 && !s.failing(), JSON.stringify({ toasts, st: store.get('ew-body-consent') }));
  sent.length = 0; await s.sync(); check('…and is not sent again', !sent.some((a) => a.block === 'u-dead'), JSON.stringify(sent)); }

// review full-260 L9: the authority's lists are the source; local keeps a queue of my own changes, drained as they land.
// Two devices no longer overwrite each other's lists on arrival, and an unlist isn't kept and replayed forever. A block
// (narrower) follows me into other worlds for BLOCK_FOLLOW_MS; an allow or unlist (wider) lands only in the world I made it
// in. Mutation: replay the whole local list (the old sync), never drain an unlist, or stop a block following.
{ const fresh = async (tag: string, kv: Record<string, string> = {}) => { store.clear(); for (const [k, v] of Object.entries(kv)) store.set(k, v); return await import(`../client/lib/consent.js?dev=${tag}`); };
  const auth = (P: any = { consent: Object.create(null) }) => { const sent: any[] = []; return { P, sent, send: async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me') }; } }; };
  const syncer = (D: any, A: any) => makeConsentSync({ table: D.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {}, held: D.noteHeld, landed: D.landed, gone: D.forget });
  // device B was told "always allow X" long ago (stored, before queues); device A since blocked X in this world
  const B = await fresh('b', { 'ew-body-consent': JSON.stringify({ v: 4, allow: { 'u-xxx': 'X' }, block: {}, unlist: ['u-old'] }) }); B.useWorld('w1');
  const A1 = auth(); setConsent(A1.P, 'me', { block: 'u-xxx' }); setConsent(A1.P, 'me', { allow: 'u-old' }); await syncer(B, A1).sync();
  check('L9a a second device\'s stale allow does not overwrite the block the world holds (no allow sent), and it shows the world\'s block', !A1.sent.some((a) => a.allow === 'u-xxx') && tableOf(A1.P, 'me').block.includes('u-xxx') && B.listOf('u-xxx') === 'block', JSON.stringify({ sent: A1.sent, l: B.listOf('u-xxx') }));
  A1.sent.length = 0; await syncer(B, A1).sync();
  check('L9b …and a stored unlist from before takes them off this world\'s allow list once, and is not sent here again', !tableOf(A1.P, 'me').allow.includes('u-old') && !A1.sent.some((a) => a.unlist === 'u-old'), JSON.stringify({ sent: A1.sent, st: store.get('ew-body-consent') }));
  const D = await fresh('d'); D.useWorld('w1'); const W1 = auth(); const s1 = syncer(D, W1);
  D.setListed('u-yyy', 'block', 'Y'); D.setListed('u-zzz', 'allow', 'Z'); await s1.sync(); D.setListed('u-zzz', null); await s1.sync();
  check('L9c my own changes land, then drain: the unlist is sent once and not kept', W1.sent.filter((a) => a.unlist === 'u-zzz').length === 1 && !tableOf(W1.P, 'me').allow.includes('u-zzz') && !D.bodyTable().unlist.includes('u-zzz') && !(store.get('ew-body-consent') ?? '').includes('"unlist":["u-zzz"'), JSON.stringify({ sent: W1.sent, t: D.bodyTable() }));
  W1.sent.length = 0; await s1.sync(); check('L9d …and a synced world is sent nothing again', W1.sent.length === 1, JSON.stringify(W1.sent));
  D.setListed('u-zzz', 'allow', 'Z'); await s1.sync(); D.useWorld('w2'); const W2 = auth(); setConsent(W2.P, 'me', { allow: 'u-ppp' }); await syncer(D, W2).sync();
  check('L9e in another world, my block follows me (narrower), my allow does not (wider), and its own lists stand', tableOf(W2.P, 'me').block.includes('u-yyy') && !tableOf(W2.P, 'me').allow.includes('u-zzz') && tableOf(W2.P, 'me').allow.includes('u-ppp') && !W2.sent.some((a) => a.unlist), JSON.stringify({ sent: W2.sent, t: tableOf(W2.P, 'me') }));
  const old = JSON.parse(store.get('ew-body-consent') ?? '{}'); for (const q of old.queue ?? []) q.at -= 31 * 86_400_000;
  const E = await fresh('e', { 'ew-body-consent': JSON.stringify(old) }); E.useWorld('w3'); const W3 = auth(); await syncer(E, W3).sync();
  check('L9f a block older than BLOCK_FOLLOW_MS has stopped following (the queue is bounded)', !W3.sent.some((a) => a.block === 'u-yyy') && !(store.get('ew-body-consent') ?? '').includes('"queue":[{'), JSON.stringify({ sent: W3.sent, st: store.get('ew-body-consent') }));
  // review delta-260 #2: a stored unlist from before names no world, so it follows like a block (narrower only): never drained where nothing is listed, never lifting a block
  const G = await fresh('g', { 'ew-body-consent': JSON.stringify({ v: 4, allow: {}, block: {}, unlist: ['u-y'] }) }); G.useWorld('a'); const Wa = auth(); await syncer(G, Wa).sync();
  G.useWorld('b'); const Wb = auth(); setConsent(Wb.P, 'me', { allow: 'u-y' }); await syncer(G, Wb).sync();
  check('L9g an old unlist, nothing listed in the first world, still takes Y off the next world\'s allow list', !Wa.sent.some((a) => a.unlist) && Wb.sent.some((a) => a.unlist === 'u-y') && !tableOf(Wb.P, 'me').allow.includes('u-y'), JSON.stringify({ a: Wa.sent, b: Wb.sent, t: tableOf(Wb.P, 'me') }));
  G.useWorld('c'); const Wc = auth(); setConsent(Wc.P, 'me', { block: 'u-y' }); await syncer(G, Wc).sync();
  check('L9h …and never lifts a block a world holds (its origin unknown: only ever narrower)', !Wc.sent.some((a) => a.unlist) && tableOf(Wc.P, 'me').block.includes('u-y'), JSON.stringify({ c: Wc.sent, t: tableOf(Wc.P, 'me') }));
  const aged = JSON.parse(store.get('ew-body-consent') ?? '{}'); for (const q of aged.queue ?? []) q.at -= 31 * 86_400_000;
  const H = await fresh('h', { 'ew-body-consent': JSON.stringify(aged) }); H.useWorld('d'); const Wd = auth(); setConsent(Wd.P, 'me', { allow: 'u-y' }); await syncer(H, Wd).sync();
  check('L9i …and stops following after BLOCK_FOLLOW_MS, as a block does', !Wd.sent.some((a) => a.unlist), JSON.stringify(Wd.sent)); }

// review delta-260 L-F: a block's 30 days are said where the lists are (Settings ▸ body, and the toast when I block someone)
{ const fs = await import('node:fs'), w = String((C as any).BLOCK_FOLLOW_WORDS ?? '');
  check('L-F the panel and the toast say a block follows into other worlds for 30 days', /30 days/.test(w) && C.BLOCK_FOLLOW_MS === 30 * 86_400_000
    && /BLOCK_FOLLOW_WORDS/.test(fs.readFileSync(new URL('../client/lib/consentpanel.js', import.meta.url), 'utf8')) && /BLOCK_FOLLOW_WORDS/.test(fs.readFileSync(new URL('../client/lib/people.js', import.meta.url), 'utf8')), w); }

// review 1.3: the switches show the gate in force: mine, else the authority's read (my table's, else the world's body-default), else the built-in
{ store.clear(); const G = await import('../client/lib/consent.js?gates=world');
  const P: any = { consent: Object.create(null), bodyDefault: { touch: true } };
  const send = async (_: string, a: any) => Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me'), world: { ...DEFAULT_GATES, ...worldGates(P.bodyDefault) } };   // bodyconsent.js's read
  const s = makeConsentSync({ table: G.bodyTable, send, toast: () => {}, on: () => {}, later: () => {}, held: G.noteHeld, landed: G.landed });
  check('1.3 before any read, a never-chosen Allow being posed and touched shows the built-in (off)', !G.gate('touch'));
  await s.sync();
  check('1.3 in a world whose body-default turns touch on, a never-chosen Allow being posed and touched shows on (the gate in force)', G.gate('touch') && decide(P, 'pal', 'me', 'pose').mode === 'allow');
  G.setGate('touch', false); await s.sync();
  check('…and turning it off is one change: it shows off, and the authority refuses a stranger\'s pose', !G.gate('touch') && decide(P, 'pal', 'me', 'pose').mode === 'deny', JSON.stringify(tableOf(P, 'me'))); }

// #260 follow-up B: a gate the server's migration closed stays closed until I turn it on in that world; a browser value I chose before doesn't reopen it
{ const fresh = async (tag: string, kv: Record<string, string> = {}) => { store.clear(); for (const [k, v] of Object.entries(kv)) store.set(k, v); return await import(`../client/lib/consent.js?reopen=${tag}`); };
  const migrated = () => { const P: any = { consent: Object.create(null), consentShape: 3 }; P.consent.me = { preset: 'open', cells: { everyone: { pose: 'allow', shove: 'allow', displace: 'allow', touch: 'allow', intimate: 'allow' }, friends: { displace: 'ask', pose: 'allow', intimate: 'allow' } }, friends: ['pal'] }; P.consent.pal = { friends: ['me'] }; migratePresence(P);
    const sent: any[] = []; return { P, sent, send: async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me') }; } }; };
  const syncer = (D: any, A: any) => makeConsentSync({ table: D.bodyTable, send: A.send, toast: () => {}, on: () => {}, later: () => {}, held: D.noteHeld, landed: D.landed, gone: D.forget });
  const D = await fresh('b1', { 'ew-body-switch': 'accept' }); D.useWorld('w1'); const W1 = migrated(); await syncer(D, W1).sync();
  check('B1 a stored "accept" (move on) from before never reopens the move gate the server\'s migration closed: nothing sent, a stranger and the friend still can\'t displace, and Allow being moved shows off',
    D.bodyTable().move === true && !W1.sent.some((a) => 'move' in a) && W1.P.consent.me.move === false && decide(W1.P, 'stan', 'me', 'displace').mode === 'deny' && decide(W1.P, 'pal', 'me', 'displace').mode === 'deny' && !D.gate('move'), JSON.stringify({ sent: W1.sent, t: W1.P.consent.me }));
  const opened = D.setGate('move', true); await syncer(D, W1).sync();
  check('B2 …turning Allow being moved on here reopens it (sent once, then landed: not kept)', opened && W1.sent.some((a) => a.move === true) && decide(W1.P, 'stan', 'me', 'displace').mode === 'allow' && D.gate('move') && D.bodyTable().opened.length === 0, JSON.stringify({ sent: W1.sent, b: D.bodyTable() }));
  D.useWorld('w2'); const W2 = migrated(); await syncer(D, W2).sync();
  check('B3 …and only here: another world whose migration closed it stays closed (wider lands where it was made)', !W2.sent.some((a) => 'move' in a) && decide(W2.P, 'stan', 'me', 'displace').mode === 'deny' && !D.gate('move'), JSON.stringify(W2.sent));
  D.setGate('move', false); D.useWorld('w3'); const W3: any = (() => { const P: any = { consent: Object.create(null) }; setConsent(P, 'me', { move: true }); const sent: any[] = []; return { P, sent, send: async (_: string, a: any) => { sent.push(a); return Object.keys(a).length ? setConsent(P, 'me', a) : { ok: true, table: tableOf(P, 'me') }; } }; })();
  await syncer(D, W3).sync();
  check('B4 …while an off still follows me everywhere (narrower)', W3.sent.some((a) => a.move === false) && decide(W3.P, 'stan', 'me', 'shove').mode === 'deny', JSON.stringify(W3.sent)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

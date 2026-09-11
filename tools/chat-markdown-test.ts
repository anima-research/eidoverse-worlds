// chat (client/lib/chat.js) — the log's text discipline and its small state machines, run headless against
// the REAL module (same stubs as chat-log-test): inline markdown builds ELEMENTS from **bold** / *i* / `code`
// but never parses HTML out of a message; the VR quad's `recent` tail is capped at 12; account() counts
// unread rows and mentions only while the reader is away; the people pane swaps sides from the gear.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/chat-markdown-test.ts
//
// Each block names the product line that would silence it:
//   inline() writing a run through innerHTML     → "an HTML tag in a message is literal text" goes red
//   the `recent` cap (12) removed                → "recent tail never exceeds 12" goes red
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: 'chat-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./chat-core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./chat-base-stub.mjs') }));
    b.onResolve({ filter: /^\.\/frames\.js$/ }, () => ({ path: here('./chat-frames-stub.mjs') }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here('./chat-net-stub.mjs') }));
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const { logChat, initChat, chat, recentChat, chatMarkdownOn } = await import('../client/lib/chat.js');
const { frameStub } = await import('./chat-frames-stub.mjs');
// MUST come from the stub graph: chat.js resolves './base.js' to
// chat-base-stub.mjs (which re-exports the core stub), so importing
// ../client/lib/base.js by path yields a DIFFERENT bus object and every
// emit lands where paintSide is not listening — assertions that cannot fail.
const { bus } = await import('./chat-base-stub.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
let roster: any[] = [{ id: 'keir', agent: true }, { id: 'rab' }];
initChat({ send: () => {}, people: () => roster });
const log = () => document.getElementById('chatlog')!;
const rows = () => [...log().children].filter((c) => !c.classList.contains('sys')) as HTMLElement[];
const lastBody = () => rows().at(-1)!.querySelector('.body')!;
let seq = 1;
const say = (who: string, text: string, kind = '') => { logChat(who, text, kind, { seq: seq++, ts: Date.now() }); return lastBody(); };
const reset = () => { log().innerHTML = ''; chat.markRead(); };

console.log('CHAT MARKDOWN — a message is text; markup in it is literal');
check('markdown is on by default', chatMarkdownOn() === true);
{ const b = say('rab', 'look <b>bold?</b> no');
  check('an HTML tag in a message is literal text (no <b> element)', b.querySelector('b') === null && b.textContent === 'look <b>bold?</b> no', b.innerHTML); }
{ const b = say('rab', '<img src=x onerror="alert(1)">');
  check('<img onerror> never becomes an element', b.querySelector('img') === null && b.textContent === '<img src=x onerror="alert(1)">', b.innerHTML);
  check('…and the log holds no <img> anywhere', log().querySelector('img') === null); }
{ const b = say('rab', 'x <script>1</script> **y** <i>z</i>');
  check('markup beside real markdown stays literal', b.querySelector('script') === null && b.querySelector('i') === null && b.querySelector('b')?.textContent === 'y' && b.textContent === 'x <script>1</script> y <i>z</i>', b.innerHTML); }
{ const b = say('rab', '@keir <b>hi</b> https://x.test/a?b=1 <u>u</u>');
  check('mention + link runs: tags around them are literal too', b.querySelector('.mention')?.textContent === '@keir' && (b.querySelector('a.lnk') as HTMLAnchorElement)?.href === 'https://x.test/a?b=1' && !b.querySelector('b') && !b.querySelector('u') && b.textContent === '@keir <b>hi</b> https://x.test/a?b=1 <u>u</u>', b.innerHTML); }

console.log('CHAT MARKDOWN — **bold** / *i* / _i_ / `code` become elements');
{ const b = say('rab', 'say **loud** and *soft* and _low_ and `code` end');
  const tags = [...b.children].map((c) => `${c.tagName.toLowerCase()}:${c.textContent}`).join(' ');
  check('b / i / i / code elements, delimiters consumed', tags === 'b:loud i:soft i:low code:code' && b.textContent === 'say loud and soft and low and code end', `${tags} | ${b.textContent}`); }
{ const b = say('rab', 'a `<b>x</b>` b');
  check('markup INSIDE a code span is literal text of the <code>', b.querySelector('code')?.textContent === '<b>x</b>' && b.querySelector('b') === null, b.innerHTML); }
{ const b = say('rab', 'snake_case_name and 2*3*4 and **');
  check('intra-word _ and * are not markdown', b.children.length === 0 && b.textContent === 'snake_case_name and 2*3*4 and **', b.innerHTML); }
{ // the gear's markdown toggle: off = plain text, on again = elements
  const gear = frameStub.body.querySelector('.chat-gear') as HTMLButtonElement;
  gear.onclick!(Object.assign(new Event('click'), { stopPropagation() {} }));
  const pop = frameStub.body.querySelector('.chat-gearpop') as HTMLElement;
  check('the gear opens its popover', pop.hidden === false && !!pop.querySelector('[data-md="0"]'));
  pop.onclick!({ target: pop.querySelector('[data-md="0"]') } as any);
  check('markdown off is observable', chatMarkdownOn() === false);
  const b = say('rab', '**still literal** <b>and still no element</b>');
  check('off: markdown stays literal AND markup stays literal', b.children.length === 0 && b.textContent === '**still literal** <b>and still no element</b>', b.innerHTML);
  pop.onclick!({ target: pop.querySelector('[data-md="1"]') } as any);
  check('back on', chatMarkdownOn() === true && say('rab', '**b**').querySelector('b')?.textContent === 'b'); }

console.log('CHAT — the VR quad\'s recent tail');
reset();
for (let i = 0; i < 20; i++) say('rab', `line ${i}`);
{ const r = recentChat();
  check('recent tail never exceeds 12', r.length === 12, `${r.length}`);
  check('…and holds the LAST twelve, newest last', r[0].text === 'line 8' && r[11].text === 'line 19' && r[11].who === 'rab', JSON.stringify(r.map((x: any) => x.text)));
  check('recentChat() is a copy', (r.push({}), recentChat().length === 12));
  say('rab', 'x'.repeat(200));
  check('a line is cut to 140 chars for the quad', recentChat().at(-1).text.length === 140); }

console.log('CHAT — account(): unread only while the reader is away');
reset(); frameStub.visible = true;
say('rab', 'seen'); say('keir', 'tester hi', 'agent');
check('frame visible + at bottom: nothing counts', JSON.stringify(chat.unreadCounts()) === '{"unread":0,"mentions":0}', JSON.stringify(chat.unreadCounts()));
frameStub.visible = false;
say('rab', 'one'); say('rab', 'two');
check('two plain lines while hidden → unread 2, mentions 0', JSON.stringify(chat.unreadCounts()) === '{"unread":2,"mentions":0}', JSON.stringify(chat.unreadCounts()));
say('keir', 'hey @tester', 'agent');
check('a mention → unread 3, mentions 1', JSON.stringify(chat.unreadCounts()) === '{"unread":3,"mentions":1}', JSON.stringify(chat.unreadCounts()));
say('keir', 'Tester, bare whole word', 'agent');
check('a bare whole-word name is a mention too (case-insensitive) → mentions 2', chat.unreadCounts().mentions === 2, JSON.stringify(chat.unreadCounts()));
say('keir', 'testers are not you', 'agent');
check('a longer word is NOT a mention → mentions stay 2, unread 5', JSON.stringify(chat.unreadCounts()) === '{"unread":5,"mentions":2}', JSON.stringify(chat.unreadCounts()));
say('*', 'the world turns');
check('a system line never counts', chat.unreadCounts().unread === 5, JSON.stringify(chat.unreadCounts()));
say('tester', 'my own line');
check('my own line counts as unread but never as a mention of me', JSON.stringify(chat.unreadCounts()) === '{"unread":6,"mentions":2}', JSON.stringify(chat.unreadCounts()));
{ const jump = document.getElementById('chat-jump')!;
  check('the jump pill shows the counts', jump.style.display === 'block' && /6 new/.test(jump.textContent!) && /2 ✱/.test(jump.textContent!) && jump.classList.contains('ping'), jump.textContent!); }
chat.markRead();
check('markRead zeroes both', JSON.stringify(chat.unreadCounts()) === '{"unread":0,"mentions":0}' && document.getElementById('chat-jump')!.style.display === 'none');
frameStub.visible = true;
say('rab', 'back');
check('visible again: nothing counts', chat.unreadCounts().unread === 0);

console.log('CHAT — the people pane swaps sides');
{ // A DECOY mod panel first, carrying the same PUBLIC classes, placed BEFORE
  // the real markup in the same body — mods.js/registerPanel mount into frame
  // bodies after initChat's innerHTML, so this is reachable. applySide must
  // still write onto the nodes initChat built, not onto these.
  const decoy = document.createElement('div');
  decoy.innerHTML = `<div class="chat-cols side-left"><button class="chat-side-tog">X</button><div class="chat-side"></div></div>`;
  frameStub.body.prepend(decoy);
  const dCols = decoy.querySelector('.chat-cols')!, dTog = decoy.querySelector('.chat-side-tog')!;
  const dBefore = { cls: dCols.className, txt: dTog.textContent };

  const cols = frameStub.body.querySelector(':scope > .chat-cols')!, tog = cols.querySelector(':scope > .chat-side-tog')!;
  check('default: pane on the LEFT, closed, chevron points right (›)', cols.classList.contains('side-left') && cols.querySelector(':scope > .chat-side')!.classList.contains('closed') && tog.textContent === '›', tog.textContent!);
  const pop = frameStub.body.querySelector('.chat-gearpop') as HTMLElement;
  pop.onclick!({ target: pop.querySelector('[data-side="right"]') } as any);
  check('right: side-left dropped, chevron mirrored (‹)', !cols.classList.contains('side-left') && tog.textContent === '‹', tog.textContent!);
  check('the choice persists', JSON.parse(localStorage.getItem('ew-chat-side')!).pos === 'right');
  check('the popover marks the live side', pop.querySelector('[data-side="right"]')!.classList.contains('on') && !pop.querySelector('[data-side="left"]')!.classList.contains('on'));
  (tog as HTMLElement).onclick!(new Event('click'));
  check('opening the pane on the right: › (it will close rightward), width applied', tog.textContent === '›' && (cols.querySelector(':scope > .chat-side') as HTMLElement).style.width === '150px' && !cols.classList.contains('side-closed'), tog.textContent!);
  pop.onclick!({ target: pop.querySelector('[data-side="left"]') } as any);
  check('back to the left while open: side-left, chevron ‹', cols.classList.contains('side-left') && tog.textContent === '‹' && JSON.parse(localStorage.getItem('ew-chat-side')!).pos === 'left', tog.textContent!);
  const realSide = cols.querySelector(':scope > .chat-side')! as HTMLElement;
  check('the pane lists who is here', /2 others here/.test(realSide.querySelector(':scope > .chat-side-head')!.textContent!) && realSide.querySelectorAll('.who-row').length === 2);

  // S1/F4: a mod's markup INSIDE the real .chat-side. My earlier claim that a
  // mod cannot reach here was FALSE — mods.js:88 hands a mod makeFrame and
  // frames.js returns the LIVE chat frame for a bare id, so a local mod (an
  // in-page ES module, mods.js:5-8) can mount into this very body. Planted
  // FIRST so an unbounded lookup finds it before the real head: the captures
  // must address the nodes initChat wrote, not the first match by class.
  const nestedMod = document.createElement('div');
  nestedMod.className = 'mod-inside';
  nestedMod.innerHTML = `<div class="chat-side"><div class="chat-side-head">MOD-HEAD</div></div>`;
  // PREPENDED INTO cols, ahead of the real .chat-side — not nested inside it.
  // A descendant of the real pane can never win an unbounded lookup (its own
  // ancestor comes first in document order), so nesting it would leave the
  // capture's `:scope >` bound untested.
  cols.prepend(nestedMod);
  const modHead = nestedMod.querySelector('.chat-side-head')!;
  roster = [{ id: 'keir', agent: true }, { id: 'rab' }, { id: 'zzz' }];
  // The pane is OPEN here (the check above read a painted head). paintSide bails
  // at `if (!side || !sideSt.open) return`, so a closed pane would skip the very
  // lines S1/F4 mutate and both mutants would survive — which is exactly what
  // happened when this drove chat.open() (that opens the FRAME, not the pane).
  bus.emit('roster');                                    // the real trigger, chat.js:714
  check('a mod .chat-side-head nested inside the real pane is never written to (S1)',
    modHead.textContent === 'MOD-HEAD', modHead.textContent!);
  // Exactly 3 — an alternation that also accepts the pre-repaint text cannot fail.
  check('...and the REAL head is the one that got the update (F4)',
    realSide.querySelector(':scope > .chat-side-head')!.textContent === '3 others here',
    realSide.querySelector(':scope > .chat-side-head')!.textContent!);
  nestedMod.remove();

  // LIFETIME (M-L): a capture fixes WHICH node, not that it still EXISTS. A mod
  // can remove it; the handle stays valid, writes land on an orphan, nothing
  // renders, no error. Quieter than the node-theft the capture was added to
  // stop. sideEl reads through ?.isConnected, so a detached pane reads as
  // absent and paintSide bails at its first line instead of painting a ghost.
  const detached = realSide;
  const headBefore = detached.querySelector(':scope > .chat-side-head')!.textContent;
  detached.remove();
  roster = [{ id: 'keir', agent: true }, { id: 'rab' }, { id: 'zzz' }, { id: 'qqq' }];
  let threw = '';
  try { bus.emit('roster'); } catch (e) { threw = String(e); }
  check('a DETACHED side pane is not painted: the orphan keeps its last text, and no throw',
    threw === '' && detached.querySelector(':scope > .chat-side-head')!.textContent === headBefore,
    `threw=${threw} head=${detached.querySelector(':scope > .chat-side-head')!.textContent}`);
  cols.append(detached);                                  // put it back for later blocks
  // M-D: paintSide's `!sideSt.open` guard. bus.on('roster'|'presence:me')
  // (chat.js:714-715) call paintSide with NO open-check of their own, so
  // dropping it repaints a CLOSED pane on every roster event. (The 2s tick at
  // :716 gates itself on sideSt.open — it is not the path.)
  // paintSide returns early when closed — it does NOT clear. So the binding is
  // "the text does not CHANGE", not "the text is empty". (An earlier draft
  // asserted === '' and failed: my assertion presumed a clean slate that never
  // existed. The product was right; the test was wrong.)
  (tog as HTMLElement).onclick!(new Event('click'));          // close it
  const frozen = realSide.querySelector(':scope > .chat-side-head')!.textContent;
  roster = [{ id: 'keir', agent: true }, { id: 'rab' }, { id: 'zzz' }];   // a roster CHANGE while closed
  bus.emit('roster');                                   // the REAL trigger (chat.js:714)
  check('a CLOSED pane is not repainted (roster events must respect the open guard)',
    realSide.classList.contains('closed') && realSide.querySelector(':scope > .chat-side-head')!.textContent === frozen,
    `${realSide.className} / "${realSide.querySelector(':scope > .chat-side-head')!.textContent}" (was "${frozen}")`);
  (tog as HTMLElement).onclick!(new Event('click'));          // reopen for the decoy check
  // applySide/paintSide/applyChatPrefs must never have touched the decoy
  check('applySide writes onto the nodes initChat built, never a mod panel carrying the same classes', dCols.className === dBefore.cls && dTog.textContent === dBefore.txt, `${dCols.className} / ${dTog.textContent}`);
  decoy.remove(); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

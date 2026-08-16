// voicelist — THE VOICES YOU HAVE, AS A LIST.
//
// R, 2026-08-09: "the add-remove buttons aren't very intuitive... I feel like
// the current implementation is clunky. Is there another UI you're aware of that
// would be more suitable?"
//
// She was right, and the reason is a rule worth keeping: a DROPDOWN is for
// choosing among options someone else fixed. The moment the options are ones the
// user adds and removes, the list wants to be visible — because "what do I have?"
// and "get rid of that one" both become questions the UI has to answer without
// being opened first. macOS System Settings, VS Code, OBS all use a visible list
// with per-row affordances for exactly this.
//
// The buttons were clunky for a specific, diagnosable reason: a "−" beside a
// dropdown acts on *whatever is currently selected*, so you must select a thing
// in order to destroy it, and the button cannot say which thing it means. Here
// the × lives ON the row, so the target is never ambiguous and there is nothing
// to explain.
//
// The other half of the clunk: the old dropdown mixed NOUNS ("en_US-amy-low")
// with VERBS ("voice file on this computer…") and STATUS ("loading voices…") in
// one list of supposed choices. Verbs are rows here too, but visibly separate
// and at the bottom, where an "add" affordance belongs.
const ROW = `
.vl { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
/* The voices SCROLL, the add-rows do not (R, 2026-08-09: "should the model list
   get its own little scrolling window pane, just in case people add a lot?").
   max-height rather than a fixed one, so one voice does not sit in an empty box
   — it grows to about four rows and only then scrolls. */
.vl-pane { display: flex; flex-direction: column; gap: 2px; max-height: 88px;
  overflow-y: auto; overscroll-behavior: contain; }
.vl-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px;
  border-radius: 3px; cursor: pointer; }
/* --accent-dk is what the house uses for "this row is active/hovered"
   (index.html: .card.on). #2a2a2a was a neutral grey borrowed from nowhere —
   it read as a different application's hover. */
.vl-row:hover { background: var(--accent-dk); }
.vl-row .vl-x { opacity: 0; margin-left: auto; padding: 0 4px; border: 0;
  background: none; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
/* The × appears on hover OR on keyboard focus — hover-only affordances are
   invisible to anyone navigating by keyboard, and this one is destructive, so
   it must be reachable without a mouse. */
.vl-row:hover .vl-x, .vl-row .vl-x:focus { opacity: .75; }
.vl-row .vl-x:hover { opacity: 1; color: #f88; }
.vl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vl-note { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; }
.vl-loading { opacity: .85; }
.vl-add { opacity: .6; }
.vl-add:hover { opacity: 1; }
/* 🔴 VOICES ARE NOUNS, ADD-ROWS ARE VERBS — do not sit them at one indent
   (R, 2026-08-09: "can you indent or un-indent the model selections vs the add
   buttons to distinguish them more?"). The voice rows carry a ●/○ marker and the
   add rows do not, so they were ALREADY ragged by a glyph width — this makes
   that deliberate instead of accidental. Voices hang under the marker column;
   the verbs sit flush left, below the list they act on, with a hairline to close
   the group. */
.vl-radio { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 12px;
  border: 1.5px solid currentColor; opacity: .45; box-sizing: border-box;
  transition: opacity .12s, box-shadow .12s; }
.vl-radio.on { opacity: 1; box-shadow: inset 0 0 0 2.5px currentColor; }
.vl-row:hover .vl-radio { opacity: .85; }
/* 🔴 THE GAP UNDER THE HAIRLINE WAS DOUBLE-COUNTED (R, 2026-08-16: "the row
   spacing between the graphic line above and the button below being a bit
   odd"). .vl-verbs-start contributes padding-top:6px AND .vl-add contributed
   margin-top:4px, so the first verb sat 10px below the rule while every other
   row sat 2px apart — one gap built by two rules that did not know about each
   other. The separator owns the space above the group; the row owns none. */
/* 🔴 AND THE BUTTON'S OWN PADDING WAS LOPSIDED. .vl-row gives every row
   2px 4px, but a voice row spends its left edge on the marker glyph
   (12px + 6px gap) while an add-row starts at its own glyph — so identical
   padding read as tight on the left and loose on the right, which is the
   "weirdly spaced within that button" R saw. One declaration, symmetric, and
   the noun/verb distinction is carried by the indent rule below rather than by
   padding doing two jobs.
   Written as ONE rule deliberately: a second .vl-add padding-left would be
   silently overridden by this shorthand — dead CSS that reads as intentional
   forever. */
.vl-add { padding: 3px 6px; }
.vl-row:not(.vl-add) { padding-left: 2px; }
.vl-verbs-start { border-top: 1px solid var(--edge);
  margin-top: 6px; padding-top: 6px; }
.vl-dim { color: var(--dim); font-style: italic; }
`;
function ensureCss() {
  if (document.getElementById('vl-css')) return;
  const st = document.createElement('style');
  st.id = 'vl-css';
  st.textContent = ROW;
  document.head.appendChild(st);
}
/** Build the list.
 *  items:    [{id, name, note}]   — the voices this person has
 *  selected: id | null
 *  on:       {select(id), remove(id), addFile(), addEndpoint()}
 */
export function renderVoiceList(host, { items, selected, on, busy, loading }) {
  ensureCss();
  host.className = 'vl';
  host.textContent = '';
  // The scrolling part. Only the voices go in here; the "+ add" rows stay below
  // it, so the thing you click to fix an empty list is never itself scrolled
  // out of view.
  const pane = document.createElement('div');
  pane.className = 'vl-pane';
  host.appendChild(pane);
  // NO EMPTY-STATE ROW. R: "you have 'add a voice below' twice now in a table
  // with no options. Maybe just the add buttons are sufficient." Right — the two
  // "+ add" rows below already say what to do, and a placeholder pointing AT
  // them is a caption for a sign. An empty pane collapses to nothing and the
  // verbs stand alone, which is the whole empty state.
  // 🔴 A VOICE BEING IMPORTED APPEARS IMMEDIATELY, WITH A RUNNING CLOCK.
  // R, 2026-08-09: "add the model to the list while it's loading and have a
  // second-ticker or animating dots so people know it didn't fail silently while
  // preparing the model". The first import pays the ~27s phonemizer build, and
  // without this the panel looks inert for half a minute — during which a real
  // failure and a slow success look exactly the same.
  //
  // A COUNTER, not a spinner: a spinner says "something is happening", a clock
  // says HOW LONG, which is the number that tells you whether to keep waiting.
  // 🔴 ONLY A GHOST IF THERE IS NO REAL ROW (R, 2026-08-09: "I'm seeing
  // en_US-glados-high listed twice when I try to load it"). A voice already in
  // the library HAS a row — adding a second one for its loading state shows the
  // same voice twice and the ghost reads as an error. Show the status ON the
  // existing row instead; the ghost is only for a voice being imported for the
  // first time, which genuinely is not in the list yet.
  if (loading && !items.some((it) => it.id === loading.id)) {
    const row = document.createElement('div');
    row.className = 'vl-row vl-loading';
    row.title = 'preparing this voice — the first one also builds the speech engine';
    const mark = document.createElement('span');
    mark.textContent = '◌';
    mark.style.opacity = '.6';
    const name = document.createElement('span');
    name.className = 'vl-name';
    name.textContent = loading.name;
    name.style.opacity = '.7';
    const clock = document.createElement('span');
    clock.className = 'vl-note';
    clock.style.opacity = '.7';
    // 🔴 ONE COUNTER, NOT TWO. The engine already tickers its own elapsed seconds
    // through onProgress ("preparing voice — 12s"), and this row was drawing a
    // SECOND clock beside it. Prefer the engine's text when it has any: it knows
    // which phase it is in, and two counters disagreeing by a second reads as
    // broken. Fall back to our own clock only when nothing was reported yet —
    // which is exactly the window R saw hang.
    const t0 = loading.since || Date.now();
    const tick = () => {
      if (!clock.isConnected) return clearInterval(timer);
      // The engine's own text already carries elapsed seconds ("compiling voice
      // model — 12s"). Use it when present. When it is NOT — the gap before the
      // first progress event, which is exactly where R saw a frozen label — run
      // our own clock so the row is never static. Never two clocks at once.
      const s = Math.round((Date.now() - t0) / 1000);
      clock.textContent = loading.status
        ? (/\d+s/.test(loading.status) ? loading.status : `${loading.status} — ${s}s`)
        : `starting — ${s}s`;
    };
    const timer = setInterval(tick, 1000);
    tick();
    row.append(mark, name, clock);
    host.appendChild(row);
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'vl-row';
    row.tabIndex = 0;
    row.title = it.note || it.name;
    const mark = document.createElement('span');
    // ● / ○ rather than a checkmark: it reads as "this one is live" at a glance
    // and needs no colour, which matters on a panel that must survive VR.
    // 🔴 A REAL RADIO, NOT A BULLET (R, 2026-08-09: "make the radio button more of
    // a radio button and not a bare dot, because it looks more like a list bullet
    // and not something that can be clicked"). ● and ○ are TYPOGRAPHY — they read
    // as list marks because that is what they are used for. A drawn ring with a
    // filled centre reads as a control: it has a border, it has a hit area, and
    // it changes on hover, which a glyph never does.
    mark.className = 'vl-radio' + (it.id === selected ? ' on' : '');
    mark.setAttribute('role', 'radio');
    mark.setAttribute('aria-checked', it.id === selected ? 'true' : 'false');
    const name = document.createElement('span');
    name.className = 'vl-name' + (it.dim ? ' vl-dim' : '');
    name.textContent = it.name;
    const x = document.createElement('button');
    x.className = 'vl-x';
    x.textContent = '×';
    // "forget … (the file stays on your computer)" — without that clause, a ×
    // next to a filename reads as "delete this file", which is the one thing it
    // must never be mistaken for.
    x.title = `forget ${it.name} — the file stays on your computer`;
    x.setAttribute('aria-label', `forget ${it.name}`);
    // NO CONFIRM, NO UNDO, deliberately (R, 2026-08-09). Removing forgets an
    // IndexedDB handle — your .onnx on disk is never touched — so the worst case
    // is re-picking a file, with the "+" row sitting directly below. A dialog
    // guarding a one-click mistake costs everyone friction to save one person a
    // file-open; an undo row is machinery for the same non-loss.
    // stopPropagation, or clicking × also selects the row it is destroying.
    x.onclick = (e) => { e.stopPropagation(); on.remove?.(it.id); };
      // A voice ALREADY in the list that is loading shows its status on its own
      // row — with the same clock the ghost row runs — rather than getting a
      // second entry. Without this, clicking a listed voice looked like nothing
      // happened at all.
      if (loading && loading.id === it.id) {
        row.classList.add('vl-loading');
        const st = document.createElement('span');
        st.className = 'vl-note';
        const t0 = loading.since || Date.now();
        const tickRow = () => {
          if (!st.isConnected) return clearInterval(rowTimer);
          const s = Math.round((Date.now() - t0) / 1000);
          st.textContent = loading.status
            ? (/\d+s/.test(loading.status) ? loading.status : `${loading.status} — ${s}s`)
            : `starting — ${s}s`;
        };
        const rowTimer = setInterval(tickRow, 1000);
        tickRow();
        row.append(mark, name, st, x);
      } else {
        row.append(mark, name, x);
      }
    row.onclick = () => on.select?.(it.id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.select?.(it.id); }
      // Delete/Backspace on a focused row is the list convention everywhere
      // else; without it the × is mouse-only in practice.
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); on.remove?.(it.id); }
    };
    pane.appendChild(row);
  }
  // THE VERBS, visibly below the nouns. When the list is empty these are the
  // whole UI, which is the correct empty state: the only thing you can do is
  // add one, so that is the only thing showing.
  const add = document.createElement('div');
  add.className = 'vl-row vl-add vl-verbs-start';
  add.tabIndex = 0;
  // SAY WHAT THE CONTROL WANTS, in the words of the thing it wants (R,
  // 2026-08-09: "I might label it text-to-speech model or something like that
  // just to make what this option is looking for most explicit"). "voice file"
  // could be a .wav; "text-to-speech model" can only be the thing it is. The two
  // rows deliberately do NOT share a noun — a .onnx is a model, an endpoint is a
  // running service, and calling both "voice" is what made the old field ask for
  // a file and get an address (R, 2026-08-08: "it looks like some kind of ip
  // string instead of a file path...?").
  // 🔴 STATUS LIVES IN EXACTLY ONE PLACE — the header note. This row used to echo
  // `busy` too, so "preparing voice…" appeared twice at once (R: "the 'preparing
  // voice' message repeats twice, once in the add line and once in the checkmark
  // bool line"). A verb row should always read as the verb; it goes quiet while
  // busy rather than becoming a second status display.
  add.textContent = '+ add a text-to-speech model…';
  add.title = 'a Piper .onnx model and its matching .onnx.json, from this computer';
  if (busy) { add.style.opacity = '.3'; add.style.pointerEvents = 'none'; }
  else {
    add.onclick = () => on.addFile?.();
    add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.addFile?.(); } };
  }
  host.appendChild(add);
  const ep = document.createElement('div');
  ep.className = 'vl-row vl-add';
  ep.tabIndex = 0;
  ep.textContent = '+ add a speech server…';
  ep.title = 'the address of a text-to-speech server you are already running (ws:// or http://)';
  ep.onclick = () => on.addEndpoint?.();
  ep.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.addEndpoint?.(); } };
  host.appendChild(ep);
  return host;
}
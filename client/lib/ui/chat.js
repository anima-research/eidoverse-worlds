// chat — the room's conversation, which in this world is also its history.
//
// Humans get what agents already had: typed mentions, a highlight when one arrives, unread state. Mentions use the
// door's name boundary (mention-rx.js), so a highlight and a ping agree (#232).

import { CONFIG, bus, colorFor, assignColors } from '../base.js';
import { mentionRx, mentionPattern } from './mention-rx.js';
// Not importing xrpanels.js (it reaches the engine, and chat.js also serves a client with no scene): the VR panel
// spec is exported (chatXRPanel) and main.js registers it.
import { lastWhy } from '../debuglog.js';
import { initAttention, mountAttentionControls } from './attention.js';
import { makeFrame } from './windows.js';
import { fsvg } from './icons.js';
import { requestHistory } from '../net.js';
// only the registry, never handlers.js, or the cycle chat→handlers→net→chat closes; the registry is a pure table
import { COMMANDS, resolveCommand } from './commands/registry.js';
import { register as registerAction } from './actions.js';
import { escapeHtml as esc } from './markup.js';
import { versionReady } from '../version.js';

const MAX_LINES = 400;
const HISTORY = 'ew-chat-history';

let frame = null;
let logEl = null;
let jumpEl = null;   // the unread pill (paintUnread)
let inputEl = null;
let onSend = null;
const recent = [];   // the log's tail, for the VR quad
export const recentChat = () => recent.slice();
let onTyping = () => {};
let getPeople = () => [];
// the person menu and badges (client/lib/ui/people.js), injected by main.js: a static import here would close the
// chat → people → net → chat cycle. Absent (a page without it), rows are plain and the menu is Message alone.
let personUi = null;

// 'all' | 'mentions' | 'system'. Every tab is a view of the one public room: world chat has no private channel
// (direct messages are planned at the identity level, not here).
let filter = 'all';
let unread = 0, unreadMentions = 0;
let lastAuthor = null, lastAt = 0, lastLineEl = null;
const sentHistory = [];             // up-arrow recall
let historyIdx = -1;

// ---------------------------------------------------------------- mentions

export function mentionsMe(text) {
  return mentionRx(CONFIG.name).test(String(text ?? ''));
}

// Standard inline markdown, nothing more: **bold**, *italic* / _italic_, `code`. Text nodes only; no HTML is ever
// parsed from a message. Off = plain text.
const MD_RX = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|((?<![\w*])\*([^*\n]+)\*(?![\w*]))|((?<!\w)_([^_\n]+)_(?!\w))/g;
function inline(run) {
  if (!chatMd) return document.createTextNode(run);
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const m of run.matchAll(MD_RX)) {
    if (m.index > i) frag.append(document.createTextNode(run.slice(i, m.index)));
    const el = document.createElement(m[1] ? 'b' : m[3] ? 'code' : 'i');
    el.textContent = m[2] ?? m[4] ?? m[6] ?? m[8];
    frag.append(el);
    i = m.index + m[0].length;
  }
  if (i < run.length) frag.append(document.createTextNode(run.slice(i)));
  return frag;
}
// a moderator's notice wears this first, fixed: their words can read like the house's, the header says they aren't
export const moderatorHeader = (world) => `From a moderator of world ‹${world}›, not from Eidoverse`;
/** Render text with mentions marked and links made clickable, without ever putting untrusted text through innerHTML. */
function renderBody(text, names, { links = true } = {}) {
  const frag = document.createDocumentFragment();
  const pattern = mentionPattern(names, { links });
  let i = 0;
  for (const m of String(text).matchAll(pattern)) {
    if (m.index > i) frag.append(inline(text.slice(i, m.index)));
    if (m[1]) {
      // trailing punctuation is prose, not address: "…?world=garden)" must not link to a world named "garden)"
      let url = m[1];
      const trail = /[)\]}>.,;:!?'"»]+$/.exec(url)?.[0] ?? '';
      if (trail) url = url.slice(0, -trail.length);
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = url;
      a.className = 'lnk';
      frag.append(a);
      if (trail) frag.append(document.createTextNode(trail));
    } else {
      const s = document.createElement('span');
      const bare = m[2].replace(/^@/, '');
      const isMe = bare.toLowerCase() === CONFIG.name.toLowerCase();
      s.className = isMe ? 'mention me' : 'mention';
      // a mention wears the mentioned person's colour, so "@fable" and fable's own lines read as one person; a
      // mention of YOU keeps the amber ping styling
      if (!isMe) s.style.color = colorFor(bare);
      s.textContent = m[2];
      frag.append(s);
    }
    i = m.index + m[0].length;
  }
  if (i < String(text).length) frag.append(inline(String(text).slice(i)));
  return frag;
}

// ---------------------------------------------------------------- scrollback
// A join carries recent chat, not the archive (that keeps arrival cheap). Reaching the top of the log asks the world
// for the page before it, so nothing said is out of reach.

// The arrival window is NOT a contiguous slice: trimRecentChat (shared/chatwindow.js) drops the loudest speaker's
// oldest lines, so paging from the oldest line SHOWN would jump the gap. The cursor comes only from what paging has
// walked: it starts at the present, skips lines already on screen, and slots the missing ones in by seq.
let pageCursor = null;              // next page is everything below this seq; null = from now
let loadingOlder = false;
let noMoreHistory = false;
let endMarker = null;               // the "beginning of this world" row, while the walk is finished
let trimmedThrough = -1;            // highest seq the MAX_LINES trim has removed
// the most pages of 40 a scroll walks past already-shown lines, and the most pages a re-join's catch-up fetches
const MAX_SKIP_PAGES = 25;

/** Start the backward walk again from no lower than `cursor` (null: the present) — after a trim passed it, a trim of
 *  the end marker, or a short catch-up. A restart only moves the cursor up; on-screen lines are skipped, so starting
 *  higher costs requests, not lines. The walk is unfinished again, so the end marker goes. */
function restartWalk(cursor) {
  if (pageCursor !== null && (cursor === null || cursor > pageCursor)) pageCursor = cursor;
  noMoreHistory = false;
  endMarker?.remove();
  endMarker = null;
}

/** Keep the log to MAX_LINES rows, dropping from the top. A trimmed row's seqs leave renderedSeqs so paging brings
 *  them back, and a walk that had passed it restarts from the present (a walk that ended at the present, first page
 *  empty, has passed everything). Trimming the end marker restarts the walk at its own cursor, so the next scroll-up
 *  asks once more and puts the marker back. */
function trimLog() {
  while (logEl.children.length > MAX_LINES) {
    const row = logEl.firstElementChild;
    if (row === endMarker) restartWalk(pageCursor);
    for (const seq of seqsOf(row)) {
      renderedSeqs.delete(seq);
      if (seq > trimmedThrough) trimmedThrough = seq;
      const passed = pageCursor === null ? noMoreHistory : seq >= pageCursor;
      if (passed) restartWalk(null);
    }
    row.remove();
  }
}

/** Every seq a row shows: one, or several when logChat merged the rest of a spoken utterance into it (dataset.seqs). */
function seqsOf(row) {
  if (row.dataset.seqs) return row.dataset.seqs.split(',').map(Number);
  return row.dataset.seq !== undefined ? [+row.dataset.seq] : [];
}

/** Put one paged-in line straight after the last row older than it (nothing older: on top). Not "before the first
 *  newer row": a spoken row is placed by when its speech began (logChat's t0) and can sit above lower seqs; spoken
 *  rows only move EARLIER, so the last older row is always a sound neighbour. */
function insertHistorical(who, text, ts, seq) {
  renderedSeqs.add(seq);
  const line = buildLine(who, text, { ts, historical: true });
  line.dataset.seq = String(seq);
  line.dataset.author = who;
  line.dataset.tsn = String(ts ?? 0);
  let prev = null;
  for (const c of logEl.children) {
    if (c.dataset.seq !== undefined && +c.dataset.seq < seq) prev = c;
  }
  if (prev) prev.after(line); else logEl.prepend(line);
  // a grouped row that now sits under a different speaker must reprint its name (sys rows pass through a group)
  let below = line.nextElementSibling;
  while (below && below.dataset.kind === 'system') below = below.nextElementSibling;
  if (below && below.dataset.author !== who) below.classList.remove('cont');
}

/** Hold the reader's view still while rows land around it: pin the first visible row (fills land above and below),
 *  measured in screen coordinates (offsetTop is relative to .chat-main, not the scrolling log). Returns the restore. */
function pinView() {
  const top = logEl.getBoundingClientRect().top;
  let anchor = null;
  for (const c of logEl.children) {
    const r = c.getBoundingClientRect();
    if (r.height && r.bottom > top) { anchor = c; break; }
  }
  if (!anchor) return () => {};
  const was = anchor.getBoundingClientRect().top;
  return () => {
    if (anchor.isConnected) logEl.scrollTop += anchor.getBoundingClientRect().top - was;
  };
}

/** Slot one page of history into the log; returns how many rows were new. */
function insertPage(entries) {
  const fresh = (entries ?? []).filter((e) => typeof e.seq === 'number' && !renderedSeqs.has(e.seq));
  if (!fresh.length) return 0;
  // a re-join's fill can land below the pinned row; a reader who was following the end must still be
  const following = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  const restore = pinView();
  for (const e of fresh) insertHistorical(e.actor, e.args?.text ?? '', e.ts, e.seq);
  restore();
  if (following) logEl.scrollTop = logEl.scrollHeight;
  return fresh.length;
}

/** A reconnect hands over a NEW arrival window, trimmed the same fair way, so lines said while the socket was down can
 *  be missing near the bottom. net.js calls this as a re-join's snapshot lands, with the last seq the old socket
 *  delivered; what came after is fetched newest first, up to MAX_SKIP_PAGES pages of 40, and slotted in. A catch-up
 *  that stops short (the cap, a failed page) restarts the backward walk no lower than where it stopped, so scrolling
 *  up reaches the rest. A first join has no hole to fill. */
export async function resyncChatAfter(seq) {
  if (!logEl || !renderedSeqs.size || typeof seq !== 'number' || seq < 0) return;
  let before = null;
  for (let page = 0; page < MAX_SKIP_PAGES; page++) {
    let r;
    try {
      r = await requestHistory({
        after: seq, ...(before !== null ? { before } : {}), limit: 40, verbs: ['say'],
      });
    } catch {
      restartWalk(before);           // this page and everything below it is still to fetch
      return;
    }
    if (!r.entries?.length) return;
    insertPage(r.entries);
    if (r.entries.length < 40) return;
    before = typeof r.oldestSeq === 'number' ? r.oldestSeq : r.entries[0].seq;
  }
  restartWalk(before);               // the cap, with a full last page: older lines may be left
}

/** Tell an arrival that what they are looking at is a window, not the room's whole memory, and roughly how small. */
export function noteHistoryContext({ total = null, shown = 0, spanMs = null } = {}) {
  if (!logEl) return;
  // one note, ever: every rejoin (each server restart) would prepend another
  logEl.querySelectorAll('.hist-note').forEach((n) => n.remove());
  // `total` is unknown for worlds folded before it was recorded: "showing 40 of 0" is worse than "there is more"
  const known = typeof total === 'number' && total > 0;
  if (known && total <= shown) return;
  const line = document.createElement('div');
  line.className = 'line sys hist-note';
  const span = spanMs != null && spanMs < 120000 && shown > 1
    ? ` — the last ${Math.max(1, Math.round(spanMs / 1000))}s of talking`
    : '';
  line.textContent = known
    ? `showing ${shown} of ${total.toLocaleString()} messages${span}. Scroll up for earlier.`
    : 'scroll up for earlier messages';
  logEl.prepend(line);
}

async function loadOlder() {
  if (loadingOlder || noMoreHistory || !logEl) return;
  loadingOlder = true;
  const marker = document.createElement('div');
  marker.className = 'line sys';
  marker.textContent = '… loading earlier messages';
  logEl.prepend(marker);
  try {
    let added = 0;
    for (let page = 0; !added && !noMoreHistory && page < MAX_SKIP_PAGES; page++) {
      const from = pageCursor;
      const r = await requestHistory({
        ...(from !== null ? { before: from } : {}),
        limit: 40, verbs: ['say'],
      });
      const entries = r.entries ?? [];
      // a trim or short catch-up during this page's flight restarted the walk (restartWalk is the only other cursor
      // writer): the lines still slot in, but the cursor and end-of-walk now come from the restart
      if (pageCursor === from) {
        if (entries.length) pageCursor = typeof r.oldestSeq === 'number' ? r.oldestSeq : entries[0].seq;
        if (!entries.length || !r.hasMore) noMoreHistory = true;
      }
      marker.remove();               // out before pinView measures, or it could be the anchor
      added = insertPage(entries);
      if (!added && !noMoreHistory) logEl.prepend(marker);
    }
    marker.remove();
    if (noMoreHistory) {
      endMarker = document.createElement('div');
      endMarker.className = 'line sys';
      endMarker.textContent = '— the beginning of this world —';
      logEl.prepend(endMarker);
    }
  } catch {
    // a failed page (no socket, or no answer) leaves the cursor as it stands; the next scroll-up asks again
    marker.remove();
  } finally { loadingOlder = false; }
}

// ---------------------------------------------------------------- lines

const pad2 = (n) => String(n).padStart(2, '0');

// Every seq this log has rendered: a reconnect re-renders the arrival window from state (the SAME seqs), and seq
// identity is chat's concept, so idempotence lives here. Synthetic lines carry no seq and are exempt.
const renderedSeqs = new Set();

export function logChat(who, text, kind = '', meta = {}) {
  if (typeof meta.seq === 'number' && meta.seq >= 0) {
    // ...or trimmed off the top: a re-join's window can replay it, and appending would put it under newer talk
    if (renderedSeqs.has(meta.seq) || meta.seq <= trimmedThrough) return;
    renderedSeqs.add(meta.seq);
  }
  // the VR quad reads the tail of the log from here, twelve deep
  recent.push({ who, text: String(text).slice(0, 140), kind });
  if (recent.length > 12) recent.shift();
  bus.emit('xr:repaint');
  // Spoken-utterance merge: only the continuation of one spoken utterance (spoken:true + same author + same utt);
  // an interrupted voice flushes the aired sentences and may finish the rest under the same utt. Everything else
  // keeps one row per message.
  if (meta.spoken && meta.utt != null && lastLineEl?.isConnected &&
      lastLineEl.dataset.author === who && lastLineEl.dataset.utt === String(meta.utt)) {
    const body = lastLineEl.querySelector('.body');
    if (body) {
      // the row now shows this say too: a trim must release its seq with the row's own
      if (typeof meta.seq === 'number' && meta.seq >= 0) {
        lastLineEl.dataset.seqs = [...seqsOf(lastLineEl), meta.seq].join(',');
      }
      const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
      body.append(' ', renderBody(text, namesForHighlight()));
      lastAt = Date.now();
      const newlyPinged =
        lastLineEl.dataset.kind !== 'mention' && mentionsMe(text);
      if (newlyPinged) { lastLineEl.classList.add('ping'); lastLineEl.dataset.kind = 'mention'; }
      account(lastLineEl, { who, text, merged: true, newlyPinged, wasAtBottom });
      return;
    }
  }
  const line = buildLine(who, text, { kind, ...meta });
  // seq is where paged-in history slots in around this line (insertHistorical)
  if (typeof meta.seq === 'number' && meta.seq >= 0) line.dataset.seq = String(meta.seq);
  line.dataset.author = who;
  line.dataset.tsn = String(meta.ts ?? Date.now());
  if (meta.spoken && meta.utt != null) line.dataset.utt = String(meta.utt);
  lastLineEl = line;

  const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  // Causal placement: a spoken utterance is an interval; its record arrives when the voice stops, but it began
  // earlier. A spoken say carrying t0 (air-start) slots in front of lines that arrived after its speech began.
  // Display only (server order stays arrival-truth); t0 is honoured only inside the spoken protocol and a bounded
  // window, since an old or foreign server might not clamp it.
  const ts = meta.ts ?? Date.now();
  const t0ok = meta.spoken && Number.isFinite(meta.t0) &&
    meta.t0 <= ts && meta.t0 >= ts - 300_000;
  let anchor = null;
  if (t0ok) {
    let c = logEl.lastElementChild;
    while (c && +(c.dataset.tsn ?? 0) > meta.t0) { anchor = c; c = c.previousElementSibling; }
  }
  if (anchor) {
    logEl.insertBefore(line, anchor);
    // the anchor may have been name-grouped with a line that's no longer its neighbour: the name must reprint
    if (anchor.dataset.author !== who) anchor.classList.remove('cont');
    // and the inserted line's own grouping is re-derived from its visual predecessor: buildLine grouped it by
    // arrival (lastAuthor), which disagrees exactly here. Sys lines pass through a group.
    let prev = line.previousElementSibling;
    while (prev && prev.dataset.kind === 'system') prev = prev.previousElementSibling;
    const near = !!prev && prev.dataset.author === who &&
      +(line.dataset.tsn ?? 0) - +(prev.dataset.tsn ?? 0) < 90_000;
    line.classList.toggle('cont', near);
  } else logEl.appendChild(line);
  trimLog();

  account(line, { who, text, merged: false,
    newlyPinged: line.dataset.kind === 'mention', wasAtBottom });
}

// One place turns a landed line into unread accounting, for new and merged rows alike, so nothing counts twice.
// `seen` = frame visible and pinned to the bottom.
function account(line, { who, text, merged, newlyPinged, wasAtBottom }) {
  const seen = frame.visible && wasAtBottom;
  if (seen) scrollToEnd();
  else {
    if (!merged && line.dataset.kind !== 'system') unread++;
    if (newlyPinged) unreadMentions++;
    paintUnread();
  }
  if (newlyPinged) bus.emit('pinged', { who, text });
}

// The chat-log line for a message; its overhead twin is avatar/nameplate.js makeBubble.
function buildLine(who, text, { kind = '', ts = Date.now(), historical = false, links = true } = {}) {
  const sys = who === '*';
  const mine = who === CONFIG.name;
  const pinged = !sys && !mine && mentionsMe(text);

  // the label comes from live presence (the word a speaker declared at the door, spec/PROTOCOL.md §6a: any word,
  // shown as said; none, no label), never from the log
  const declared = sys || mine ? null : (getPeople().find((p) => p.id === who)?.declares ?? null);

  const line = document.createElement('div');
  line.className = `line ${sys ? 'sys' : ''} ${mine ? 'me' : ''} ${declared ? 'declared' : ''} ${pinged ? 'ping' : ''}`;
  line.dataset.kind = sys ? 'system' : pinged ? 'mention' : 'chat';

  const now = ts;
  // grouping: consecutive lines from one author inside a short window drop the repeated name. Historical lines are
  // prepended out of order, so they never group.
  const grouped = !historical && !sys && who === lastAuthor && now - lastAt < 90_000;
  // sys lines pass through a group (an act narration between spoken sentences shouldn't reprint the name)
  if (!historical && !sys) { lastAuthor = who; lastAt = now; }
  if (grouped) line.classList.add('cont');
  if (historical) line.classList.add('old');

  const d = new Date(now);
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  t.title = d.toLocaleString();

  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  if (typeof declared === 'string' && declared) w.dataset.declares = declared;   // drawn after the name (index.html)
  // everyone gets their colour, including you: a name looks the same to every reader
  if (!sys) w.style.color = colorFor(who);
  // click a name to start a mention of them
  if (!sys && !mine) {
    w.onclick = () => { open(); insertMention(who); };
    w.style.cursor = 'pointer';
  }

  const b = document.createElement('span');
  b.className = 'body';
  b.append(renderBody(text, namesForHighlight(), { links }));

  line.append(t, w, b);
  applyFilter(line);
  return line;
}

// a join or a leave changes who has to be told apart, so colours are re-negotiated and the scrollback repainted
bus.on('roster', () => {
  const names = getPeople().map((p) => p.id);
  names.push(CONFIG.name);
  assignColors(names);
  repaintNames();
});

function repaintNames() {
  if (!logEl) return;
  for (const w of logEl.querySelectorAll('.line .who')) {
    const line = w.closest('.line');
    if (line.classList.contains('sys')) continue;
    w.style.color = colorFor(w.textContent);
  }
  for (const m of logEl.querySelectorAll('.body .mention:not(.me)')) {
    m.style.color = colorFor(m.textContent.replace(/^@/, ''));
  }
}

function namesForHighlight() {
  const names = new Set([CONFIG.name]);
  for (const p of getPeople()) if (p.id) names.add(p.id);
  return [...names];
}

function applyFilter(line) {
  const k = line.dataset.kind;
  const show = filter === 'all' ? true
    : filter === 'mentions' ? k === 'mention'
      : k === 'system';
  line.classList.toggle('filtered', !show);
}
function repaintFilter() {
  for (const l of logEl.children) applyFilter(l);
  scrollToEnd();
}

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
  unread = 0; unreadMentions = 0;
  paintUnread();
}

function paintUnread() {
  const jump = jumpEl;   // initChat's own node: a mod's earlier #chat-jump would win a document lookup
  if (jump) {
    jump.style.display = unread > 0 ? 'block' : 'none';
    jump.textContent = `${unread} new ${unreadMentions ? `· ${unreadMentions} ✱` : ''}↓`;
    jump.classList.toggle('ping', unreadMentions > 0);
  }
  frame?.badge(unread ? `<b class="${unreadMentions ? 'ping' : ''}">${unread}</b>` : '');
}

// ---------------------------------------------------------------- composer

// `@name ` at the caret, after a space when the caret follows a character the mention boundary (mention-rx.js OPEN)
// excludes: `hello@cairn` isn't read as a mention
function insertMention(name) {
  const s = inputEl.selectionStart ?? inputEl.value.length;
  insertAtCursor(`${s > 0 && /[\w@-]/.test(inputEl.value[s - 1]) ? ' ' : ''}@${name} `);
}
function insertAtCursor(str) {
  const s = inputEl.selectionStart ?? inputEl.value.length;
  setInput(inputEl.value.slice(0, s) + str + inputEl.value.slice(inputEl.selectionEnd ?? s));
  const p = s + str.length;
  inputEl.setSelectionRange(p, p);
  inputEl.focus();
}

// ---- autocomplete -----------------------------------------------------------

let acBox = null, acItems = [], acIndex = 0, acStart = -1, acKind = null;

// the command list derives from the registry: the table that autocompletes is the table the handlers registered

function closeAC() {
  acBox.style.display = 'none';
  acItems = []; acStart = -1; acKind = null;
}

function updateAC() {
  const v = inputEl.value;
  const caret = inputEl.selectionStart ?? v.length;
  const upto = v.slice(0, caret);

  // slash command — only at the very start of the line
  const cmd = /^\/(\w*)$/.exec(upto);
  if (cmd) {
    const q = cmd[1].toLowerCase();
    const hits = COMMANDS.filter(({ name, listed }) => listed !== false && name.startsWith(q));
    return showAC(hits.map(({ name, help }) => ({ value: `/${name}`, label: `/${name}`, hint: help })), 0, 'cmd');
  }

  // @mention
  const at = /(?:^|\s)@([\w-]*)$/.exec(upto);
  if (at) {
    const q = at[1].toLowerCase();
    const hits = getPeople()
      .filter((p) => p.id.toLowerCase().includes(q) && p.id !== CONFIG.name)
      .slice(0, 8);
    return showAC(
      hits.map((p) => ({ value: `@${p.id}`, label: p.id, hint: p.declares || 'here' })),
      caret - at[1].length - 1, 'at',
    );
  }
  closeAC();
}

function showAC(items, start, kind) {
  if (!items.length) return closeAC();
  acItems = items; acIndex = 0; acStart = start; acKind = kind;
  acBox.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = `ac-row ${i === 0 ? 'on' : ''}`;
    row.innerHTML = `<span class="ac-l"></span><span class="ac-h"></span>`;
    row.querySelector('.ac-l').textContent = it.label;
    row.querySelector('.ac-h').textContent = it.hint ?? '';
    row.onmousedown = (e) => { e.preventDefault(); acIndex = i; acceptAC(); };
    acBox.appendChild(row);
  });
  acBox.style.display = 'block';
}

function moveAC(d) {
  if (!acItems.length) return;
  acIndex = (acIndex + d + acItems.length) % acItems.length;
  [...acBox.children].forEach((c, i) => c.classList.toggle('on', i === acIndex));
  acBox.children[acIndex]?.scrollIntoView({ block: 'nearest' });
}

function acceptAC() {
  const it = acItems[acIndex];
  if (!it) return;
  const v = inputEl.value;
  const caret = inputEl.selectionStart ?? v.length;
  setInput(v.slice(0, acStart) + it.value + ' ' + v.slice(caret));
  const p = acStart + it.value.length + 1;
  inputEl.setSelectionRange(p, p);
  closeAC();
}

// ---- commands ---------------------------------------------------------------

// the build actually served (the server's /version): without it a stale page and a broken probe are indistinguishable
let _build = 'unknown';
versionReady.then((v) => { if (v) _build = `${String(v.sha ?? '').slice(0, 7) || 'unknown'}${v.dirty === true ? '+dirty' : ''}`; });   // null: 'unknown' is itself a diagnostic

function audioReport() {
  const L = [];
  const probe = (label, fn) => {
    try { L.push(`${label}: ${fn()}`); }
    catch (e) { L.push(`${label}: unreadable (${(e?.message ?? e)})`); }
  };

  probe('transport', () => window.__voiceTransport ?? '(none — voice never initialised)');
  probe('mic', () => {
    const on = typeof window.__sfuMicOn === 'function' ? window.__sfuMicOn() : null;
    return on === null ? 'unknown (no sfu bridge)' : (on ? 'ON' : 'off');
  });
  // the peer connection's own view — the only honest answer to "is there a media path"
  probe('ice', () => {
    const d = typeof window.relayDiag === 'function' ? window.relayDiag() : null;
    if (!d) return 'unknown (no diag)';
    return `${d.iceConnectionState ?? '?'} / conn=${d.connectionState ?? '?'}`;
  });
  probe('speakers', () => {
    const d = typeof window.relayDiag === 'function' ? window.relayDiag() : null;
    const s = d?.speakers ?? d?.peers;
    if (!s) return 'unknown';
    // [{id, hasStream}]: name each one and whether a track actually landed ("attached but no stream" is its own bug)
    const list = (Array.isArray(s) ? s : Object.entries(s).map(([id, v]) => ({ id, ...v })))
      .map((x) => (typeof x === 'string' ? x : `${x.id}${x.hasStream === false ? '(no stream)' : ''}`));
    return list.length ? `${list.length} — ${list.join(', ')}` : 'none attached';
  });
  // playback can fail silently (packets arrive, the <audio> element refuses to start): say so
  probe('playback', () => {
    // not querySelectorAll('audio'): the transport's `new Audio()` elements are never appended to the DOM
    const entries = typeof window.__voiceSpeakerEls === 'function' ? window.__voiceSpeakerEls() : null;
    if (!entries) return 'unknown (transport exposes no elements)';
    if (!entries.length) return 'no speaker elements yet';
    let playing = 0, paused = 0;
    const stuck = [];
    for (const { id, audio } of entries) {
      if (audio?.paused) { paused++; stuck.push(id); } else playing++;
    }
    return `${entries.length} — ${playing} playing, ${paused} paused`
      + (paused ? `  ← ${stuck.join(', ')} held; tap the page to unlock` : '');
  });
  probe('captions', () => {
    const has = !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
    if (!has) return 'no SpeechRecognition in this browser';
    // the tally is the load-bearing part: a last-event slot cannot prove that something never happened
    return `${window.__sttOn?.() ? 'ON' : 'off'}`
      + (window.__sttTally ? ` [${window.__sttTally()}]` : '')
      + (window.__sttLast ? ` — last: ${window.__sttLast}` : ' — no events yet');
  });
  // each subsystem's last narrated decision (debuglog.js; __why('<topic>') in the console shows recent history)
  probe('panel', () => `${lastWhy('tts-section')} | ${lastWhy('tts-list')}`);
  probe('source', () => lastWhy('publish'));
  probe('secure', () => `${window.isSecureContext} · isolated=${window.crossOriginIsolated}`);

  // stamp the build: without it a stale page and a broken probe are indistinguishable
  L.push(`build: ${_build}`);
  return 'audio ▸ ' + L.join('  ·  ');
}

/** Just the captions answer, short enough to copy on a phone. */
function sttReport() {
  const parts = [`build ${_build}`];
  // the recognizer's language: a wrong one returns confident nothing (nomatch) rather than an error
  try { if (window.__sttLang) parts.push(`lang ${window.__sttLang}`); } catch { /* ignore */ }
  try { parts.push(window.__sttOn?.() ? 'stt ON' : 'stt off'); } catch { parts.push('stt ?'); }
  try { parts.push(window.__sttTally ? window.__sttTally() : 'NO TALLY (stale page)'); }
  catch (e) { parts.push(`tally unreadable: ${e?.message ?? e}`); }
  try { if (window.__sttLast) parts.push(`last: ${window.__sttLast}`); } catch { /* ignore */ }
  return 'stt ▸ ' + parts.join(' · ');
}

// The commands chat owns (they need this module's state: the log element, the roster read). Everything else
// resolves through the registry's alias table and rides the bus.
const CHAT_LOCAL = {
  // whisper was removed: speech in a world is public and arrival-only; DMs are planned at the identity level
  w() { logChat('*', 'whisper was removed: everything said in a world is public (everyone here hears it). To address someone, @mention them.'); },
  // ghost was removed: nobody is hidden in a world; moderation quiets or removes
  ghost() { logChat('*', 'ghost was removed: nobody in a world is hidden from it. To quiet someone, /mute them; to remove them, /kick or /ban.'); },
  name(rest, arg) {
    if (!arg) { logChat('*', `you are ${CONFIG.name} — /name <new name> to change it`); return; }
    bus.emit('command', { cmd: 'rename', arg });   // the handler owns the (un)support answer
  },
  me(rest, arg) { if (arg) onSend(`* ${CONFIG.name} ${arg}`); },
  who() {
    const list = getPeople().map((p) => p.id).join(', ');
    logChat('*', `here now: ${list || 'just you'}`);
  },
  clear() {
    logEl.innerHTML = '';
    lastAuthor = null;
  },
  audio(rest, arg) {
    // /audio: the phone's own console (Android Chrome has none on-device). Local by default; `say` puts the short
    // form into the room.
    const mode = (arg || '').trim().toLowerCase();
    if (mode === 'say') { onSend(sttReport()); return; }
    logChat('*', mode === 'stt' ? sttReport() : audioReport());
  },
};

/** One line, as if typed into the compose box and Entered: history, then a /command or speech to the room. The one
 *  send path. */
function submitLine(v) {
  sentHistory.push(v);
  while (sentHistory.length > 50) sentHistory.shift();
  try { localStorage.setItem(HISTORY, JSON.stringify(sentHistory.slice(-20))); } catch { /* full */ }
  if (v.startsWith('/')) { runCommand(v); return; }
  onSend(v.slice(0, 4000));
}

function runCommand(raw) {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const typed = cmd.toLowerCase();
  const row = resolveCommand(typed);
  const canon = row?.name ?? typed;
  if (CHAT_LOCAL[canon]) { CHAT_LOCAL[canon](rest, arg); return true; }
  if (row?.retired) { logChat('*', row.retired); return true; }
  if (row) {
    // aliasAsAction (/pull lever1): typing the alias IS the action
    const a = row.aliasAsAction && typed !== row.name ? `${arg} ${typed}`.trim() : arg;
    bus.emit('command', { cmd: row.name, arg: a });
    return true;
  }
  logChat('*', `unknown command /${cmd} — try /help`);
  return true;
}

// ---------------------------------------------------------------- lifecycle

export const chat = {
  open() {
    frame.show();
    inputEl.focus();
    scrollToEnd();
  },
  close() { setInput(''); closeAC(); inputEl.blur(); },
  get isOpen() { return document.activeElement === inputEl; },
  toggle() { frame.toggle(); },
  submit: (text) => { const v = String(text ?? '').trim(); if (v) submitLine(v); },
  frame: () => frame,
  // unread accounting is observable so tests can pin it
  unreadCounts: () => ({ unread, mentions: unreadMentions }),
  markRead: () => { unread = 0; unreadMentions = 0; paintUnread(); },
};
const open = chat.open;

// ---- who's-here side pane, collapsible in one click -------------------------
const SIDE_LS = 'ew-chat-side';
// The side-pane nodes, captured from the markup initChat itself wrote: mods mount markup with these public classes
// (docs/guide/MODDING-UI.md §3) into frame bodies after initChat, so a class lookup could find a mod's node instead.
let sideEls = null;
// a mod can remove a captured node, and writes to a detached node vanish silently, so a detached node reads as absent
const sideEl = (k) => { const n = sideEls?.[k] ?? null; return n?.isConnected ? n : null; };
let sideSt = { w: 150, open: false, pos: 'left' };   // people pane on the LEFT by default
function initSidePane() {
  try { sideSt = { ...sideSt, ...JSON.parse(localStorage.getItem(SIDE_LS) || '{}') } } catch {}
  const tog = sideEl('tog');
  if (tog) tog.onclick = toggleSide;
  // the open column's header closes it (the tab-row chip is hidden while it is open)
  const head = sideEl('head');
  if (head) {
    head.setAttribute('role', 'button'); head.tabIndex = 0;
    head.addEventListener('click', () => { if (sideSt.open) toggleSide(); });
    head.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && sideSt.open) { e.preventDefault(); e.stopPropagation(); toggleSide(); }
    });
  }

    // double-click a name → a mention of them in the compose box. Delegated: paintSide rebuilds this list's
    // innerHTML on every roster event. Skips your own row.
    const list = sideEl('list');
    const nameOf = (row) => row?.dataset?.name ?? null;
    list?.addEventListener('dblclick', (e) => {
      const row = e.target?.closest?.('.who-row');
      if (!row || row.classList.contains('self')) return;
      const name = nameOf(row);
      if (name) mentionPerson(name);
    });
    // The person menu (people.js): desktop right-click (and the menu key); a phone's long-press (500 ms) opens a
    // bottom sheet; in a headset a trigger on a row expands an inline strip (no popups in VR). Chrome's own
    // long-press cancels the pointer and fires contextmenu around 500 ms: that contextmenu (from touch, or during
    // our pending press) is the sheet; whichever comes first opens it.
    list?.addEventListener('contextmenu', (e) => {
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self')) return;
      e.preventDefault();
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen' || !!press || touchAt > performance.now() - 1500;
      if (press) { clearTimeout(press.t); press = null; }
      if (touch) personUi.sheetFor(nameOf(row)); else personUi.menuAt(nameOf(row), e.clientX, e.clientY);
    });
    list?.addEventListener('keydown', (e) => {
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self')) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); const r = row.getBoundingClientRect(); personUi.menuAt(nameOf(row), r.left + 12, r.bottom); }
    });
    let press = null, touchAt = -1e9;
    list?.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') touchAt = performance.now();
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self') || e.pointerType === 'mouse') return;
      const name = nameOf(row), x = e.clientX, y = e.clientY;
      press = { x, y, name, t0: e.timeStamp, t: setTimeout(() => { press = null; personUi.sheetFor(name); }, LONG_PRESS_MS) };
    });
    // a release or a real move abandons the press; a pointercancel doesn't (Chrome sends one at its own long-press,
    // which is this very gesture, and its contextmenu follows, above; a scroll has already moved the finger past 10 px)
    const unpress = (e) => { if (!press || e.type === 'pointercancel') return; if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
      // held long enough by the events' own clock: a long-press even when a busy page ran the timer late
      const held = e.type === 'pointerup' && e.timeStamp - press.t0 >= LONG_PRESS_MS, name = press.name;
      clearTimeout(press.t); press = null; if (held) personUi.sheetFor(name); };
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) list?.addEventListener(ev, unpress);
    list?.addEventListener('click', (e) => {
      if (!personUi?.presenting?.()) return;
      if (e.target?.closest?.('.pm-strip')) return;   // a press inside the open strip is the strip's
      const row = e.target?.closest?.('.who-row'); if (!row || row.classList.contains('self')) return;
      const name = nameOf(row);
      stripName = stripName === name ? null : name; paintSide(true);
    });
  const grip = sideEl('grip');
  grip?.addEventListener('pointerdown', (e) => {
    if (!sideSt.open) return;
    e.preventDefault();
    e.stopPropagation();   // the frame's root drags on body pointerdown; the grip owns this one
    const x0 = e.clientX, w0 = sideSt.w;
    const move = (ev) => {
      const d = sideSt.pos === 'left' ? ev.clientX - x0 : x0 - ev.clientX;   // grip side flips with the pane
      sideSt.w = Math.max(72, Math.min(260, w0 + d)); applySide();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveSide(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  bus.on('roster', () => { paintSide(); paintWho(); });
  bus.on('presence:me', () => { paintSide(); paintWho(); });                                   // my own mark flips at once
  setInterval(() => { if (frame?.visible && sideSt.open) paintSide(); }, 2000);   // remote presence rides pose packets; a 2 s repaint is plenty
  applySide();
}
const saveSide = () => { try { localStorage.setItem(SIDE_LS, JSON.stringify(sideSt)) } catch {} };
function toggleSide() { sideSt.open = !sideSt.open; applySide(); saveSide(); }
// The presence chip in the tab row: who's here at a glance (a dot per person in their name colour, ringed by
// presence) and the pane's toggle. Painted in place on roster/presence; paintTabs rebuilds the row and calls this
// for its new chip.
let whoChip = null;   // the chip paintTabs wrote, by handle, never by class (MODDING-UI §3)
function paintWho() {
  const chip = whoChip?.isConnected ? whoChip : null;
  if (!chip) return;
  const people = getPeople(), others = people.filter((p) => !p.me).length;
  const dots = [...people.filter((p) => !p.me), ...people.filter((p) => p.me)].slice(0, 3).map((p) =>
    `<span class="who-dot" data-presence="${esc(p.presence ?? 'present')}" style="background:${colorFor(p.id)}"></span>`).join('');
  chip.innerHTML = `<span class="who-dots">${dots}</span><span class="who-n">${others === 0 ? 'just you' : `${people.length} here`}</span>`;
  // on the side the column opens from (Chat ▸ settings): first in the row on the left, last on the right
  const bar = chip.parentElement, left = sideSt.pos === 'left';
  if (left && bar.firstElementChild !== chip) bar.prepend(chip);
  else if (!left && bar.lastElementChild !== chip) bar.appendChild(chip);
  chip.classList.toggle('at-left', left);
  // open, the chip steps out: the column's own header says who's here and is the way back
  chip.hidden = !!sideSt.open;
  chip.setAttribute('aria-expanded', String(!!sideSt.open));
  chip.title = 'people here';
}
function applySide() {
  const side = sideEl('side');
  if (!side) return;
  side.classList.toggle('closed', !sideSt.open);
  // the line between log and pane is the pane's grab edge; closed, there is nothing to grab, so the line goes too
  sideEl('cols')?.classList.toggle('side-closed', !sideSt.open);
  paintWho();
  side.style.width = sideSt.open ? `${sideSt.w}px` : '';
  // the chevron points the way the pane will move: on the right › closes / ‹ opens; mirrored on the left
  const left = sideSt.pos === 'left';
  const chev = (sideSt.open !== left) ? '›' : '‹';
  const t = sideEl('tog'); if (t) t.textContent = chev;
  // the open column's header is its close control, its chevron pointing at the edge it collapses to — drawn from
  // data-chev by CSS, so the header's text stays exactly who's here
  const head = sideEl('head');
  if (head) { head.dataset.chev = chev; head.title = 'hide people here'; }
  paintSide();
}
const LONG_PRESS_MS = 500;
let stripName = null;   // the person whose inline action strip is open (VR), or null
function paintSide(force = false) {
  const side = sideEl('side');
  if (!side || !sideSt.open) return;
  // an open strip holds a form someone is filling in: the 2 s repaint mustn't wipe it (a roster change still does)
  if (stripName && !force && sideEl('list')?.querySelector('.pm-strip')?.childElementCount) return;
  const people = getPeople();
  const others = people.filter((p) => !p.me).length;
  sideEl('head').textContent =
    others === 0 ? 'just you' : `${others} other${others === 1 ? '' : 's'} here`;
  const html = people.length
      // a <button>, not a div: windows.js _contentClaims exempts only BUTTON/INPUT/TEXTAREA/SELECT/A from the frame's
      // drag surface, so a <div> row would be grabbed as the pane
      ? people.map((p) => `<button type="button" class="who-row ${p.me ? 'self' : ''}" data-name="${esc(p.id)}"${p.me || !personUi ? '' : ' aria-haspopup="menu"'}>
          <span class="who-mark" data-presence="${esc(p.presence ?? 'present')}" title="${esc(p.presence ?? 'present')}"></span>
          <span class="n" style="color:${colorFor(p.id)}">${esc(p.id)}${p.me ? ' (you)' : ''}</span>${personUi ? personUi.badgeHtml(p.id, esc) : ''}${personUi?.muted?.(p.id) ? '<span class="who-muted" title="muted by a moderator" aria-label="muted">⊘</span>' : ''}
          <span class="d">${p.dist == null ? '' : p.dist.toFixed(0) + 'm'}</span></button>${stripName === p.id && personUi ? '<div class="pm-strip" data-for="' + esc(p.id) + '"></div>' : ''}`).join('')
    : '<div class="who-empty">nobody yet</div>';
  // only when it changed: a rebuild resets hover and focus and detaches the row under a pointer mid-press
  const listEl = sideEl('list');
  if (listEl._html === html && !force) return;
  listEl.innerHTML = html; listEl._html = html;
  const strip = stripName && listEl.querySelector('.pm-strip');
  if (strip) personUi.stripFor(stripName, strip);
}

// ---- chat gear: text size, markdown, which side the people pane sits on; a small popover, all persisted
const CFS_LS = 'ew-chat-fs';
function applyChatPrefs() {
  // logEl, not a .chat-log lookup: a mod's .chat-log in the chat body would win the query (MODDING-UI §3)
  if (logEl) logEl.style.fontSize = `${chatFs}px`;
  sideEl('cols')?.classList.toggle('side-left', sideSt.pos === 'left');
}
let gearToggle = null, gearAnchor = null, placeGear = () => {};
let chatFs = 14;
const CMD_LS = 'ew-chat-md';
let chatMd = true;   // *italic* **bold** `code` in the log — on by default
try { chatMd = localStorage.getItem(CMD_LS) !== '0' } catch {}
export const chatMarkdownOn = () => chatMd;
try { chatFs = Math.min(20, Math.max(11, parseFloat(localStorage.getItem(CFS_LS)) || 14)) } catch {}
function initChatGear() {
  const pop = frame.body.querySelector('.chat-gearpop');
  placeGear = () => {
    if (pop.hidden || !gearAnchor) return;
    const a = gearAnchor.getBoundingClientRect(), f = frame.el.getBoundingClientRect();
    const body = frame.body.getBoundingClientRect();
    const minTop = Math.max(4, body.top - f.top + 4);
    const bottom = Math.min(frame.el.clientHeight, body.bottom - f.top) - 4;
    // open below the gear when the options fit, else upward; when neither fits, the side with more room takes it
    // and a short frame scrolls the options instead of clipping them
    const below = a.bottom - f.top + 6, above = a.top - f.top - 6;
    pop.style.maxHeight = 'none';
    const height = pop.offsetHeight;
    const roomBelow = bottom - below, roomAbove = above - minTop;
    const down = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
    const room = Math.max(1, down ? roomBelow : roomAbove);
    pop.style.maxHeight = `${room}px`;
    pop.style.top = `${down ? below : Math.max(minTop, above - Math.min(height, room))}px`;
    pop.style.right = `${Math.max(4, Math.min(f.right - a.right, frame.el.clientWidth - pop.offsetWidth - 4))}px`;
  };
  const paintPop = () => {
    pop.innerHTML = `
      <div class="gp-row"><span>text size</span>
        <button data-fs="-1">−a</button><b>${chatFs}</b><button data-fs="1">+A</button></div>
      <div class="gp-row"><span>markdown</span>
        <button data-md="1" class="${chatMd ? 'on' : ''}">on</button>
        <button data-md="0" class="${!chatMd ? 'on' : ''}">off</button></div>
      <div class="gp-row"><span>People Here</span>
        <button data-side="left" class="${sideSt.pos === 'left' ? 'on' : ''}">left</button>
        <button data-side="right" class="${sideSt.pos !== 'left' ? 'on' : ''}">right</button></div>`;
    mountAttentionControls(pop);
    placeGear();
  };
  pop.onclick = (e) => {
    const fs = e.target?.dataset?.fs, sd = e.target?.dataset?.side, md = e.target?.dataset?.md;
    if (md != null) {
      chatMd = md === '1';
      try { localStorage.setItem(CMD_LS, md) } catch {}
    } else if (fs) {
      chatFs = Math.min(20, Math.max(11, chatFs + Number(fs)));
      try { localStorage.setItem(CFS_LS, String(chatFs)) } catch {}
    } else if (sd) {
      sideSt.pos = sd; saveSide();
    } else return;
    applyChatPrefs(); applySide(); paintPop();   // applySide repaints the chevron for the new side
  };
  gearToggle = (anchor) => {
    pop.hidden = !pop.hidden;
    anchor.setAttribute('aria-expanded', String(!pop.hidden));
    gearAnchor = anchor;
    if (!pop.hidden) {
      paintPop();
    }
  };
  // the gear lives at the right end of the compose box, like a settings affordance in a text field
  const gear = frame.body.querySelector('.chat-compose > .chat-gear');
  if (gear) {
    gear.innerHTML = fsvg('gear-six', 14);
    gear.onclick = (e) => { e.stopPropagation(); gearToggle(gear); };
  }
  const closePop = () => { if (!pop.hidden && gearAnchor) gearToggle(gearAnchor); };
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !gearAnchor?.contains(e.target)) closePop();
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  applyChatPrefs();
}

// The compose box grows: one line at rest, growing with what you type up to six lines or 40% of the chat pane
// (whichever is less), then scrolling, so the log is never pushed out of sight.
const INPUT_MAX_LINES = 6, INPUT_MAX_SHARE = 0.4;
function sizeInput() {
  if (!inputEl) return;
  const cs = getComputedStyle(inputEl);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
  const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const pane = inputEl.closest('.fr-body')?.clientHeight || innerHeight;
  const max = Math.max(line + chrome, Math.min(line * INPUT_MAX_LINES + chrome, pane * INPUT_MAX_SHARE));
  inputEl.style.height = 'auto';
  // empty: exactly one line (a long placeholder must not wrap the box taller)
  const want = inputEl.value ? inputEl.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) : line + chrome;
  inputEl.style.height = `${Math.min(want, max)}px`;
  inputEl.style.overflowY = want > max + 1 ? 'auto' : 'hidden';
}
function setInput(v) { if (!inputEl) return; inputEl.value = v; sizeInput(); }

export function initChat({ send, typing, people, person }) {
  personUi = person ?? null;
  initAttention({ bus, me: () => CONFIG.name, scope: () => CONFIG.world, mentions: mentionsMe });
  onSend = send;
  onTyping = typing ?? (() => {});
  getPeople = people ?? (() => []);

  frame = makeFrame('chat', {
    title: 'Chat',
    x: 10, y: -10, w: 390, h: 200, minW: 240, minH: 100,
      className: 'chat-frame',
      // the tab arrows re-evaluate on resize: paintArrows compares scrollWidth to clientWidth, and narrowing the
      // panel changes clientWidth with nothing else repainting the strip. Debounced like actionbar.js's.
      onResize: () => { placeGear(); clearTimeout(_arrowT); _arrowT = setTimeout(() => paintTabs(), 120); },
  });

  frame.body.innerHTML = `
    <div class="chat-cols">
      <div class="chat-main">
        <div class="chat-tabs"></div>
        <div id="chatlog" class="chat-log"></div>
        <button id="chat-jump" class="chat-jump"></button>
        <div class="chat-typing"></div>
        <div class="chat-compose">
          <div id="chat-ac" class="ac panel"></div>
          <textarea id="chatline" rows="1" enterkeyhint="send" placeholder="say something…  @ to mention · / for commands"></textarea>
          <button type="button" class="chat-gear" title="chat options" aria-expanded="false" aria-haspopup="dialog"></button>
        </div>
      </div>
      <button class="chat-side-tog" title="People Here"></button>
      <div class="chat-side closed">
        <div class="chat-side-grip"></div>
        <div class="chat-side-head"></div>
        <div class="chat-side-list"></div>
      </div>
    </div>
    <div class="chat-gearpop panel" hidden></div>`;
  { const cols = frame.body.querySelector(':scope > .chat-cols');
    sideEls = cols ? {
      cols,
      tog: cols.querySelector(':scope > .chat-side-tog'),
      side: cols.querySelector(':scope > .chat-side'),
      grip: cols.querySelector(':scope > .chat-side > .chat-side-grip'),
      head: cols.querySelector(':scope > .chat-side > .chat-side-head'),
      list: cols.querySelector(':scope > .chat-side > .chat-side-list'),
    } : null; }
  // hand the captures to whoever holds this frame (ui.js's Tab handler needs these exact nodes, and a class lookup
  // can be won by a mod prepending a .chat-cols); both sides hold the frame via getFrame('chat')
  frame.sidePane = (k) => sideEl(k);
  // before initChatGear: its last statement, applyChatPrefs(), writes through the captured logEl
  logEl = frame.body.querySelector('#chatlog');
  tabsEl = frame.body.querySelector(':scope > .chat-cols > .chat-main > .chat-tabs');
  initSidePane();
  initChatGear();

  inputEl = frame.body.querySelector('#chatline');
  inputEl.addEventListener('focus', () => requestAnimationFrame(sizeInput));
  if (globalThis.ResizeObserver) new ResizeObserver(() => sizeInput()).observe(frame.body);
  acBox = frame.body.querySelector('#chat-ac');
  closeAC();

  paintTabs();

  jumpEl = frame.body.querySelector('#chat-jump'); jumpEl.onclick = scrollToEnd;
  logEl.addEventListener('scroll', () => {
    // reaching the bottom clears the unread counters; never touch scrollTop from inside the scroll handler (it traps
    // a reader in the near-bottom band). Stick-to-bottom on new content is account()'s.
    if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48 &&
        (unread || unreadMentions)) {
      unread = 0; unreadMentions = 0; paintUnread();
    }
    if (logEl.scrollTop < 60) loadOlder();
  });

  inputEl.addEventListener('input', () => {
    sizeInput();
    updateAC();
    // throttle: presence, not a keystroke log
    const now = performance.now();
    if (inputEl.value.trim() && now - lastTypingSent > 2500) {
      lastTypingSent = now;
      onTyping(null);
    }
  });
  inputEl.addEventListener('blur', () => setTimeout(closeAC, 120));
  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // typing is never walking

    if (acItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveAC(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveAC(-1); }
      if (e.key === 'Tab' || (e.key === 'Enter' && acKind)) { e.preventDefault(); return acceptAC(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeAC(); }
    }

    if (e.key === 'Escape') { chat.close(); return; }

    // shell-style recall of what you last said
    if (e.key === 'ArrowUp' && !inputEl.value.trim() || (e.key === 'ArrowUp' && historyIdx >= 0 && !inputEl.value.slice(0, inputEl.selectionStart ?? 0).includes('\n'))) {
      if (sentHistory.length) {
        e.preventDefault();
        historyIdx = Math.min(historyIdx + 1, sentHistory.length - 1);
        setInput(sentHistory[sentHistory.length - 1 - historyIdx]);
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      }
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0 && !inputEl.value.slice(inputEl.selectionEnd ?? inputEl.value.length).includes('\n')) {
      e.preventDefault();
      historyIdx--;
      setInput(historyIdx < 0 ? '' : sentHistory[sentHistory.length - 1 - historyIdx]);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();                      // a textarea now: Enter sends, Shift+Enter is a new line
      const v = inputEl.value.trim();
      setInput('');
      historyIdx = -1;
      closeAC();
      if (!v) { inputEl.blur(); return; }
      submitLine(v);
    }
  });

  // every listed slash command is an action too; one that needs an argument FILLS the prompt instead of running,
  // and so does one whose first argument is its target ("/push [name]"): run bare, it would pick whoever is nearest
  for (const row of COMMANDS) {
    if (row.listed === false) continue;
    const needsArg = new RegExp(`^/${row.name} (<|\\[(name|thing|person)\\b)`).test(row.help);
    registerAction({
      id: `cmd:${row.name}`, title: `/${row.name}`, group: 'commands', detail: row.help,
      // the name is already a word of the title ('/sit'), so it is not also an exact keyword (that outranked the
      // body's own sit / stand)
      keywords: [...(row.aliases ?? []), row.help.replace(/^\/\S+\s*/, '').replace(/[<>[\]—|"]/g, ' ')],
      ...(needsArg ? { fill: `/${row.name} ` } : { run: () => submitLine(`/${row.name}`) }),
    });
  }

  try { sentHistory.push(...(JSON.parse(localStorage.getItem(HISTORY) ?? '[]'))); } catch { /* none */ }

  return chat;
}

// ---------------------------------------------------------------- mention a person
/** Open chat with `@name ` at the cursor: the person menu's Mention, a double-click in People Here, the name card's
 *  button. A public line that names them (their attention ping), never a private one: world chat has no private channel. */
export function mentionPerson(name) {
  if (!name) return;
  chat.open();
  insertMention(name);
  inputEl.focus();
}

function setFilter(f) {
  filter = f;
  paintTabs();
  repaintFilter();
}

let _arrowT = null;   // debounce for the resize-driven tab repaint
let tabsEl = null;    // captured in initChat, like sideEls

function paintTabs() {
  const bar = tabsEl;
  if (!bar) return;
  bar.innerHTML = '';
  // The strip carries `all · mentions · system`; tabs size to their labels and the row SCROLLS on a narrow panel,
  // with arrows at either end when it overflows.
  const left = document.createElement('button');
  left.className = 'tabarrow'; left.type = 'button'; left.textContent = '\u2039';
  left.title = 'scroll tabs left'; left.setAttribute('aria-label', 'scroll tabs left');
  const scroll = document.createElement('div');
  scroll.className = 'tabscroll';
  const right = document.createElement('button');
  right.className = 'tabarrow'; right.type = 'button'; right.textContent = '\u203a';
  right.title = 'scroll tabs right'; right.setAttribute('aria-label', 'scroll tabs right');
  const STEP = 90;
  left.onclick = (e) => { e.stopPropagation(); scroll.scrollLeft -= STEP; };
  right.onclick = (e) => { e.stopPropagation(); scroll.scrollLeft += STEP; };
  // hidden unless the row really overflows, re-checked on scroll and on every repaint
  const paintArrows = () => {
    const over = scroll.scrollWidth > scroll.clientWidth + 1;
    left.hidden = !over || scroll.scrollLeft <= 0;
    right.hidden = !over || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
  };
  scroll.addEventListener('scroll', paintArrows);
    // watch the scroller itself: paintTabs and onResize both measure before the browser applies a new width; a
    // ResizeObserver fires after layout
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(() => paintArrows()).observe(scroll); } catch { /* older engine */ }
    }
  bar.append(left, scroll, right);
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.className = filter === key ? 'on' : '';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    b.append(lbl);
    b.onclick = () => setFilter(key);
    scroll.appendChild(b);
  };
  mk('all', 'all');
  mk('mentions', 'mentions');
  mk('system', 'system');
  const who = document.createElement('button');
  who.type = 'button'; who.className = 'chat-who';
  who.onclick = (e) => { e.stopPropagation(); toggleSide(); };
  bar.appendChild(who);
  whoChip = who;
  paintWho();
  paintArrows();
  // keep the active tab in view
  const active = scroll.querySelector('button.on');
  if (active) {
      // 'nearest' moves the minimum to make a partly clipped tab whole; again after layout, when scrollWidth is real
      const bring = () => active.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    bring();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { bring(); paintArrows(); });
  }
  // the scroller has no measurable width until layout runs
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintArrows);
}

// ---------------------------------------------------------------- typing
// Pure presence — who is composing right now, gone a second later.

const typers = new Map();           // id -> expiry
let lastTypingSent = 0;
export function noteTyping(id) {
  typers.set(id, performance.now() + 4000);
  paintTypers();
}
function paintTypers() {
  const el = frame?.body.querySelector('.chat-typing');
  if (!el) return;
  const now = performance.now();
  for (const [id, exp] of typers) if (exp < now) typers.delete(id);
  const names = [...typers.keys()];
  el.textContent = names.length === 0 ? ''
    : names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
        : `${names.length} people are typing…`;
  el.style.display = names.length ? 'block' : 'none';
}
setInterval(paintTypers, 1200);

/** Someone said your name — flash the frame even if you're looking elsewhere. */
bus.on('pinged', () => {
  frame?.el.classList.add('flash');
  setTimeout(() => frame?.el.classList.remove('flash'), 1400);
});

// ---- the chat frame as a VR quad: read + canned replies --------------------
// Until VR has a keyboard, the quad shows the log's tail and offers a few whole replies through the same onSend
// typing uses.
const CANNED = ['hello', 'yes', 'no', 'one moment', 'come here', 'thank you'];
export const chatXRPanel = {
  id: 'chat', title: 'Chat',
  fields: () => [
    ...(recent.length ? recent.slice(-8).map((l, i) => ({ t: 'info', label: l.who === '*' ? '·' : String(l.who).slice(0, 12), value: l.text }))
                      : [{ t: 'info', label: '·', value: 'nothing said yet' }]),
    ...CANNED.map((c) => ({ t: 'btn', k: `say:${c}`, label: c })),
  ],
  dispatch: (k) => { if (k?.startsWith('say:')) onSend?.(k.slice(4)); },
};

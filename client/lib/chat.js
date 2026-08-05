// chat — the room's conversation, which in this world is also its history.
//
// Mentions were already a first-class concept for AGENTS: the MCPL layer pings
// on `@name` or a bare whole-word name, tags the message for the router, and
// replays missed mentions on reconnect. Humans had no way to reliably type one,
// no highlight when one arrived, and no unread state. That asymmetry is the
// same one build mode fixed, in a different place.
//
// The mention pattern here is deliberately IDENTICAL to mcpl/agent.ts's — what
// a person sees highlighted must be exactly what pings the agent, or the two
// species are reading different rooms.

import { CONFIG, bus, colorFor, assignColors } from './core.js';
import { makeFrame } from './frames.js';
import { requestHistory } from './net.js';

const MAX_LINES = 400;
const HISTORY = 'ew-chat-history';

let frame = null;
let logEl = null;
let inputEl = null;
let onSend = null;
let onWhisper = () => {};
let onTyping = () => {};
let getPeople = () => [];

let filter = 'all';                 // 'all' | 'mentions' | 'system' | 'w:<name>'
let lastWhisperFrom = null;         // who /r replies to
const convos = new Map();           // name -> { unread }
let unread = 0, unreadMentions = 0;
let lastAuthor = null, lastAt = 0, lastLineEl = null;
const sentHistory = [];             // up-arrow recall
let historyIdx = -1;

// ---------------------------------------------------------------- mentions

/** Same rule as the agent side: @name, or the bare name as a whole word. */
export function mentionRx(name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(@${safe}\\b|\\b${safe}\\b)`, 'i');
}
export function mentionsMe(text) {
  return mentionRx(CONFIG.name).test(String(text ?? ''));
}

/** Render text with mentions marked and links made clickable, without ever
 *  putting untrusted text through innerHTML. */
function renderBody(text, names) {
  const frag = document.createDocumentFragment();
  const pattern = new RegExp(
    `(https?://[^\\s]+)|(@?\\b(?:${names.map(escapeRx).join('|') || '\\u0000'})\\b)`,
    'gi',
  );
  let i = 0;
  for (const m of String(text).matchAll(pattern)) {
    if (m.index > i) frag.append(document.createTextNode(text.slice(i, m.index)));
    if (m[1]) {
      // Trailing punctuation is prose, not address: "…?world=garden)" from a
      // parenthesized link once sent a clicker to a world named "garden)" —
      // which the server refuses, and refusing is all it should ever do.
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
      // a mention wears the colour of the person mentioned, so "@fable" in the
      // text and fable's own lines are visibly the same person. Mentions of YOU
      // keep the amber ping styling — being addressed outranks being named.
      if (!isMe) s.style.color = colorFor(bare);
      s.textContent = m[2];
      frag.append(s);
    }
    i = m.index + m[0].length;
  }
  if (i < text.length) frag.append(document.createTextNode(text.slice(i)));
  return frag;
}
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- scrollback
//
// A join carries recent chat, not the archive — that is what keeps arrival
// cheap now that worlds fold. Reaching the top of the log asks the world for
// the page before it, so nothing said is actually out of reach; it is just not
// paid for up front.

let oldestShownSeq = null;
let loadingOlder = false;
let noMoreHistory = false;

export function noteSeq(seq) {
  // synthetic entries from a folded snapshot carry negative seq — they are not
  // positions in history and must not become the paging cursor
  if (typeof seq === 'number' && seq >= 0
      && (oldestShownSeq === null || seq < oldestShownSeq)) oldestShownSeq = seq;
}

function prependLine(who, text, ts, seq) {
  noteSeq(seq);
  logEl.prepend(buildLine(who, text, { ts, historical: true }));
}

/** Tell an arrival that what they are looking at is a window, not the room's
 *  whole memory — and roughly how small a window. Without this, 40 lines of one
 *  bot's telemetry looks like everything that has ever happened here. */
export function noteHistoryContext({ total = null, shown = 0, spanMs = null } = {}) {
  if (!logEl) return;
  // `total` is unknown for worlds folded before it was recorded. Saying
  // "showing 40 of 0" would be worse than saying nothing; saying "there is
  // more" is true either way.
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
    const r = await requestHistory({
      ...(oldestShownSeq !== null ? { before: oldestShownSeq } : {}),
      limit: 40, verbs: ['say'],
    });
    marker.remove();
    if (!r.entries?.length) {
      noMoreHistory = true;
      const end = document.createElement('div');
      end.className = 'line sys';
      end.textContent = '— the beginning of this world —';
      logEl.prepend(end);
      return;
    }
    // grow the top without moving what the reader is looking at
    const anchorH = logEl.scrollHeight - logEl.scrollTop;
    for (const e of [...r.entries].reverse()) {
      prependLine(e.actor, e.args?.text ?? '', e.ts, e.seq);
    }
    logEl.scrollTop = logEl.scrollHeight - anchorH;
    if (!r.hasMore) noMoreHistory = true;
  } catch {
    marker.remove();
  } finally { loadingOlder = false; }
}

// ---------------------------------------------------------------- lines

const pad2 = (n) => String(n).padStart(2, '0');

export function logChat(who, text, kind = '', meta = {}) {
  noteSeq(meta.seq);
  // Spoken-utterance merge: merges ONLY the continuation of one spoken
  // utterance — spoken:true + same author + same utt (Sol review, PR#7).
  // A voicebox interrupted mid-utterance flushes the aired sentences as one
  // say and may finish the rest later under the SAME utt; those says are one
  // paragraph. Everything else — ordinary agent says, distinct utterances,
  // tool-authored messages — keeps today's row semantics.
  if (meta.spoken && meta.utt != null && lastLineEl?.isConnected &&
      lastLineEl.dataset.author === who && lastLineEl.dataset.utt === String(meta.utt)) {
    const body = lastLineEl.querySelector('.body');
    if (body) {
      const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
      body.append(' ', renderBody(text, namesForHighlight()));
      lastAt = Date.now();
      const newlyPinged = !lastLineEl.dataset.convo &&
        lastLineEl.dataset.kind !== 'mention' && mentionsMe(text);
      if (newlyPinged) { lastLineEl.classList.add('ping'); lastLineEl.dataset.kind = 'mention'; }
      account(lastLineEl, { who, text, merged: true, newlyPinged, wasAtBottom });
      return;
    }
  }
  const line = buildLine(who, text, { kind, ...meta });
  line.dataset.author = who;
  line.dataset.tsn = String(meta.ts ?? Date.now());
  if (meta.spoken && meta.utt != null) line.dataset.utt = String(meta.utt);
  lastLineEl = line;

  const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  // Causal placement (R, 16:30, verified against the world log — seq #1052/53
  // landed same-second, interrupter first): a spoken utterance is an INTERVAL.
  // Its record arrives when the voice stops, but it BEGAN before the interrupt
  // that cut it. When a spoken say carries t0 (air-start), it slots in front
  // of any trailing lines that arrived after its speech began. Server order
  // stays arrival-truth; this is display causality only. t0 is honored ONLY
  // inside the spoken protocol and only within a bounded window — the server
  // clamps it too, but an old or foreign server might not (Sol review, PR#7).
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
    // the anchor may have been name-grouped with a line that's no longer its
    // neighbor — a different speaker between them means the name must reprint
    if (anchor.dataset.author !== who) anchor.classList.remove('cont');
    // ...and the inserted line's OWN grouping must be re-derived from its
    // visual predecessor. buildLine computed it against chronological arrival
    // (lastAuthor), and the two disagree exactly when this branch runs — a
    // 'cont' line landing under another speaker renders their nameplate over
    // these words. (2026-08-05, "your line was credited to me"; repro:
    // exultation/tools/repro-stale-t0.mjs. Sys lines pass through a group,
    // same as the chronological rule.)
    let prev = line.previousElementSibling;
    while (prev && prev.dataset.kind === 'system') prev = prev.previousElementSibling;
    const near = !!prev && prev.dataset.author === who &&
      +(line.dataset.tsn ?? 0) - +(prev.dataset.tsn ?? 0) < 90_000;
    line.classList.toggle('cont', near);
  } else logEl.appendChild(line);
  while (logEl.children.length > MAX_LINES) logEl.removeChild(logEl.firstChild);

  account(line, { who, text, merged: false,
    newlyPinged: line.dataset.kind === 'mention', wasAtBottom });
}

// ONE place turns a landed line into reader-facing accounting, for both new
// and merged rows — a mention arriving in a later spoken sentence counts
// exactly like a mention arriving as its own line, and nothing counts twice
// (the old split paths could double-increment when the frame was hidden AND
// the log was scrolled up). `seen` means the reader is actually looking:
// frame visible, not collapsed, pinned to the bottom. (Sol review, PR#7.)
function account(line, { who, text, merged, newlyPinged, wasAtBottom }) {
  const seen = frame.visible && !frame.state.collapsed && wasAtBottom;
  if (seen) scrollToEnd();
  else {
    if (!merged && line.dataset.kind !== 'system') unread++;
    if (newlyPinged) unreadMentions++;
    paintUnread();
  }
  if (newlyPinged) bus.emit('pinged', { who, text });
}

function buildLine(who, text, { kind = '', ts = Date.now(), historical = false } = {}) {
  const sys = who === '*';
  const mine = who === CONFIG.name;
  const pinged = !sys && !mine && mentionsMe(text);

  // Who you are talking to matters here more than it does in a chat app, so
  // the marker comes from live presence (the server's join flag) rather than
  // from anything written into the log.
  const isAgent = kind === 'agent'
    || (!sys && !mine && !!getPeople().find((p) => p.id === who)?.agent);

  const line = document.createElement('div');
  line.className = `line ${sys ? 'sys' : ''} ${mine ? 'me' : ''} ${isAgent ? 'agent' : ''} ${pinged ? 'ping' : ''}`;
  line.dataset.kind = sys ? 'system' : pinged ? 'mention' : 'chat';

  const now = ts;
  // Discord-style grouping: consecutive lines from one author inside a short
  // window drop the repeated name, so a paragraph reads as a paragraph.
  // Historical lines are prepended out of order, so they never group.
  const grouped = !historical && !sys && who === lastAuthor && now - lastAt < 90_000;
  // sys lines pass THROUGH a group without erasing it: an act narration mid-
  // paragraph (an agent's tool use between spoken sentences) shouldn't force
  // the name to reprint on the next sentence. Only a real change of speaker
  // or the window ends a group. (Live observation, Rabscuttle 14:53.)
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
  // Everyone gets their colour, INCLUDING you: the point is that a name looks
  // the same to every reader, so people can refer to each other by it. Whisper
  // lines keep their purple — there the colour states the channel (private),
  // which matters more than which of the two of you is speaking.
  if (!sys && kind !== 'whisper') w.style.color = colorFor(who);
  // click a name to start a mention of them
  if (!sys && !mine) {
    w.onclick = () => { open(); insertAtCursor(`@${who} `); };
    w.style.cursor = 'pointer';
  }

  const b = document.createElement('span');
  b.className = 'body';
  b.append(renderBody(text, namesForHighlight()));

  line.append(t, w, b);
  applyFilter(line);
  return line;
}

// A join or a leave changes who has to be told apart, so colours are
// re-negotiated and the scrollback is repainted to match. Without the repaint,
// a name that shifted would read as two different people up the log.
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
    if (line.classList.contains('sys') || line.classList.contains('whisper')) continue;
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
  const show = filter.startsWith('w:') ? line.dataset.convo === filter.slice(2)
    : filter === 'all' ? true
      : filter === 'mentions' ? k === 'mention' || !!line.dataset.convo
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
  const jump = document.getElementById('chat-jump');
  if (jump) {
    jump.style.display = unread > 0 ? 'block' : 'none';
    jump.textContent = `${unread} new ${unreadMentions ? `· ${unreadMentions} ✱` : ''}↓`;
    jump.classList.toggle('ping', unreadMentions > 0);
  }
  frame?.badge(unread ? `<b class="${unreadMentions ? 'ping' : ''}">${unread}</b>` : '');
}

// ---------------------------------------------------------------- composer

function insertAtCursor(str) {
  const s = inputEl.selectionStart ?? inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, s) + str + inputEl.value.slice(inputEl.selectionEnd ?? s);
  const p = s + str.length;
  inputEl.setSelectionRange(p, p);
  inputEl.focus();
}

// ---- autocomplete -----------------------------------------------------------

let acBox = null, acItems = [], acIndex = 0, acStart = -1, acKind = null;

const COMMANDS = [
  ['/w', '/w <name> <message> — whisper, privately'],
  ['/r', 'reply to the last whisper you got'],
  ['/name', '/name <new name> — change what the world calls you'],
  ['/me', 'describe an action — "/me waves"'],
  ['/emote', '/emote dance · wave cheer dance point salute clap'],
  ['/sit', 'sit down, on a seat if one is near'],
  ['/push', '/push [name] [power] — shove someone within reach (their client decides); /push <thing> works the thing'],
  ['/pushable', '/pushable on|off — whether shoves and blasts can knock you over (on by default)'],
  ['/boom', '/boom [power] [radius] — a blast where you stand, you included (builder)'],
  ['/kick', '/kick [thing] [power] — send an object flying (a person\'s name = moderation)'],
  ['/punt', '/punt [thing] [power] — the unambiguous physics kick'],
  ['/who', 'list everyone present'],
  ['/role', 'what you may do here (or /role <name>)'],
  ['/grant', '/grant <name> owner|builder|visitor [+gen|-gen] — owner only'],
  ['/kick', '/kick <name> [reason] — remove someone from this world (owner)'],
  ['/ban', '/ban <name> [reason] — ban someone from this world (owner)'],
  ['/unban', '/unban <name> — lift a ban here (owner)'],
  ['/bans', 'who is banned from this world'],
  ['/gban', '/gban <name> [reason] — ban from ALL worlds (operator)'],
  ['/gunban', '/gunban <name> — lift a global ban (operator)'],
  ['/gbans', 'list global bans (operator)'],
  ['/fork', '/fork <new-name> — copy this world, history and all (owner)'],
  ['/reset', 'erase this world back to zero, archived not destroyed (owner)'],
  ['/goto', '/goto <name> — walk to someone'],
  ['/clear', 'clear your chat log'],
  ['/help', 'open the help sheet'],
];

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
    const hits = COMMANDS.filter(([c]) => c.slice(1).startsWith(q));
    return showAC(hits.map(([c, d]) => ({ value: c, label: c, hint: d })), 0, 'cmd');
  }

  // @mention
  const at = /(?:^|\s)@([\w-]*)$/.exec(upto);
  if (at) {
    const q = at[1].toLowerCase();
    const hits = getPeople()
      .filter((p) => p.id.toLowerCase().includes(q) && p.id !== CONFIG.name)
      .slice(0, 8);
    return showAC(
      hits.map((p) => ({ value: `@${p.id}`, label: p.id, hint: p.agent ? 'agent' : 'here' })),
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
  inputEl.value = v.slice(0, acStart) + it.value + ' ' + v.slice(caret);
  const p = acStart + it.value.length + 1;
  inputEl.setSelectionRange(p, p);
  closeAC();
}

// ---- commands ---------------------------------------------------------------

function runCommand(raw) {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case 'w': case 'whisper': {
      const to = rest[0];
      const body = rest.slice(1).join(' ');
      if (!to) { logChat('*', 'usage: /w <name> <message>'); return true; }
      if (!body) { openConvo(to); return true; }   // no message = just open the tab
      onWhisper(to, body);
      return true;
    }
    case 'r': case 'reply': {
      if (!lastWhisperFrom) { logChat('*', 'nobody has whispered you yet'); return true; }
      if (!arg) { openConvo(lastWhisperFrom); return true; }
      onWhisper(lastWhisperFrom, arg);
      return true;
    }
    case 'name': case 'rename': {
      if (!arg) { logChat('*', `you are ${CONFIG.name} — /name <new name> to change it`); return true; }
      bus.emit('command', { cmd: 'rename', arg });
      return true;
    }
    case 'me':
      if (arg) onSend(`* ${CONFIG.name} ${arg}`);
      return true;
    case 'emote':
      bus.emit('command', { cmd: 'emote', arg });
      return true;
    case 'sit':
      // /sit [thing] — a nearby declared seat wins over sitting on the ground
      bus.emit('command', { cmd: 'sit', arg });
      return true;
    case 'goto':
      bus.emit('command', { cmd: 'goto', arg });
      return true;
    case 'debug':
      // /debug [n] — the world's flight recorder: why things bounced
      bus.emit('command', { cmd: 'debug', arg });
      return true;
    case 'use': case 'pull': case 'ring': case 'open':
      // /use <thing> [action] — the universal interact. The aliases are the
      // same verb with the action already in hand: /pull lever1.
      // (/push is NOT in this row: it goes through the push command, which
      // sorts people from things — pushing a swing and shoving a person are
      // different acts that share a word.)
      bus.emit('command', {
        cmd: 'use',
        arg: cmd.toLowerCase() === 'use' ? arg : `${arg} ${cmd.toLowerCase()}`.trim(),
      });
      return true;
    case 'mount': case 'attach':
      // /mount <thing> <onto> [slot] — parent one thing to another, keeping
      // its current world pose (glue, don't teleport). The 🌳 scene panel is
      // the visual way to do the same.
      bus.emit('command', { cmd: 'mount', arg });
      return true;
    case 'dismount': case 'detach':
      bus.emit('command', { cmd: 'dismount', arg });
      return true;
    case 'role':
      bus.emit('command', { cmd: 'role', arg });
      return true;
    case 'grant':
      bus.emit('command', { cmd: 'grant', arg });
      return true;
    case 'kick':
      // one word, two acts (same split as /push): kicking a THING is
      // physics, kicking a PERSON is moderation — main.js sorts by what the
      // name denotes. /punt and /boot are unambiguous.
      bus.emit('command', { cmd: 'kick', arg });
      return true;
    case 'ban': case 'unban': case 'bans':
    case 'gban': case 'gunban': case 'gbans':
      bus.emit('command', { cmd: cmd.toLowerCase(), arg });
      return true;
    case 'push': case 'shove':
      bus.emit('command', { cmd: 'push', arg });
      return true;
    case 'pushable':
      bus.emit('command', { cmd: 'pushable', arg });
      return true;
    case 'boom': case 'blast':
      bus.emit('command', { cmd: 'boom', arg });
      return true;
    case 'punt': case 'boot':
      bus.emit('command', { cmd: 'punt', arg });
      return true;
    case 'fork': case 'copy':
      bus.emit('command', { cmd: 'fork', arg });
      return true;
    case 'reset': case 'erase':
      bus.emit('command', { cmd: 'reset', arg });
      return true;
    case 'who': {
      const list = getPeople().map((p) => p.id).join(', ');
      logChat('*', `here now: ${list || 'just you'}`);
      return true;
    }
    case 'clear':
      logEl.innerHTML = '';
      lastAuthor = null;
      return true;
    case 'help':
      bus.emit('command', { cmd: 'help' });
      return true;
    default:
      logChat('*', `unknown command /${cmd} — try /help`);
      return true;
  }
}

// ---------------------------------------------------------------- lifecycle

export const chat = {
  open() {
    frame.show();
    if (frame.state.collapsed) frame.collapse(false);
    inputEl.focus();
    scrollToEnd();
  },
  close() { inputEl.value = ''; closeAC(); inputEl.blur(); },
  get isOpen() { return document.activeElement === inputEl; },
  toggle() { frame.toggle(); },
  frame: () => frame,
  // unread accounting is observable so tests can pin it (Sol review, PR#7)
  unreadCounts: () => ({ unread, mentions: unreadMentions }),
  markRead: () => { unread = 0; unreadMentions = 0; paintUnread(); },
};
const open = chat.open;

export function initChat({ send, whisper, typing, people }) {
  onSend = send;
  onWhisper = whisper ?? (() => {});
  onTyping = typing ?? (() => {});
  getPeople = people ?? (() => []);

  frame = makeFrame('chat', {
    title: 'chat',
    x: 10, y: -10, w: 390, h: 200, minW: 240, minH: 100,
    className: 'chat-frame',
  });

  frame.body.innerHTML = `
    <div class="chat-tabs"></div>
    <div id="chatlog" class="chat-log"></div>
    <button id="chat-jump" class="chat-jump"></button>
    <div class="chat-typing"></div>
    <div class="chat-compose">
      <div id="chat-ac" class="ac panel"></div>
      <input id="chatline" placeholder="say something…  @ to mention · / for commands">
    </div>`;

  logEl = frame.body.querySelector('#chatlog');
  inputEl = frame.body.querySelector('#chatline');
  acBox = frame.body.querySelector('#chat-ac');
  closeAC();

  paintTabs();

  frame.body.querySelector('#chat-jump').onclick = scrollToEnd;
  logEl.addEventListener('scroll', () => {
    if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48) scrollToEnd();
    if (logEl.scrollTop < 60) loadOlder();
  });

  inputEl.addEventListener('input', () => {
    updateAC();
    // throttle: presence, not a keystroke log
    const now = performance.now();
    if (inputEl.value.trim() && now - lastTypingSent > 2500) {
      lastTypingSent = now;
      onTyping(filter.startsWith('w:') ? filter.slice(2) : null);
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
    if (e.key === 'ArrowUp' && !inputEl.value.trim() || (e.key === 'ArrowUp' && historyIdx >= 0)) {
      if (sentHistory.length) {
        e.preventDefault();
        historyIdx = Math.min(historyIdx + 1, sentHistory.length - 1);
        inputEl.value = sentHistory[sentHistory.length - 1 - historyIdx];
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      }
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0) {
      e.preventDefault();
      historyIdx--;
      inputEl.value = historyIdx < 0 ? '' : sentHistory[sentHistory.length - 1 - historyIdx];
      return;
    }

    if (e.key === 'Enter') {
      const v = inputEl.value.trim();
      inputEl.value = '';
      historyIdx = -1;
      closeAC();
      if (!v) { inputEl.blur(); return; }
      sentHistory.push(v);
      while (sentHistory.length > 50) sentHistory.shift();
      try { localStorage.setItem(HISTORY, JSON.stringify(sentHistory.slice(-20))); } catch { /* full */ }
      if (v.startsWith('/')) { runCommand(v); return; }
      // In a conversation tab, plain typing is a whisper — you should not have
      // to prefix every line of a private conversation with a command, and you
      // REALLY should not be able to say something aloud while looking at a
      // window that reads like a private one.
      if (filter.startsWith('w:')) onWhisper(filter.slice(2), v.slice(0, 4000));
      else onSend(v.slice(0, 4000));
    }
  });

  try { sentHistory.push(...(JSON.parse(localStorage.getItem(HISTORY) ?? '[]'))); } catch { /* none */ }

  return chat;
}

// ---------------------------------------------------------------- whispers
// A whisper shows in BOTH the conversation tab and 'all'. WoW puts whispers
// inline in the main window by default for a good reason: a private message
// you never see because you were on another tab is worse than no tabs at all.
// The tab is for following a thread, not for hiding it.

export function logWhisper({ from, to, text, echo }) {
  const other = echo ? to : from;
  if (!echo) lastWhisperFrom = from;
  ensureConvo(other);

  const line = document.createElement('div');
  line.className = `line whisper ${echo ? 'me' : 'ping'}`;
  line.dataset.kind = 'chat';
  line.dataset.convo = other;

  const d = new Date();
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = echo ? `to ${to}` : `${from}`;
  const b = document.createElement('span');
  b.className = 'body';
  b.append(renderBody(text, namesForHighlight()));
  line.append(t, w, b);

  lastAuthor = null;                 // a whisper breaks a grouping run
  applyFilter(line);
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  logEl.appendChild(line);
  while (logEl.children.length > MAX_LINES) logEl.removeChild(logEl.firstChild);

  if (!echo) {
    const c = convos.get(other);
    if (filter !== `w:${other}`) { c.unread++; paintTabs(); }
    bus.emit('pinged', { who: from, text });
  }
  if (atBottom) scrollToEnd(); else { unread++; paintUnread(); }
}

function ensureConvo(name) {
  if (!convos.has(name)) { convos.set(name, { unread: 0 }); paintTabs(); }
  return convos.get(name);
}
export function openConvo(name) {
  ensureConvo(name);
  chat.open();
  setFilter(`w:${name}`);
  inputEl.focus();
}

function setFilter(f) {
  filter = f;
  if (f.startsWith('w:')) { const c = convos.get(f.slice(2)); if (c) c.unread = 0; }
  paintTabs();
  repaintFilter();
  inputEl.placeholder = f.startsWith('w:')
    ? `whisper to ${f.slice(2)}…`
    : 'say something…  @ to mention · / for commands';
}

function paintTabs() {
  const bar = frame.body.querySelector('.chat-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  const mk = (key, label, unread = 0, closable = false) => {
    const b = document.createElement('button');
    b.className = filter === key ? 'on' : '';
    b.textContent = label + (unread ? ` ${unread}` : '');
    if (unread) b.classList.add('has-unread');
    b.onclick = () => setFilter(key);
    if (closable) {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        convos.delete(key.slice(2));
        if (filter === key) setFilter('all'); else { paintTabs(); }
      };
      b.title = 'right-click to close this conversation';
    }
    bar.appendChild(b);
  };
  mk('all', 'all');
  mk('mentions', 'mentions');
  mk('system', 'system');
  for (const [name, c] of convos) mk(`w:${name}`, `@${name}`, c.unread, true);
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

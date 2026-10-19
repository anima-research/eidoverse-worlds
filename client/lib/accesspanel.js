// accesspanel — the 🔒 access section of the world panel: who may come into
// this world, and until when (docs/DESIGN-world-access.md).
//
// Everything here is the `grant` verb underneath — the wildcard's rung for the
// door, a named record per member — so the panel can do nothing the chat
// commands (/access, /grant, /revoke) and an agent's world_access tool cannot,
// and the server is the only judge: refusals come back as toasts and are also
// shown inline here. The panel reads structure from the server (`access-state`)
// rather than re-deriving precedence from the fold, and re-asks whenever a
// grant lands in the log.
//
// Owners edit; everyone else sees the same facts read-only (roles are log
// entries — anyone present may read them).

import { CONFIG } from './base.js';
import { bus } from './base.js';
import { sendMod, sendVerb } from './net.js';
import { onWorldChange } from './state.js';
import { SELECT_CSS } from './rows.js';

const DOORS = [
  ['builder', 'open', 'anyone may come in and build'],
  ['visitor', 'visitors', 'anyone may come in; only those listed may build'],
  ['spectator', 'watch only', 'anyone may watch; only those listed may come in'],
  ['none', 'members only', 'invisible to everyone not listed'],
];
// `none` is a real grant too (made by chat, an agent, or here): an explicit
// "not this person", which matters in an open world
const ROLES = [['owner', 'owner'], ['builder', 'builder'], ['visitor', 'visitor'], ['spectator', 'watch only'], ['none', 'no access']];
const roleLabel = (r) => ROLES.find(([v]) => v === r)?.[1] ?? r;
const SPANS = [['', 'no end'], ['1h', '1 hour'], ['1d', '1 day'], ['1w', '1 week']];

let body = null;            // the section body, once opened
let state = null;           // the last access-state from the server
let lastError = '';         // the last refusal while the panel was open
let armedClose = null;      // the door rung awaiting a confirming second click
let search = { q: '', results: [], role: 'visitor', span: '' };
let refreshTimer = null, tickTimer = null;

const mk = (tag, cls, text, css) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (css) n.style.cssText = css;
  return n;
};
const isOpen = () => !!body && body.isConnected && !!body.closest('.sec.open');

function ask() { sendMod('access-state'); }
function askSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (isOpen()) ask(); }, 150);
}

// one set of subscriptions for the module; each acts only while the tab is open
bus.on('access-state', (m) => { state = m; if (isOpen()) paint(); });
bus.on('access-directory', (m) => {
  if (m.q !== search.q) return;             // an answer to an older keystroke
  search.results = Array.isArray(m.results) ? m.results : [];
  if (m.error) lastError = m.error;
  if (isOpen()) paint();
});
bus.on('verb-refused', ({ error }) => { if (isOpen()) { lastError = String(error ?? ''); paint(); } });
// someone arrived or left: "here now, not listed" and "here now" change
bus.on('roster', () => askSoon());
onWorldChange((ev) => {
  if (ev.type === 'reset') { state = null; armedClose = null; lastError = ''; }
  if (ev.type === 'entry' && ev.entry?.verb === 'grant') askSoon();
});

export function paintAccess(b) {
  body = b;
  lastError = '';
  armedClose = null;
  ask();
  paint();
  // relative times ("2 h left") stay true while the tab is open
  clearInterval(tickTimer);
  tickTimer = setInterval(() => { if (isOpen()) paint(); else clearInterval(tickTimer); }, 30_000);
}

function left(until, now = Date.now()) {
  const ms = until - now;
  if (ms <= 0) return 'ending';
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min left`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)} h left`;
  return `until ${new Date(until).toLocaleDateString()}`;
}
const ago = (t) => {
  const d = Date.now() - t;
  return d < 3_600_000 ? 'here recently' : d < 86_400_000 ? `seen ${Math.round(d / 3_600_000)} h ago` : `seen ${Math.round(d / 86_400_000)} d ago`;
};

function grant(args) { lastError = ''; sendVerb('grant', args); }

function select(options, value, onChange, title = '') {
  const sel = mk('select', null, null, SELECT_CSS + 'padding:2px 4px;');
  for (const [v, t] of options) sel.appendChild(new Option(t, v));
  sel.value = value;
  if (title) sel.title = title;
  sel.onchange = () => onChange(sel.value);
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  return sel;
}

function paint() {
  if (!body) return;
  // a repaint must not steal the search box from someone typing in it
  const focused = document.activeElement;
  const keep = focused?.dataset?.accessSearch === '1' ? [focused.selectionStart, focused.selectionEnd] : null;
  body.innerHTML = '';
  if (!state || state.world !== CONFIG.world) {
    body.append(mk('div', 'mod-note', 'asking the world…'));
    return;
  }
  const edit = !!state.mayEdit;
  const now = Date.now();

  // ---- the door ----
  body.append(mk('div', 'sec-cap', `who can come into ${state.world}`));
  if (!state.owned) {
    body.append(mk('div', 'mod-note', 'This world has no owner, so it is open: anyone may come in and build. An operator can make someone its owner.'));
  } else if (edit) {
    const row = mk('div', 'mod-btns');
    for (const [rung, label, what] of DOORS) {
      // the current door reads at a glance: the house's pressed fill plus the brand edge
      const b = mk('button', state.door === rung ? 'on' : '', label,
        state.door === rung ? 'border-color:var(--brand);color:var(--brand)' : '');
      b.title = what;
      b.setAttribute('aria-pressed', String(state.door === rung));
      b.onclick = () => {
        if (state.door === rung) return;
        // closing removes whoever is here and not listed — say so, and ask twice
        const losing = rung === 'none' || rung === 'spectator' ? (state.here ?? []).length : 0;
        if (losing && armedClose !== rung) { armedClose = rung; paint(); return; }
        armedClose = null;
        grant({ id: '*', role: rung });
      };
      row.append(b);
    }
    body.append(row);
    const doorWhat = DOORS.find(([r]) => r === state.door)?.[2] ?? `everyone else: ${state.door}`;
    body.append(mk('div', 'mod-note', doorWhat));
    if (armedClose) {
      const n = (state.here ?? []).length;
      const what = DOORS.find(([r]) => r === armedClose)?.[1];
      body.append(mk('div', 'mod-note warn',
        `${n} ${n === 1 ? 'person here isn\'t' : 'people here aren\'t'} listed and will have to leave${armedClose === 'spectator' ? ' (they may watch)' : ''}. Click "${what}" again to go ahead, or add them below first.`));
    }
  } else {
    const doorWhat = DOORS.find(([r]) => r === state.door);
    body.append(mk('div', 'mod-note', doorWhat ? `${doorWhat[1]}: ${doorWhat[2]}` : `everyone else: ${state.door}`));
    const you = state.you ?? {};
    body.append(mk('div', 'mod-note', `you are a ${you.role === 'spectator' ? 'watcher' : you.role}${you.until ? ` (${left(you.until, now)})` : ''} here${state.owned ? ' — its owners decide who comes in' : ''}`));
  }

  // ---- members ----
  const members = state.members ?? [];
  body.append(mk('div', 'sec-cap', `listed by name (${members.length})`));
  if (!members.length) body.append(mk('div', 'mod-note', 'nobody yet'));
  for (const m of members) {
    const row = mk('div', 'mod-row');
    const txt = mk('div', 'mod-txt');
    const name = mk('div', 'mod-nm', m.id === CONFIG.name ? `${m.id} (you)` : m.id);
    txt.append(name);
    const bits = [];
    if (m.kind === 'agent') bits.push('agent');
    if (m.here) bits.push('here now');
    if (m.until) bits.push(left(m.until, now));
    if (!edit) bits.unshift(roleLabel(m.role));
    if (bits.length) txt.append(mk('div', 'mod-note', bits.join(' · ')));
    if (m.kind === 'name' && state.door !== 'builder' && state.door !== 'visitor') {
      // a name-keyed record does not admit a person to a closed world
      txt.append(mk('div', 'mod-note warn', 'listed by name only: lets in an agent with this name, not a person. Remove and add them again once they have signed in.'));
    }
    row.append(txt);
    if (edit) {
      // edit BY SUBJECT when the record has one: the row's name is a display
      // name, and a display name can be made to look like something else
      const who = m.sub ?? m.id;
      const ctl = mk('div', null, null, 'display:flex;gap:4px;align-items:center;flex:none');
      ctl.append(select(ROLES, m.role, (role) => grant({ id: who, role }), 'role'));
      if (m.role !== 'owner') {
        // the span select shows "no end" when there is none; picking a span
        // restarts it from now
        ctl.append(select([['keep', m.until ? left(m.until, now) : 'no end'], ...SPANS.map(([v, t]) => [v || 'none', t])], 'keep',
          (v) => { if (v !== 'keep') grant({ id: who, ...(v === 'none' ? { until: null } : { for: v }) }); }, 'how long'));
      }
      const rm = mk('button', null, '✕', 'padding:2px 7px');
      rm.title = `take ${m.id} off the list`;
      rm.onclick = () => grant({ id: who, revoke: true });
      ctl.append(rm);
      row.append(ctl);
    }
    body.append(row);
  }

  if (edit && state.owned) {
    // ---- add someone ----
    body.append(mk('div', 'sec-cap', 'add someone'));
    const box = mk('input', null, null, 'width:100%;box-sizing:border-box');
    box.type = 'search';
    box.dataset.accessSearch = '1';
    box.placeholder = 'a name — people who have signed in, or an agent';
    box.value = search.q;
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();                          // typing ≠ walking
      if (e.key === 'Enter' && search.q.trim()) addByName(search.q.trim());
    });
    box.oninput = () => {
      search.q = box.value;
      if (search.q.trim()) sendMod('access-directory', { q: search.q });
      else { search.results = []; paint(); }
    };
    body.append(box);
    if (keep) { box.focus(); try { box.setSelectionRange(keep[0], keep[1]); } catch { /* search inputs may refuse */ } }
    const opts = mk('div', null, null, 'display:flex;gap:6px;align-items:center;flex-wrap:wrap');
    opts.append(mk('span', 'mod-note', 'as'), select(ROLES, search.role, (v) => { search.role = v; }, 'role'),
      mk('span', 'mod-note', 'for'), select(SPANS, search.span, (v) => { search.span = v; }, 'how long'));
    body.append(opts);
    for (const r of search.results) {
      const row = mk('div', 'mod-row');
      const txt = mk('div', 'mod-txt');
      txt.append(mk('div', 'mod-nm', r.name), mk('div', 'mod-note', `${r.kind} · ${ago(r.last)}`));
      const add = mk('button', null, 'add');
      // by SUBJECT: the pick binds to exactly this person, whatever else
      // shares the name
      add.onclick = () => { grant({ id: r.sub, role: search.role, ...(search.span ? { for: search.span } : {}) }); search.q = ''; search.results = []; paint(); };
      row.append(txt, add);
      body.append(row);
    }
    if (search.q.trim() && !search.results.some((r) => r.name.toLowerCase() === search.q.trim().toLowerCase())) {
      const row = mk('div', 'mod-row');
      const txt = mk('div', 'mod-txt');
      txt.append(mk('div', 'mod-note', search.results.length ? 'not who you mean?' : `nobody called "${search.q.trim()}" has signed in yet`),
        mk('div', 'mod-note', 'an agent can be added by its name; a person needs to sign in once (opening any world) before you can add them'));
      const add = mk('button', null, `add "${search.q.trim()}" by name`);
      add.onclick = () => addByName(search.q.trim());
      row.append(txt, add);
      body.append(row);
    }

    // ---- here now, not listed ----
    const here = state.here ?? [];
    if (here.length) {
      body.append(mk('div', 'sec-cap', `here now, not listed (${here.length})`));
      body.append(mk('div', 'mod-note', state.door === 'builder' || state.door === 'visitor'
        ? 'they are here because the world is open — closing it would remove them unless you add them'
        : 'they can stay until they leave'));
      const chips = mk('div', 'mod-btns');
      for (const p of here) {
        const b = mk('button', null, `+ ${p.id}`);
        b.title = p.verified ? `add ${p.id} as ${search.role}` : `${p.id} came in with a typed name — they can't be let into a closed world until they sign in`;
        if (!p.verified) b.disabled = true;
        b.onclick = () => grant({ id: p.sub ?? p.id, role: search.role, ...(search.span ? { for: search.span } : {}) });
        chips.append(b);
      }
      const verified = here.filter((p) => p.verified);
      if (verified.length > 1) {
        const all = mk('button', null, `add all ${verified.length}`);
        all.onclick = () => { for (const p of verified) grant({ id: p.sub ?? p.id, role: search.role, ...(search.span ? { for: search.span } : {}) }); };
        chips.append(all);
      }
      body.append(chips);
    }
  }

  if (lastError) body.append(mk('div', 'mod-note warn', lastError));
}

function addByName(name) {
  grant({ id: name, role: search.role, ...(search.span ? { for: search.span } : {}) });
  search.q = '';
  search.results = [];
  paint();
}

// base — the renderer-free substrate (RENDERER-SEAM move 2, split from
// core.js): the event bus, config, error routing, the participant colours,
// and two small helpers. Nothing here touches three.js, the DOM tree, or
// the GPU — which is the point: the ~35 modules that only ever wanted
// `bus`/`CONFIG`/`report` no longer import the module that constructs the
// renderer, and headless tests get the REAL bus and report instead of a
// stub's (this file guards its browser touches, so it imports clean under
// bun).
//
// Import rule (inherited from core): base imports NOTHING from the rest of
// the client. core.js imports base; everything else may import either.

// ------------------------------------------------------------ event bus
// Cross-cutting notifications (a verb landed, the connection changed, a toast)
// travel on this instead of through imports, which is what keeps net.js from
// having to know about the palette and vice versa.

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    for (const fn of listeners.get(evt) ?? []) {
      try { fn(payload); } catch (e) { console.error(`bus:${evt}`, e); }
    }
  },
};

// ------------------------------------------------------------ config
// One place that reads the URL and localStorage, so no module has to re-derive
// "who am I" from query params. Both are guarded: headless hosts have neither,
// and get the defaults.

// Which world: the link's ?world= if it names one; otherwise the world THIS
// TAB was last in (sessionStorage, so a reload keeps the tab where it was
// whatever other tabs have joined since); otherwise the world this browser
// was last IN as a person (localStorage), so a bare link (a bookmark, the
// login's return to '/') goes back where you were; the commons only for a
// browser that has been nowhere. Both are written by net.js rememberWorld.
// Spectators, renderers and the thumbnail minter ignore the memory: a link
// points them, and a renderer must never inherit a person's last stop.
// index.html's early-socket script makes this same choice before any module
// loads and publishes it as __ewWorld, which CONFIG takes when present, so
// the page has one answer (tools/last-world-test.ts holds the two copies
// in agreement).
export const LAST_WORLD_KEY = 'ew-world';      // localStorage: the browser's last world
export const TAB_WORLD_KEY = 'ew-world-tab';   // sessionStorage: this tab's
/** A name a world can have — the client's copy of server.ts admitJoin's rule
 *  (index.html's early-socket script carries its own: it runs before modules). */
export const isWorldName = (w) => typeof w === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w);
export function pickWorld(params, last, tab = null) {
  const asked = params.get('world');
  if (asked) return { world: asked, remembered: false };
  const person = !(params.has('spectate') || params.has('renderer') || params.has('mintthumbs'));
  if (person && isWorldName(tab)) return { world: tab, remembered: true };
  if (person && isWorldName(last)) return { world: last, remembered: true };
  return { world: 'commons', remembered: false };
}
/** The two memories as pickWorld takes them; storage that throws reads as none. */
export function rememberedWorlds() {
  const read = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
  return [read(globalThis.localStorage, LAST_WORLD_KEY), read(globalThis.sessionStorage, TAB_WORLD_KEY)];
}
/** What arriving in an empty world says (main.js, on 'hydrated'), by how the page
 *  got here: the link named it (a non-empty ?world=, as pickWorld reads it); a
 *  memory chose it (the last world this person was in, found empty now and so
 *  forgotten: net.js forgetEmptyWorld); or the commons by default. */
export function emptyWorldNotice({ world, params, worldRemembered }) {
  if (params.get('world')) return `"${world}" is empty — nothing has ever been built here.`;
  if (worldRemembered && world !== 'commons') {
    return `"${world}", the last world you were in, is empty now. Add ?world=<name> to the link to go somewhere else (?world=commons for the commons).`;
  }
  return `you are in "${world}", which is empty. Add ?world=<name> to the link to go somewhere else.`;
}

/** Forget where this person has been (ui.js logOut): the memory is the person's,
 *  and the browser may be the next person's. */
export function forgetRememberedWorlds() {
  try { globalThis.localStorage?.removeItem(LAST_WORLD_KEY); } catch { /* private mode */ }
  try { globalThis.sessionStorage?.removeItem(TAB_WORLD_KEY); } catch { /* private mode */ }
}

const params = new URLSearchParams(globalThis.location?.search ?? '');
const store = globalThis.localStorage ?? null;
const picked = globalThis.__ewWorld ?? pickWorld(params, ...rememberedWorlds());
export const CONFIG = {
  params,
  world: picked.world,
  // true when a memory chose the world, not the link: a refusal at its door
  // then forgets it and reloads to wherever a bare link leads next — the other
  // memory, or the commons (net.js forgetRefusedWorld)
  worldRemembered: picked.remembered,
  spectate: params.has('spectate'),
  renderer: params.has('renderer'),
  // a roaming renderer: the server may send it to any world a snapshot is asked of (server/snapshots.ts)
  roam: params.has('renderer') && params.has('roam'),
  follow: params.get('follow'),
  // Door key: ?key=… once, remembered for this origin thereafter.
  token: params.get('key') || store?.getItem('ew-key') || '',
  name: params.get('name') || store?.getItem('ew-name') ||
    `guest-${Math.random().toString(36).slice(2, 6)}`,
  // a dev host (the probes, a local server, ?dev): the guards that throw loudly instead of letting drift pass
  dev: params.has('dev') || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location?.hostname ?? ''),
};
if (params.get('key')) store?.setItem('ew-key', CONFIG.token);
store?.setItem('ew-name', CONFIG.name);
// the ACCOUNT a private (TRUST_NAMES) server knows you by, kept apart from the name you show (R 10-11: renaming herself
// "Rab" made her a stranger with no role in her own world). Fixed at the first real name this browser used; ?account=
// overrides. A server with sign-in ignores it: the session is the account there.
{ let acct = params.get('account') || store?.getItem('ew-account') || '';
  if (!acct && !/^guest-/.test(CONFIG.name)) acct = CONFIG.name;
  CONFIG.account = acct || null; if (acct) store?.setItem('ew-account', acct); }

/** The name a join ack says we have, minus the transport prefix sendJoin put
 *  on the wire id ("renderer-" / "retina-"). Pure, for net.js onSnapshot.
 *  A VERIFIED identity (the ack carries yourSub) is the server's own name for
 *  us — it ignored the requested id — so it is kept whole: a signed-in viewer
 *  really called "retina-helen" must not be shortened to "helen". */
export function nameFromJoinAck(you, { renderer = false, spectate = false, verified = false } = {}) {
  if (!you || verified) return you;
  const prefix = renderer ? 'renderer-' : spectate ? 'retina-' : '';
  return prefix && you.startsWith(prefix) ? you.slice(prefix.length) : you;
}

/** Rename in place (the front-door panel calls this before connecting). */
export function setName(name) {
  CONFIG.name = name;
  store?.setItem('ew-name', name);
  // the first real name this browser uses is its account, as at load: a first visit loads as a guest, and the door's name
  // is that first name (a later rename never moves the account)
  if (!CONFIG.account && name && !/^guest-/.test(name)) { CONFIG.account = name; store?.setItem('ew-account', name); }
}
export function setToken(token) {
  CONFIG.token = token;
  store?.setItem('ew-key', token);
}

// ------------------------------------------------------------ error routing
// Modules call report(); ui.js decides how to show it. Before the UI has
// registered a sink, errors still reach the console.
let errorSink = null;
export function setErrorSink(fn) { errorSink = fn; }

// A fault inside the frame loop reports 60 times a second. Identical messages
// are counted and re-reported on a decaying schedule instead of flooding the
// console and the toast stack — the first one is the useful one, and the
// hundredth actively hides everything else.
const seenErrors = new Map(); // key -> { n, nextAt }
// ---- console tee: what a visitor's page says, where the operator can read it.
// Every report() plus window errors post to /clientlog (key-gated, bounded
// server-side). Off the hot path (queued, one flush per second), never throws,
// and never carries the key in the payload or the URL — it rides the Authorization header
// (Bearer), below. `tee(line)` is for lines worth keeping ([xr] etc).
let teeQ = [], teeTimer = 0, teeMuted = false;
function teeFlush() {
  teeTimer = 0;
  if (!teeQ.length || teeMuted) return;
  const batch = teeQ.splice(0, 20);
  const url = `/clientlog?world=${encodeURIComponent(CONFIG.world ?? '')}`;
  const headers = { authorization: `Bearer ${CONFIG.token ?? ''}` };   // the door key never rides in a URL
  for (const line of batch) {
    try { fetch(url, { method: 'POST', body: line, headers, keepalive: true }).then((r) => { if (r.status === 401 || r.status === 404) teeMuted = true; }).catch(() => {}); }
    catch { /* the tee must never break the page */ }
  }
  if (teeQ.length) teeTimer = setTimeout(teeFlush, 1000);
}
const teeSeen = new Map();   // repeats cost one line, then one per 20
export function tee(line) {
  try {
    const who = CONFIG.name ?? '?';
    const key = String(line).slice(0, 160);
    if (!key.startsWith('[xr:rec]')) {
      const n = (teeSeen.get(key) ?? 0) + 1; teeSeen.set(key, n);
      if (n > 1 && n % 20 !== 0) return;
      if (n > 1) line = `${line} ×${n}`;
    }
    teeQ.push(`${who} ${String(line).slice(0, 3000)}`);
    if (teeQ.length > 200) teeQ.splice(0, teeQ.length - 200);
    if (!teeTimer) teeTimer = setTimeout(teeFlush, 1000);
  } catch { /* never */ }
}
/** tee, sent NOW: for the line before something that may freeze the page (a GPU-process compile), so it isn't lost
 *  in the 1 s batch. */
export function teeNow(line) { tee(line); try { clearTimeout(teeTimer); teeFlush(); } catch { /* never */ } }
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => tee(`[window.error] ${e.message} @ ${(e.filename ?? '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => tee(`[unhandled] ${e.reason?.message ?? e.reason}`));
  // wake CAUSE, not just the URL (cribbed from agent-framework #141's turn
  // provenance: who woke you ≠ whose words are in view): reload vs navigate
  // vs back_forward separates "R reloaded" from "the tunnel reconnected"
  let cause = '?'; try { cause = performance.getEntriesByType('navigation')[0]?.type ?? '?'; } catch { /* old UA */ }
  tee(`[boot] cause=${cause} host=${location.host} ${location.pathname}${location.search.replace(/key=[^&]+/, 'key=…')} ua=${navigator.userAgent.slice(0, 120)}`);
}

export function report(context, err) {
  const message = err?.message ?? String(err ?? 'unknown error');
  const key = `${context}:${message}`;
  const now = performance.now();
  const rec = seenErrors.get(key) ?? { n: 0, nextAt: 0 };
  rec.n++;
  const suppressed = now < rec.nextAt;
  if (rec.n === 1 || rec.n % 20 === 0) tee(`[report] ${context}: ${message} ×${rec.n} :: ${String(err?.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 600)}`);
  if (!suppressed) {
    // 1st, then 2s, 10s, 60s… — enough to show a fault is ongoing, not enough to drown
    rec.nextAt = now + Math.min(60000, 2000 * rec.n);
    console.error(context, err, rec.n > 1 ? `(×${rec.n})` : '');
    errorSink?.(context, rec.n > 1 ? `${message} (×${rec.n})` : message);
    bus.emit('error', { context, message, count: rec.n });
  }
  seenErrors.set(key, rec);
}
globalThis.addEventListener?.('unhandledrejection', (e) => report('async', e.reason));
globalThis.addEventListener?.('error', (e) => report('uncaught', e.error ?? e.message));

// ------------------------------------------------------------ misc helpers

/** Shortest signed angular difference, a → b. Used everywhere yaw is lerped. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Bounded-concurrency map — prefetch must not be serial, nor open 50 sockets. */
export async function parallelMap(items, fn, limit = 6) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

// ---- per-participant colour --------------------------------------------------
// A wall of chat all in one colour makes you read every name to follow a
// conversation. Each participant gets a stable colour instead, derived from
// their name alone — so it is the SAME colour in every client, and "the blue
// one" means the same person to everyone in the world. No assignment, no
// server state, nothing to keep in sync.
//
// A curated palette rather than hue = hash % 360: hand-picked entries are all
// legible on the dark panel and reliably distinct from each other, which a
// continuous hue wheel is not (it wanders through muddy olives and near-blacks
// at fixed lightness). Amber and mint are deliberately absent — those are the
// UI's own words for "you were mentioned" and "link/accent", and a person
// wearing them would be reading as punctuation.
const NAME_COLORS = [
  '#7cc4ff', '#ff9fc4', '#b8e06a', '#ffab6b',
  '#c4a6ff', '#6ee0d0', '#ff9a8f', '#9fb8ff',
  '#e9a6ff', '#7fe0a0', '#d8c470', '#62d3f0',
];
/** FNV-1a: cheap, and spreads short similar names (bot1/bot2) far apart. */
export function preferredColor(name) {
  let h = 0x811c9dc5;
  const s = String(name ?? '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NAME_COLORS[h % NAME_COLORS.length];
}

// Hashing alone is not enough. With twelve colours and six people in a room
// there is a ~78% chance two of them collide — and two speakers wearing one
// colour is exactly the confusion this was meant to remove. (Measured, not
// theorised: the first build put lyra and antra both on #ffab6b.)
//
// So the hash is a PREFERENCE, and the people actually present negotiate. Every
// client runs the same assignment over the same roster in the same order, so
// the answer is identical everywhere without a byte crossing the wire: sort the
// names, let each take its preferred colour, and linear-probe when it is taken.
// Whoever sorts first keeps their preference, so a colour only ever moves for
// the loser of a collision. People who have left keep the colour they had —
// their lines are still on the screen.
const claimed = new Map();   // name -> colour, sticky once assigned

/** The colour to draw `name` in, anywhere in the UI. */
export function colorFor(name) {
  const k = String(name ?? '').toLowerCase();
  return claimed.get(k) ?? preferredColor(name);
}

/** Re-negotiate colours for the people present. Call on roster changes. */
export function assignColors(names) {
  const present = [...new Set(names.map((n) => String(n ?? '').toLowerCase()))].filter(Boolean).sort();
  const used = new Set();
  for (const n of present) {
    const start = NAME_COLORS.indexOf(preferredColor(n));
    let c = NAME_COLORS[start];
    for (let k = 1; used.has(c) && k <= NAME_COLORS.length; k++) {
      c = NAME_COLORS[(start + k) % NAME_COLORS.length];
    }
    used.add(c);
    claimed.set(n, c);
  }
  return claimed;
}

/** The 'avatar-worn' payload's name: mybody.announceWorn emits { name, path }, setMe emits a string. Every listener
 *  that keys anything by body name goes through here (bodies.js, xr.js). */
export const wornNameOf = (v) => (typeof v === 'string' ? v : v?.name) ?? '';

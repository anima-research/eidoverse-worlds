// base — the renderer-free substrate: the event bus, config, error routing, the participant
// colours, and two small helpers. Nothing here touches three.js, the DOM tree, or the GPU, so
// modules that only want `bus`/`CONFIG`/`report` don't import the renderer, and headless tests get
// the REAL bus and report (browser touches are guarded, so it imports clean under bun).
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

// Which world: the link's ?world=; else the world THIS TAB was last in (sessionStorage); else the
// world this browser was last in as a person (localStorage); else the commons. Both memories are
// written by net.js rememberWorld. Spectators, renderers and the thumbnail minter ignore the memory.
// index.html's early-socket script makes the same choice first and publishes it as __ewWorld, which
// CONFIG takes when present (test/client/last-world-test.ts holds the two copies in agreement).
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
  const read = (s, k) => { try { return s()?.getItem(k) ?? null; } catch { return null; } };   // the property itself may throw
  return [read(() => globalThis.localStorage, LAST_WORLD_KEY), read(() => globalThis.sessionStorage, TAB_WORLD_KEY)];
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
// a sandboxed frame throws on the property, a blocked one on every call: either way the page runs without a memory
const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();
const remembered = (k) => { try { return store?.getItem(k) ?? null; } catch { return null; } };
const remember = (k, v) => { try { store?.setItem(k, v); } catch { /* no memory here */ } };
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
  // a roaming renderer: the server may send it to any world a screenshot is asked of (server/screenshots.ts)
  roam: params.has('renderer') && params.has('roam'),
  follow: params.get('follow'),
  // Door key: ?key=… once, remembered for this origin thereafter.
  token: params.get('key') || remembered('ew-key') || '',
  name: params.get('name') || remembered('ew-name') ||
    `guest-${Math.random().toString(36).slice(2, 6)}`,
  // a dev host (the probes, a local server, ?dev): the guards that throw loudly instead of letting drift pass
  dev: params.has('dev') || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location?.hostname ?? ''),
};
if (params.get('key')) remember('ew-key', CONFIG.token);
remember('ew-name', CONFIG.name);
// the ACCOUNT a private (TRUST_NAMES) server knows you by, kept apart from the name you show (a rename must not make
// you a stranger in your own world). Fixed at the first real name this browser used; ?account= overrides. A server with
// sign-in ignores it: the session is the account there.
{ let acct = params.get('account') || remembered('ew-account') || '';
  if (!acct && !/^guest-/.test(CONFIG.name)) acct = CONFIG.name;
  CONFIG.account = acct || null; if (acct) remember('ew-account', acct); }

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

// A fault inside the frame loop reports 60 times a second: identical messages are counted
// and re-reported on a decaying schedule instead of flooding the console and the toasts.
const seenErrors = new Map(); // key -> { n, nextAt }
// ---- console tee: what a visitor's page says, where the operator can read it (server/clientlog.ts).
// Every report() plus window errors post to /clientlog: queued, one POST per flush, never throws; the key rides the
// Authorization header, never the URL. A 429 waits its Retry-After (60 s when unsaid) with the lines kept.
let teeQ = [], teeTimer = 0, teeMuted = false, teePausedUntil = 0;
// batched every 10 s; as the page hides one batch goes at once (keepalive's cap) and the rest waits for the timer
const TEE_LINES = 2000, TEE_BYTES = 60 * 1024, TEE_DEBOUNCE_MS = 10000;   // 60 KB: under keepalive's 64 KB in-flight cap
function teeFlush() {
  teeTimer = 0;
  if (!teeQ.length || teeMuted) return;
  if (Date.now() < teePausedUntil) { teeTimer = setTimeout(teeFlush, teePausedUntil - Date.now()); return; }
  const bytes = (s) => new TextEncoder().encode(s).length;   // the cap is in bytes on the wire, not UTF-16 units
  let body = teeQ[0], i = 1, size = bytes(body);
  for (; i < teeQ.length && size + 1 + bytes(teeQ[i]) <= TEE_BYTES; i++) { body += `\n${teeQ[i]}`; size += 1 + bytes(teeQ[i]); }
  const batch = teeQ.splice(0, i);
  const url = `/clientlog?world=${encodeURIComponent(CONFIG.world ?? '')}`;
  const headers = { authorization: `Bearer ${CONFIG.token ?? ''}` };   // the door key never rides in a URL
  try {
    fetch(url, { method: 'POST', body, headers, keepalive: true }).then((r) => {
      if (r.status === 401 || r.status === 404) teeMuted = true;
      else if (r.status === 429) { teePausedUntil = Date.now() + 1000 * (Number(r.headers.get('retry-after')) || 60); teeQ.unshift(...batch); }
      if (teeQ.length > TEE_LINES) teeQ.splice(0, teeQ.length - TEE_LINES);
      if (teeQ.length && !teeTimer) teeTimer = setTimeout(teeFlush, TEE_DEBOUNCE_MS);
    }).catch(() => {});
  } catch { /* the tee must never break the page */ }
  if (teeQ.length && !teeTimer) teeTimer = setTimeout(teeFlush, TEE_DEBOUNCE_MS);
}
const teeSeen = new Map();   // repeats cost one line, then one per 20
export function tee(line) {
  try {
    const who = CONFIG.name ?? '?';
    const key = String(line).slice(0, 160);
    if (!key.startsWith('[xr:rec]')) {
      if (teeSeen.size >= 4096) teeSeen.clear();   // bounded: a long session forgets its repeat counts rather than growing
      const n = (teeSeen.get(key) ?? 0) + 1; teeSeen.set(key, n);
      if (n > 1 && n % 20 !== 0) return;
      if (n > 1) line = `${line} ×${n}`;
    }
    teeQ.push(`${who} ${String(line).slice(0, 3000)}`);
    if (teeQ.length > TEE_LINES) teeQ.splice(0, teeQ.length - TEE_LINES);
    if (!teeTimer) teeTimer = setTimeout(teeFlush, TEE_DEBOUNCE_MS);
  } catch { /* never */ }
}
/** tee, sent NOW: for the line before something that may freeze the page (a GPU-process compile), so it isn't lost
 *  in the batch. A 429's wait still holds. */
export function teeNow(line) { tee(line); try { clearTimeout(teeTimer); teeFlush(); } catch { /* never */ } }
/** The page is going away (pagehide, or hidden, which is the last event a mobile tab reliably gets): send what's queued. */
export function teeOnHide() { try { if (teeQ.length) { clearTimeout(teeTimer); teeFlush(); } } catch { /* never */ } }
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', teeOnHide);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') teeOnHide(); });
  window.addEventListener('error', (e) => tee(`[window.error] ${e.message} @ ${(e.filename ?? '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => tee(`[unhandled] ${e.reason?.message ?? e.reason}`));
  // the navigation type separates "someone reloaded" from "the tunnel reconnected"
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
// Each participant gets a colour negotiated from the names present (a hashed preference, below) — the SAME colour in
// every client, with no server state; a newcomer can move someone else's. A curated palette (legible on the dark panel, mutually
// distinct) rather than a hue wheel; amber and mint are absent because the UI uses them for
// "you were mentioned" and "link/accent".
const NAME_COLORS = [
  '#7cc4ff', '#ff9fc4', '#b8e06a', '#ffab6b',
  '#c4a6ff', '#6ee0d0', '#ff9a8f', '#9fb8ff',
  '#e9a6ff', '#7fe0a0', '#d8c470', '#62d3f0',
];
/** FNV-1a: cheap, and spreads short similar names (bot1/bot2) far apart. */
function preferredColor(name) {
  let h = 0x811c9dc5;
  const s = String(name ?? '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NAME_COLORS[h % NAME_COLORS.length];
}

// The hash is a PREFERENCE (twelve colours, six people: ~78% chance of a collision); the people present negotiate.
// Every client runs the same assignment over the same roster (sorted names, linear-probe when taken), so it is
// identical everywhere with no wire bytes. People who have left keep their colour (their lines are on screen).
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

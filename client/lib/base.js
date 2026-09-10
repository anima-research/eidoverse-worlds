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

const params = new URLSearchParams(globalThis.location?.search ?? '');
const store = globalThis.localStorage ?? null;
export const CONFIG = {
  params,
  world: params.get('world') || 'commons',
  spectate: params.has('spectate'),
  renderer: params.has('renderer'),
  follow: params.get('follow'),
  // Door key: ?key=… once, remembered for this origin thereafter.
  token: params.get('key') || store?.getItem('ew-key') || '',
  name: params.get('name') || store?.getItem('ew-name') ||
    `guest-${Math.random().toString(36).slice(2, 6)}`,
};
if (params.get('key')) store?.setItem('ew-key', CONFIG.token);
store?.setItem('ew-name', CONFIG.name);

/** Rename in place (the front-door panel calls this before connecting). */
export function setName(name) {
  CONFIG.name = name;
  store?.setItem('ew-name', name);
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
// and never carries the key in the payload — the key rides the query like the
// door's own requests. `tee(line)` is for lines worth keeping ([xr] etc).
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

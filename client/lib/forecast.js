// forecast — the deterministic ambient-weather oracle, and the one sky fold
// every plane shares.
//
// PURE and dependency-free ON PURPOSE: three species of runtime import this
// file — the browser client (sky.js / world.js), the sequencer's fold
// (server/server.ts), and embodied agents (mcpl/agent.ts). Shared facts (time
// of day, weather state, transition phase) must be DERIVED identically
// everywhere, so the derivation lives in exactly one place. No three, no DOM,
// and no Date.now() of its own — callers pass `now`, tests pass whatever they
// like.
//
// The shape (issue #29): a world's `sky` verb may carry a `forecast` policy —
// seed, allowed states, dwell ranges, transition time. The POLICY is authored
// (an actor, a log seq); every weather change derived from it is a
// world-system realization of that policy, computed independently by each
// client from (policy, epoch, now). No server simulation, no per-frame log
// entries, no per-client randomness: late join, reconnect, and two
// simultaneous clients all land on the same segment of the same forecast.

export const WEATHERS = ['clear', 'fair', 'sunshower', 'overcast', 'rain', 'storm', 'cyclone', 'darkstorm'];

// ---------------------------------------------------------------- day clock

// Wall-clock mode: `sky {clock: "real", tz: "America/Los_Angeles"}` makes the
// world's hour BE the named timezone's hour — noon in the world is noon on
// that clock, DST included (Intl owns the tz database; ECMA-402, present in
// every runtime that folds a sky). Formatters are cached per tz: hoursAt runs
// per frame under the sun. An unknown tz caches null and the rated clock
// takes over — a typo dims nothing.
const _tzFmt = new Map();
function tzFormatter(tz) {
  if (_tzFmt.has(tz)) return _tzFmt.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  } catch { /* unknown tz — remembered as null */ }
  _tzFmt.set(tz, f);
  return f;
}

/** The hour of day a sky's authored epoch implies at time `tMs`. This is THE
 *  formula — sky.js's sun and the fold's rebase both call it, which is what
 *  keeps a weather verb from snapping the day (see foldSkyEntry). No ambient
 *  Date.now() even in clock mode: the wall hour is derived from the caller's
 *  tMs, so tests can freeze time and every plane derives identically. */
export function hoursAt(sky, tMs) {
  if (!sky) return 12;
  if (sky.clock === 'real') {
    const f = tzFormatter(sky.tz ?? 'America/Los_Angeles');
    if (f) {
      const get = Object.fromEntries(f.formatToParts(new Date(tMs)).map((p) => [p.type, p.value]));
      return (Number(get.hour) % 24) + Number(get.minute) / 60 + Number(get.second) / 3600;
    }
    // tz didn't resolve: the PARKED rated clock governs (#65). A normalized
    // bag carries no top-level hours/rate — without this arm a typo'd tz on a
    // normalized world would freeze the sun at the `?? 12` default forever.
    // dormantRated anchors on its own ts (the parking moment), so later
    // weather merges restamping sky.ts never snap the fallback day.
    const d = sky.dormantRated;
    if (d && typeof d === 'object') {
      return ((((d.hours ?? 12) + (d.rate ?? 0) * (tMs - (d.ts ?? sky.ts ?? tMs)) / 3600e3) % 24) + 24) % 24;
    }
  }
  return ((sky.hours ?? 12) + (sky.rate ?? 0) * (tMs - (sky.ts ?? tMs)) / 3600e3 + 24000) % 24;
}

// ---------------------------------------------------------------- rng
// One independent draw stream per (seed, segment index): mulberry32 keyed by
// mixing the index into the seed. Draw ORDER within a segment is part of the
// wire contract (dwell, then state, then intensity) — reordering draws would
// silently fork every deployed world's forecast.

function hashSeed(seed) {
  const s = String(seed ?? 1);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function segRng(seed, idx) {
  let h = (seed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- policy

// The dwell floor bounds two things at once: how often the sky may lurch
// (a strobing forecast is a griefing vector, not a weather system) and how
// long the late-join segment walk can get — at 60s minimum, a year-old
// policy is ~525k iterations of cheap integer math, a few milliseconds once.
const DWELL_FLOOR_S = 60;
const DWELL_CAP_S = 6 * 3600;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** Validate + normalize an authored policy bag. Returns null when the bag
 *  doesn't amount to a usable policy (no valid states, not an object) —
 *  callers treat null as "forecast off". */
export function normalizePolicy(f) {
  if (!f || typeof f !== 'object') return null;
  const states = [];
  for (const s of Array.isArray(f.states) ? f.states : []) {
    const name = typeof s === 'string' ? s : s?.state;
    const weight = (s && typeof s === 'object' && Number.isFinite(s.weight)) ? Math.max(0, s.weight) : 1;
    if (WEATHERS.includes(name) && weight > 0) states.push({ state: name, weight });
  }
  if (!states.length) return null;
  const d = Array.isArray(f.dwellSec) ? f.dwellSec : [600, 1800];
  const dwellMin = clamp(d[0], DWELL_FLOOR_S, DWELL_CAP_S);
  const dwellMax = clamp(d[1] ?? dwellMin, dwellMin, DWELL_CAP_S);
  const k = Array.isArray(f.k) ? f.k : [0.7, 1];
  const kMin = clamp(k[0], 0.1, 1.5);
  const kMax = clamp(k[1] ?? kMin, kMin, 1.5);
  return {
    seed: hashSeed(f.seed),
    states,
    dwellMinMs: dwellMin * 1000,
    dwellMaxMs: dwellMax * 1000,
    kMin, kMax,
    // a transition may never outlive the shortest segment — otherwise a new
    // ease can begin before the previous one finishes, forever
    transitionSec: clamp(f.transitionSec ?? 30, 1, Math.min(600, dwellMin)),
    epoch: Number.isFinite(f.epoch) ? f.epoch : 0,   // stamped at fold; 0 = never folded
    seq: f.seq, by: f.by,
  };
}

// ---------------------------------------------------------------- segments

function pickState(states, prev, r) {
  // never re-draw the state we're already in when there is anywhere else to
  // go — a forecast whose transitions are invisible isn't one
  const pool = states.filter((s) => s.state !== prev);
  const use = pool.length ? pool : states;
  let x = r() * use.reduce((t, s) => t + s.weight, 0);
  for (const s of use) { x -= s.weight; if (x < 0) return s.state; }
  return use[use.length - 1].state;
}

/** The forecast segment containing `nowMs`. Pure oracle: same answer from a
 *  cold walk or a resumed cursor (the returned segment IS the cursor — feed
 *  it back on the next tick and the walk is O(1) from then on; fence #3). */
export function segmentAt(p, nowMs, cursor = null) {
  let idx = 0, start = p.epoch, prev = null;
  if (cursor && cursor.seed === p.seed && cursor.epoch === p.epoch
      && cursor.startMs <= nowMs && Number.isFinite(cursor.startMs)) {
    ({ idx, startMs: start, prevState: prev } = cursor);
  }
  for (;;) {
    const r = segRng(p.seed, idx);
    const dwellMs = p.dwellMinMs + r() * (p.dwellMaxMs - p.dwellMinMs);
    const state = pickState(p.states, prev, r);
    const k = p.kMin + r() * (p.kMax - p.kMin);
    const endMs = start + dwellMs;
    if (nowMs < endMs) {
      return { idx, startMs: start, endMs, state, k, prevState: prev, seed: p.seed, epoch: p.epoch };
    }
    prev = state; start = endMs; idx++;
  }
}

// ---------------------------------------------------------------- the answer

/** What the sky should SHOW at `nowMs` — the one question client, agent, and
 *  tests all ask. Sources:
 *    'authored' — no active policy; the folded weather verb is the truth
 *    'forecast' — the policy's current segment
 *    'manual'   — a weather verb landed inside the current segment; it holds
 *                 until the segment boundary, then the forecast resumes
 *  `cursor` in / `cursor` out keeps live ticking O(1); omit it for a cold
 *  (late-join / test) derivation. */
export function effectiveSky(sky, nowMs, cursor = null) {
  const authored = {
    source: 'authored',
    weather: WEATHERS.includes(sky?.weather) ? sky.weather : null,
    k: sky?.weatherK ?? 1,
    seconds: sky?.weatherSeconds,
    cursor: null,
  };
  const p = normalizePolicy(sky?.forecast);
  if (!p || !p.epoch) return authored;
  const seg = segmentAt(p, Math.max(nowMs, p.epoch), cursor);
  const o = sky.override;
  // an override governs from the moment it LANDED to the end of its segment —
  // never earlier (a skewed clock must not see a "future" override in force)
  if (o && WEATHERS.includes(o.state) && nowMs >= o.ts && o.ts >= seg.startMs && o.ts < seg.endMs) {
    return {
      source: 'manual', weather: o.state, k: o.k ?? 1,
      seconds: sky.weatherSeconds, seg, cursor: seg,
      by: o.by, seq: o.seq, resumesMs: seg.endMs,
    };
  }
  return {
    source: 'forecast', weather: seg.state, k: seg.k,
    seconds: p.transitionSec, seg, cursor: seg,
    by: p.by, seq: p.seq, untilMs: seg.endMs,
    inTransition: nowMs - seg.startMs < p.transitionSec * 1000,
  };
}

// ---------------------------------------------------------------- fold

/** dormantRated is a CLOCK, not a grab-bag: {hours, rate, ts} — the rated
 *  clock parked when real mode took over, anchored at its own parking-moment
 *  ts. Shape-sanitize anything arriving from args or prior state: finite
 *  numbers only, no junk keys. Null when nothing usable remains. */
function sanitizeDormant(d) {
  if (!d || typeof d !== 'object') return null;
  const s = {};
  if (Number.isFinite(d.hours)) s.hours = d.hours;
  if (Number.isFinite(d.rate)) s.rate = d.rate;
  if (Number.isFinite(d.ts)) s.ts = d.ts;
  return (s.hours != null || s.rate != null) ? s : null;
}

/** One clock may govern (issue #65). Whenever `clock:'real'` is authored,
 *  the rated fields `hours`/`rate` never remain as active-looking top-level
 *  state: they park under `dormantRated` — an explicitly-inactive clock a
 *  later return to rated mode restores from (the tuner prefills its sliders
 *  with it), and the one fallback source hoursAt/effectiveClock consult when
 *  the tz turns out not to resolve. Parking is UNCONDITIONAL on real mode —
 *  the fold never asks ICU anything, so the folded STATE is a pure function
 *  of the log on every runtime; only derived hours depend on the tz database
 *  (exactly as on the pre-contract fold). Outside real mode `dormantRated`
 *  is dropped: the top-level fields are the active clock again.
 *
 *  Newly-authored top-level fields win over the carried-forward park (and
 *  re-anchor its ts); a standing-bag re-issue with neither inherits `prior`
 *  untouched — that is how the wholesale sky fold carries the parked clock
 *  across mode flips without the fold holding any state of its own.
 *
 *  Runs on EVERY fold, synthetic replay included — config normalization, not
 *  provenance stamping: deterministic, idempotent, and it heals bags folded
 *  before the contract existed the next time a late join replays them. */
function normalizeClock(out, prior) {
  delete out.dormantRated;
  if (out.clock === 'real') {
    const parked = {};
    if (Number.isFinite(out.hours)) parked.hours = out.hours;
    if (Number.isFinite(out.rate)) parked.rate = out.rate;
    const d = (parked.hours != null || parked.rate != null)
      ? { ...(prior ?? {}), ...parked, ts: out.ts }
      : prior;
    delete out.hours; delete out.rate;
    if (d) out.dormantRated = d;
  }
  return out;
}

/** Fold a `sky` or `weather` log entry onto the standing sky state. The
 *  sequencer, the live browser client, and the embodied agent all fold
 *  through here — one code path, three planes, no drift.
 *
 *  Server-owned stamps: `forecast.{epoch,seq,by}`, the whole `override` bag,
 *  and the top-level `seq`/`by` (which sky entry authored this bag — the
 *  effective clock's provenance, issue #65) come from the ENTRY, never from
 *  the authored args — a policy bag cannot spoof its own provenance. The one
 *  exception is synthetic pre-history replay (stateToEntries' negative seqs):
 *  those args ARE the already-stamped fold, so stamps pass through untouched —
 *  restamping them with the synthetic entry would re-epoch the forecast on
 *  every late join.
 *
 *  A weather verb under a rated sky also REBASES `hours` to the hour the old
 *  epoch implies at the entry's ts. Without this the merge re-epochs t0 while
 *  `hours` stays at the authored value, and the sun snaps back to it on every
 *  weather change — on both planes, live and fold. */
export function foldSkyEntry(prev, { verb, args = {}, ts, seq, actor }) {
  const synthetic = (seq ?? 0) < 0;
  if (verb === 'sky') {
    const out = { ...args, ts: synthetic ? (args.ts ?? ts) : ts };
    if (!synthetic) {
      delete out.override;
      if (args.forecast && typeof args.forecast === 'object') {
        out.forecast = { ...args.forecast, epoch: ts, seq, by: actor };
      } else {
        delete out.forecast;      // absent or null: forecast off, authored-only
      }
      out.seq = seq; out.by = actor;
    }
    // args.dormantRated is the standing-bag re-issue carrier (the wholesale
    // fold has no prev to inherit from) — authored CONFIG at the same trust
    // level as authoring hours/rate directly (same verb, same rank), but
    // shape-sanitized so junk can never land in the fold
    return normalizeClock(out, sanitizeDormant(args.dormantRated));
  }
  // weather — merges onto the standing sky (DESIGN.md: a thing that HAPPENS,
  // not a property you set). `keepSky: false` discards the standing sky and
  // starts fresh from this verb alone — the helper owns that semantic so the
  // sequencer's fold and the live client can never disagree about it.
  const base = args.keepSky === false ? {} : (prev ?? {});
  const out = { ...base, ...args, ts };
  delete out.keepSky;   // an instruction to the fold, not a sky property
  if ((base.rate ?? 0) !== 0 && args.hours == null) out.hours = hoursAt(base, ts);
  if (!synthetic) {
    // a weather verb cannot author or clear policy — that is the sky verb's job
    if (base.forecast) out.forecast = base.forecast; else delete out.forecast;
    if (base.forecast && WEATHERS.includes(args.weather)) {
      out.override = {
        state: args.weather,
        ...(args.weatherK != null ? { k: args.weatherK } : {}),
        ts, seq, by: actor,
      };
    } else if (base.override) out.override = base.override;
    else delete out.override;
    // nor can it claim authorship of the bag — seq/by stay the sky entry's
    if (base.seq != null) out.seq = base.seq; else delete out.seq;
    if (base.by != null) out.by = base.by; else delete out.by;
  }
  // a weather verb can never author the parked clock — base's only
  return normalizeClock(out, sanitizeDormant(base.dormantRated));
}

/** The canonical answer to "what clock governs this sky?" (issue #65) — no
 *  precedence folklore. Mirrors hoursAt's ACTUAL behavior, including the
 *  unknown-tz fallback: `mode` is what is effective right now, never what was
 *  merely requested. Shapes:
 *    { mode:'real',  tz, hour, seq?, by? }
 *    { mode:'rated', rate, hour, seq?, by?, requestedTz? }
 *    { mode:'fixed', hour, seq?, by?, requestedTz? }
 *  `requestedTz` appears only when `clock:'real'` was authored with a tz Intl
 *  cannot resolve — the fallback governs and says so. `seq`/`by` are the
 *  fold-stamped provenance of the sky entry that authored this bag. */
export function effectiveClock(sky, nowMs) {
  if (!sky) return { mode: 'fixed', hour: 12 };
  const hour = hoursAt(sky, nowMs);
  const prov = {
    ...(sky.seq != null ? { seq: sky.seq } : {}),
    ...(sky.by != null ? { by: sky.by } : {}),
  };
  if (sky.clock === 'real') {
    const tz = sky.tz ?? 'America/Los_Angeles';
    if (tzFormatter(tz)) return { mode: 'real', tz, hour, ...prov };
    // fallback mirrors hoursAt exactly: the parked clock on a normalized
    // bag, the top-level fields on a bag that never folded (preview args)
    const rate = (sky.dormantRated && typeof sky.dormantRated === 'object')
      ? (sky.dormantRated.rate ?? 0) : (sky.rate ?? 0);
    return rate !== 0
      ? { mode: 'rated', rate, hour, requestedTz: tz, ...prov }
      : { mode: 'fixed', hour, requestedTz: tz, ...prov };
  }
  const rate = sky.rate ?? 0;
  return rate !== 0 ? { mode: 'rated', rate, hour, ...prov } : { mode: 'fixed', hour, ...prov };
}

/** Coarse day phase — the granularity ambient perception actually wants.
 *  Continuous hour updates would be spam; crossing dawn is an event. */
export function dayPhase(hours) {
  if (hours >= 5 && hours < 8) return 'dawn';
  if (hours >= 8 && hours < 18) return 'day';
  if (hours >= 18 && hours < 21) return 'dusk';
  return 'night';
}

// ---------------------------------------------------------------- narration

/** One legible line for text perception and debug output — who set the sky
 *  in motion, and what it is doing right now. */
export function describeSky(sky, nowMs) {
  if (!sky) return null;
  const bits = [];
  const ck = effectiveClock(sky, nowMs);
  bits.push(`hour ${ck.hour.toFixed(1)}${ck.mode === 'real'
    ? ` (real time, ${ck.tz})`
    : ck.mode === 'rated' ? ` (advancing ×${ck.rate})` : ''}${ck.requestedTz
    ? ` (requested real-time tz "${ck.requestedTz}" is unknown — fallback clock in effect)` : ''}`);
  const eff = effectiveSky(sky, nowMs);
  const mins = (t) => Math.max(0, Math.round((t - nowMs) / 60000));
  if (eff.source === 'forecast') {
    bits.push(`weather ${eff.weather} (forecast — policy sky seq ${eff.seq ?? '?'} by ${eff.by ?? '?'}, `
      + `seed ${sky.forecast?.seed ?? '?'}, seg ${eff.seg.idx}, ~${mins(eff.untilMs)}m to next)`);
  } else if (eff.source === 'manual') {
    bits.push(`weather ${eff.weather} (manual override by ${eff.by ?? '?'} seq ${eff.seq ?? '?'} — `
      + `forecast resumes in ~${mins(eff.resumesMs)}m)`);
  } else if (eff.weather) {
    bits.push(`weather ${eff.weather}`);
  }
  return bits.join(', ');
}

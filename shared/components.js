// shared/components.js — the component library, engine rung (RFC #208 steps 3–4, data-only).
//
// An entity is a Transform plus a list of components. Each component type is an
// immutable, content-addressed RECORD: a name, a parameter schema (type, default,
// range, unit), what it needs, what an old client shows instead, and the line a
// text-tier resident reads. No record carries code; the realizers that give the
// built-ins behaviour are the engine's own.
//
// The wire does not change here. Today's spellings (`lib`, `kind: "light"`,
// `collide`, `parent`, `comp.motion` with its `type` enum, `comp.sockets`, …)
// are ALIASES: `componentsOf` reads any folded entity as a component list, and
// `entityOf` writes a component list back to exactly those bytes. Nothing in an
// existing world is rewritten (RFC: updates are offered, never applied);
// tools/components-corpus-test.ts proves the round trip on every local world.
//
// Pure: no DOM, no three, no I/O. Server, browser, mcpl and tests import it.

// ------------------------------------------------------------ canonical bytes
// RFC 8785 (JCS) for the JSON this module produces: object keys sorted by UTF-16
// code units, no whitespace, numbers in ECMAScript's shortest round-trip form
// (which JSON.stringify already emits), strings JSON-escaped. Non-finite numbers
// and undefined are refused, as JCS requires.
export function canon(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canon: non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  throw new Error(`canon: unsupported ${typeof v}`);
}

// SHA-256, synchronous and dependency-free so a record's hash is the same
// function in bun, the browser and the agent (crypto.subtle is async).
const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
export function sha256hex(str) {
  const bytes = new TextEncoder().encode(str);
  const n = ((bytes.length + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n); m.set(bytes); m[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(n - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------ the records
// Param types: num (unit, min, max, softMax, deg), bool, vec3, color, text,
// asset (a library path), ref (another entity's id), choice (a closed set that
// IS a set — a particle preset, a loop mode — not a type switch), list, json.
// `default` is the value the engine's realizer applies when the key is absent;
// where today's code applies two different defaults by scope, the record says
// both (`partDefault`) rather than pretending there is one (docs/COMPONENTS-TODAY.md §3).
const deg = { t: 'num', deg: true, step: 5 };
const axis = (d) => ({ t: 'choice', options: ['x', 'y', 'z', '-x', '-y', '-z'], default: d, custom: 'vec3' });
const part = { t: 'text', default: null, hint: 'a named node of the model; empty = the whole thing' };

const DEFS = [
  { name: 'Transform', category: 'Core', builtin: true, summary: 'where it is: position, heading, size',
    params: { pos: { t: 'vec3', unit: 'm', default: [0, 0, 0] }, q: { t: 'quat', default: [0, 0, 0, 1], hint: 'full orientation (shared/rot.js); yaw is its friendly subset' }, yaw: { ...deg, default: 0 }, scale: { t: 'num', default: 1, min: 0.01, softMax: 12, step: 0.05 } },
    fallback: { text: 'at (x, y, z)' } },
  { name: 'Model', category: 'Rendering', summary: 'a 3D model from the library',
    params: { lib: { t: 'asset', default: null, required: true } },
    fallback: { visual: 'placeholder box until the model loads', text: 'a <file stem>' } },
  { name: 'Collider', category: 'Physics', needs: ['Model'], summary: 'how bodies bump into it',
    params: { shape: { t: 'choice', options: ['exact', 'box'], default: 'exact' } },
    fallback: { text: '(none)' }, note: 'browser-only today: the agent never sees it (COMPONENTS-TODAY: Model scars)' },
  { name: 'Light', category: 'Rendering', summary: 'a point light',
    params: { color: { t: 'color', default: 0xffd9a0 }, intensity: { t: 'num', default: 16, min: 0, softMax: 64, step: 1 }, range: { t: 'num', unit: 'm', default: 10, min: 1, softMax: 40, step: 1 },
      keep: { t: 'bool', default: false, hint: 'first claim on a light slot, never shed by the governor' }, burnsAtNoon: { t: 'bool', default: false, hint: 'opts out of the day cycle (wire: day:false)' } },
    fallback: { visual: 'a glowing gizmo when the slot pool is spent', text: '(light)' } },
  { name: 'Pendulum', category: 'Motion', summary: 'swings back and forth about an axis',
    params: { part, axis: axis('x'), amp: { ...deg, default: 0, min: 0 }, period: { t: 'num', unit: 's', default: 3.5, min: 0.05, step: 0.1 }, pivot: { t: 'vec3', unit: 'm', default: [0, 2, 0], partDefault: [0, 0, 0], hint: 'the point it swings about, in its own frame' }, phase: { ...deg, default: 0 }, damp: { t: 'num', default: 0, min: 0, softMax: 2, step: 0.01 }, maxAmp: { t: 'num', default: 1.1, hint: 'cap on a push (server reaction only), radians' } },
    fallback: { visual: 'stands still', text: 'in motion (pendulum)' } },
  { name: 'Spin', category: 'Motion', summary: 'turns steadily about an axis',
    params: { part, axis: axis('y'), rate: { t: 'num', unit: '°/s', default: 36, step: 5 }, pivot: { t: 'vec3', unit: 'm', default: [0, 0, 0] }, phase: { ...deg, default: 0 } },
    fallback: { visual: 'stands still', text: 'in motion (spin)' } },
  { name: 'Orbit', category: 'Motion', summary: 'circles a point',
    params: { part, radius: { t: 'num', unit: 'm', default: 3, partDefault: 1, min: 0, step: 0.1 }, center: { t: 'vec3', unit: 'm', default: null, hint: 'what it circles; absent = where it stands' }, rate: { t: 'num', unit: '°/s', default: 12, step: 5 }, phase: { ...deg, default: 0 }, face: { t: 'bool', default: true, hint: 'face along the circle' } },
    fallback: { visual: 'stands still', text: 'in motion (orbit)' } },
  { name: 'Bob', category: 'Motion', summary: 'floats up and down',
    params: { part, axis: axis('y'), amp: { t: 'num', unit: 'm', default: 0.3, min: 0, step: 0.05 }, period: { t: 'num', unit: 's', default: 4, min: 0.05, step: 0.1 }, phase: { ...deg, default: 0 } },
    fallback: { visual: 'stands still', text: 'in motion (bob)' } },
  { name: 'Path', category: 'Motion', summary: 'follows a list of points',
    params: { part, points: { t: 'list', of: 'vec3', default: [] }, speed: { t: 'num', unit: 'm/s', default: 1, min: 0 }, duration: { t: 'num', unit: 's', default: null, hint: 'instead of speed' },
      loop: { t: 'choice', options: ['loop', 'pingpong', 'once'], default: 'loop' }, face: { t: 'bool', default: true } },
    fallback: { visual: 'stands still', text: 'in motion (path)' } },
  { name: 'Seats', category: 'Interaction', needs: ['Model'], summary: 'places to sit or mount things',
    params: { slots: { t: 'list', of: 'seat', default: {}, hint: 'slot → {pos, yaw?, pose?, part?}' } },
    seat: { bodyDefault: [0, 0.5, 0], cargoDefault: [0, 0, 0], pose: 'sitchair' }, fallback: { text: 'sit/mount: <slots>' } },
  { name: 'Attachment', category: 'Interaction', summary: 'rides on another entity (wire: parent, written by mount)',
    params: { to: { t: 'ref', default: null, required: true }, slot: { t: 'text', default: null }, offset: { t: 'vec3', default: null }, yaw: { ...deg, default: null } },
    fallback: { text: 'on <to>' } },
  { name: 'Reactions', category: 'Interaction', summary: 'what a `use` does (today: a pendulum push)',
    params: { actions: { t: 'json', default: {} } }, fallback: { text: 'reacts to: <actions>' } },
  { name: 'Particles', category: 'Effects', summary: 'fire, smoke, sparks…',
    params: { preset: { t: 'choice', options: ['fire', 'sparks', 'embers', 'smoke', 'dust', 'snow', 'magic', 'stars', 'muzzle'], default: null, required: true },
      seed: { t: 'num', default: null, hint: 'from the id when absent' }, origin: { t: 'vec3', unit: 'm', default: [0, 0, 0], min: -8, max: 8 },
      count: { t: 'num', default: null, presetDefault: true, min: 1, max: 600 }, size: { t: 'num', default: null, presetDefault: true, min: 0.005 },
      opacity: { t: 'num', default: null, presetDefault: true, min: 0, max: 1 }, speed: { t: 'num', default: null, presetDefault: true, min: 0.05 },
      lifetime: { t: 'num', unit: 's', default: null, presetDefault: true, max: 30 }, area: { t: 'json', default: null }, texture: { t: 'asset', default: null },
      quality: { t: 'choice', options: ['auto', 'high', 'med', 'low'], default: 'auto' } },
    fallback: { visual: 'an unknown preset draws nothing', text: 'described by preset' } },
  { name: 'Picture', category: 'Rendering', needs: ['Model'], summary: 'an image on a named part',
    params: { src: { t: 'asset', default: null, required: true }, part: { t: 'text', default: null, required: true }, description: { t: 'text', default: null, wire: 'look' },
      lit: { t: 'choice', options: ['scene', 'self'], default: 'scene' }, flip: { t: 'bool', default: false } },
    fallback: { visual: 'nothing hung', text: 'not shown: <why>' } },
  { name: 'Sound', category: 'Audio', summary: 'positional audio',
    params: { src: { t: 'asset', default: null, required: true }, playing: { t: 'bool', default: true }, loop: { t: 'bool', default: true }, volume: { t: 'num', default: 0.8, min: 0, max: 1 },
      radius: { t: 'num', unit: 'm', default: 12, min: 1, max: 200, hint: 'where the falloff stops, not where it goes silent' }, t0: { t: 'num', default: null, hint: 'shared playhead start (stamped by play)' },
      description: { t: 'text', default: null, wire: 'look' } },
    fallback: { visual: 'silent', text: 'not heard: <why>' } },
  { name: 'Structure', category: 'Building', summary: 'walls, floors, doors and windows on a grid',
    params: { plan: { t: 'json', default: { levels: [] } } },
    fallback: { visual: 'the anchor crate', text: 'a building' }, note: 'rides a hidden anchor model today; ignores motion, mount and hidden' },
  { name: 'LookAt', category: 'Interaction', summary: 'faces another entity (no realizer yet)',
    params: { target: { t: 'ref', default: null } }, fallback: { text: 'components: look' } },
  { name: 'Lock', category: 'Rules', summary: 'nailed down: nobody can move, replace or remove it', params: {}, fallback: { text: '🔒 locked' } },
  { name: 'Guard', category: 'Rules', summary: 'only its placer, the owner or an operator may author it', params: {}, fallback: { text: '🛡 guarded by <placer>' } },
  { name: 'Hidden', category: 'Rendering', summary: 'not drawn, still there', params: {}, fallback: { text: '(hidden)' } },
  { name: 'Label', category: 'Core', summary: 'a display name people see', params: { text: { t: 'text', default: '', max: 80 } }, fallback: { text: 'the label' } },
  { name: 'Captions', category: 'Media', readOnly: true, summary: 'live captions (written by the caption verb)', params: { feed: { t: 'json', default: null } }, fallback: { text: 'captions' } },
  { name: 'Stage', category: 'Media', summary: 'who is speaking (captionbot)', params: { speaker: { t: 'text', default: null } }, fallback: { text: 'components: stage' } },
  { name: 'Annotation', category: 'Data', summary: 'any other data a world invents (recipe, notice, story…)',
    params: { type: { t: 'text', default: null, required: true }, data: { t: 'json', default: null } }, fallback: { text: 'components: <type>' } },
];

function freeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }
export const RECORDS = freeze(Object.fromEntries(DEFS.map((d) => {
  const rec = { kind: 'eido.component', v: 1, rung: 'engine', ...d };
  return [d.name, { ...rec, hash: sha256hex(canon(rec)) }];
})));
export const CATEGORIES = [...new Set(DEFS.map((d) => d.category))];
export const recordFor = (name) => RECORDS[name] ?? null;

// ------------------------------------------------------------ aliases: old spelling ⇄ components
const MOTION = { pendulum: 'Pendulum', spin: 'Spin', orbit: 'Orbit', bob: 'Bob', path: 'Path' };
const MOTION_TYPE = Object.fromEntries(Object.entries(MOTION).map(([k, v]) => [v, k]));
// keys a motion bag may carry that are not parameters: who/when stamps the
// fold or a reaction wrote. Kept so the round trip is byte-exact.
const MOTION_STAMPS = ['t0', 'cause', 'by'];
// keys of the record that are not components: who/when the sequencer stamped
const STAMPS = ['placer', 'born', 'actor', 'ts', 'box'];
const FLAG = { lock: 'Lock', guard: 'Guard' };

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Read a folded entity (shared/fold.js) as { components, stamps }.
 *  Every key of the record lands in exactly one place: a component instance
 *  (`{ type, key?, params, extra? }`, `key` = the comp-bag key it came from),
 *  or `stamps`. `extra` holds a bag's keys the record has no parameter for, so
 *  nothing is dropped; tools/components-corpus-test.ts counts them. */
export function componentsOf(ent) {
  if (!ent || typeof ent !== 'object') return { components: [], stamps: {} };
  const out = [];
  const tf = pick(ent, ['pos', 'q', 'yaw', 'scale']);
  out.push({ type: 'Transform', params: tf });
  if (ent.kind === 'light') {
    const p = pick(ent, ['color', 'intensity', 'range']);
    if (ent.keep !== undefined) p.keep = ent.keep;
    if (ent.day === false) p.burnsAtNoon = true;
    // the fold stores `day` only as false; any other stored value is kept as-is
    out.push({ type: 'Light', params: p, ...(ent.day !== undefined && ent.day !== false ? { wire: { day: ent.day } } : {}) });
  }
  if (ent.lib !== undefined) out.push({ type: 'Model', params: { lib: ent.lib } });
  if (ent.collide !== undefined) out.push({ type: 'Collider', params: { shape: ent.collide } });
  if (ent.parent !== undefined) out.push({ type: 'Attachment', params: { ...ent.parent } });
  const c = ent.comp ?? {};
  for (const key of Object.keys(c)) {
    const data = c[key];
    if (key in FLAG) { out.push({ type: FLAG[key], key, params: {}, wire: { value: data } }); continue; }
    if (key === 'hidden') { out.push({ type: 'Hidden', key, params: {}, wire: { value: data } }); continue; }
    if (key === 'label') { out.push({ type: 'Label', key, params: { text: data } }); continue; }
    if ((key === 'motion' || key.startsWith('motion:')) && data && typeof data === 'object' && MOTION[data.type]) {
      const type = MOTION[data.type];
      const known = Object.keys(RECORDS[type].params);
      const params = {}; const extra = {};
      for (const [k, v] of Object.entries(data)) {
        if (k === 'type') continue;
        if (known.includes(k)) params[k] = v;
        else if (type === 'Spin' && (k === 'degPerSec' || k === 'rpm')) { params.rate = v; (extra.rateKey ??= k); }
        else if (type === 'Orbit' && k === 'degPerSec') { params.rate = v; extra.rateKey = k; }
        else if ((type === 'Pendulum' || type === 'Bob') && k === 'amplitude') { params.amp = v; extra.ampKey = k; }
        else if (MOTION_STAMPS.includes(k)) (extra.stamps ??= {})[k] = v;
        else (extra.unknown ??= {})[k] = v;
      }
      const inst = { type, key, params };
      if (Object.keys(extra).length) inst.extra = extra;
      out.push(inst);
      continue;
    }
    const simple = { sockets: ['Seats', 'slots'], reactions: ['Reactions', 'actions'], structure: ['Structure', 'plan'], captions: ['Captions', 'feed'] };
    if (simple[key]) { out.push({ type: simple[key][0], key, params: { [simple[key][1]]: data } }); continue; }
    if (key === 'look' && data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).every((k) => k === 'target')) { out.push({ type: 'LookAt', key, params: { ...data } }); continue; }
    if (key === 'stage' && data && typeof data === 'object' && !Array.isArray(data)) { out.push({ type: 'Stage', key, params: { ...data } }); continue; }
    if ((key === 'particles' || key === 'picture' || key === 'sound') && data && typeof data === 'object' && !Array.isArray(data)) {
      const type = { particles: 'Particles', picture: 'Picture', sound: 'Sound' }[key];
      const rec = RECORDS[type];
      const params = {}; const extra = {};
      for (const [k, v] of Object.entries(data)) {
        const pk = Object.entries(rec.params).find(([name, s]) => (s.wire ?? name) === k)?.[0];
        if (pk) params[pk] = v; else (extra.unknown ??= {})[k] = v;
      }
      out.push({ type, key, params, ...(Object.keys(extra).length ? { extra } : {}) });
      continue;
    }
    out.push({ type: 'Annotation', key, params: { type: key, data } });
  }
  return { components: out, stamps: pick(ent, STAMPS) };
}

/** Write a component list back in today's spelling. The inverse of
 *  componentsOf: entityOf(componentsOf(e)) deep-equals e for every entity the
 *  corpus holds. Key order follows the fold's own order so canon() agrees. */
export function entityOf({ components, stamps = {} }) {
  const ent = {};
  const comp = {};
  for (const inst of components) {
    const p = inst.params ?? {};
    switch (inst.type) {
      case 'Transform': Object.assign(ent, p); break;
      case 'Light': {
        ent.kind = 'light';
        Object.assign(ent, pick(p, ['color', 'intensity', 'range']));
        if (p.keep !== undefined) ent.keep = p.keep;
        if (p.burnsAtNoon === true) ent.day = false;
        else if (inst.wire?.day !== undefined) ent.day = inst.wire.day;
        break;
      }
      case 'Model': ent.lib = p.lib; break;
      case 'Collider': ent.collide = p.shape; break;
      case 'Attachment': ent.parent = { ...p }; break;
      case 'Lock': case 'Guard': case 'Hidden': comp[inst.key] = inst.wire?.value ?? true; break;
      case 'Label': comp[inst.key ?? 'label'] = p.text; break;
      case 'Pendulum': case 'Spin': case 'Orbit': case 'Bob': case 'Path': {
        const x = inst.extra ?? {};
        const bag = { type: MOTION_TYPE[inst.type] };
        for (const [k, v] of Object.entries(p)) {
          if (k === 'rate') bag[x.rateKey ?? 'degPerSec'] = v;
          else if (k === 'amp' && x.ampKey) bag[x.ampKey] = v;
          else bag[k] = v;
        }
        Object.assign(bag, x.stamps ?? {}, x.unknown ?? {});
        comp[inst.key ?? 'motion'] = bag;
        break;
      }
      case 'Seats': comp[inst.key ?? 'sockets'] = p.slots; break;
      case 'Reactions': comp[inst.key ?? 'reactions'] = p.actions; break;
      case 'Structure': comp[inst.key ?? 'structure'] = p.plan; break;
      case 'Captions': comp[inst.key ?? 'captions'] = p.feed; break;
      case 'LookAt': comp[inst.key ?? 'look'] = { ...p }; break;
      case 'Stage': comp[inst.key ?? 'stage'] = { ...p }; break;
      case 'Particles': case 'Picture': case 'Sound': {
        const rec = RECORDS[inst.type]; const bag = {};
        for (const [k, v] of Object.entries(p)) bag[rec.params[k]?.wire ?? k] = v;
        Object.assign(bag, inst.extra?.unknown ?? {});
        comp[inst.key ?? inst.type.toLowerCase()] = bag;
        break;
      }
      case 'Annotation': comp[inst.key ?? p.type] = p.data; break;
      default: throw new Error(`entityOf: no alias for ${inst.type}`);
    }
  }
  if (Object.keys(comp).length) ent.comp = comp;
  return { ...ent, ...stamps };
}

/** Canonical-JSON equality with key order ignored (the corpus test's oracle). */
export const sameRecord = (a, b) => canon(a) === canon(b);

/** The library, grouped for an "Add Component" menu: what may be added to
 *  this entity now (needs met, not already present unless repeatable). */
const REPEATABLE = new Set(['Pendulum', 'Spin', 'Orbit', 'Bob', 'Path', 'Annotation']);
export function addable(components) {
  const have = new Set(components.map((c) => c.type));
  return DEFS.filter((d) => !d.builtin && !d.readOnly && (REPEATABLE.has(d.name) || !have.has(d.name))
    && (d.needs ?? []).every((n) => have.has(n))).map((d) => ({ name: d.name, category: d.category, summary: d.summary, hash: RECORDS[d.name].hash }));
}

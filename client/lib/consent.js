// Consent over my body — who may pose it, who may shove it. Deliberately a
// leaf with ZERO lib imports: consent is consulted from the puppet path, the
// drag path, and the command surface, and a yes/no question should not drag
// anyone's module graph along to get answered. localStorage-backed so a
// choice survives the session it was made in.

// Being posed by someone else.
//
// A puppet is an input to MY body, applied by MY client — never a pose forced
// on me from outside. So it goes through the same presence path as my own
// movement: a pose becomes my held pose (and broadcasts), an animation I play
// and re-send as mine. Humans opt in (a director staging a scene is welcome; a
// stranger yanking your limbs is not); agents accept by default, since being
// directed is the point of a performer.
let _posable = localStorage.getItem('ew-posable') === '1';
export function posable() { return _posable; }
export function setPosable(v) { _posable = v; localStorage.setItem('ew-posable', v ? '1' : '0'); changed(); }

// Being SHOVED is a separate consent from being POSED. Posing is directorial —
// someone else deciding what your body expresses — and stays opt-in. A shove
// is the world's rough-and-tumble: it moves you without speaking for you, so
// it defaults ON (the first one tells you how to refuse). Both are still only
// requests: my client applies them to my body, or doesn't.
let _pushable = localStorage.getItem('ew-pushable') !== '0';
export function pushable() { return _pushable; }
export function setPushable(v) { _pushable = v; localStorage.setItem('ew-pushable', v ? '1' : '0'); changed(); }

// The same two answers, as the authority's consent table (PROTOCOL L6, shared/protocol/consent.js) — the server checks it
// before it forwards a stranger's knock-over, pose or grab (security pass 3; a body that never sends one is Normal,
// where strangers' shove, pose and move are nobody). localbody.js sends it on every arrival and whenever it changes.
// Pushable covers being shoved and being dragged (bodydrag asks the same switch); posable covers being posed.
export function bodyTable() {
  const push = _pushable ? 'everyone' : 'nobody', pose = _posable ? 'everyone' : 'nobody';
  return [['shove', push], ['move', push], ['pose', pose]];
}
const listeners = new Set();
export function onConsentChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch { /* a listener's trouble is its own */ } } }

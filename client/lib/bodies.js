// bodies — choose what you wear, declared ONCE as fields and rendered twice:
// a section of the profile frame (renderDOM) and part of the profile quad, both dispatching
// into the same switchAvatar the palette's cards call. live: "the
// exact same panels in Desktop mode — hopefully we only need to maintain
// ONE set of menus"; and 22:57: a body is never optional — this is the
// in-headset way to pick one when the default is not what you want.
import { bus, wornNameOf } from './base.js';
import { net } from './net.js';
import { renderDOM } from './panels.js';
import { switchAvatar } from './palette.js';
import { getMyAvatarName, getMe, myBodyPrefs, setMyBodyPref } from './mybody.js';
import { BODY_SCALE_MIN, BODY_SCALE_MAX, PLATE_Y_MIN, PLATE_Y_MAX } from './bodyscale.js';

// MY avatars = the bodies you have actually worn (live, 09-05: the world offers a
// wardrobe to try on — World›avatar — and only what you've worn is yours).
// Kept per browser (ew-worn) until the server grows a per-person field; the
// roster is consulted only to resolve a name to its path.
const WORN_LS = 'ew-worn';
let worn = [];
try { worn = JSON.parse(localStorage.getItem(WORN_LS) || '[]'); } catch { worn = []; }
if (!Array.isArray(worn)) worn = [];
function noteWorn(v) {
  const name = wornNameOf(v);   // mybody.announceWorn emits { name, path }
  if (!name) return;
  worn = [name, ...worn.filter((n) => n !== name)].slice(0, 24);   // newest first
  try { localStorage.setItem(WORN_LS, JSON.stringify(worn)); } catch { /* private mode */ }
}
bus.on('avatar-worn', noteWorn);

function fields() {
  const cur = getMyAvatarName();
  const roster = net.avatars ?? [];
  const mine = worn.filter((n) => roster.some((a) => a.name === n) || n === cur);
  return [
    // None, not '—', and only when a body is actually in the scene: `cur` is
    // the name we INTEND to wear and survives a failed load, which is how this
    // row and the list below it came to contradict each other. (R, 2026-09-11)
    { t: 'info', label: 'wearing', value: getMe()?.isCapsule ? 'the capsule (no body would load)' : getMe() ? (cur ?? 'None') : 'None' },
    ...thisBodyFields(),   // the worn body's own size and nameplate, right under its name
    { t: 'list', label: 'my avatars', empty: 'nothing worn yet — try one from World › avatar',
      rows: mine.map((n) => {
        const a = roster.find((x) => x.name === n);
        // `cur` is INTENT and survives a failed load, so gating the wear action
        // on it left the body that just failed marked active with no way to
        // retry — the one body a first-time user owns (#196 review B1). When
        // the capsule is worn nothing is active and everything is wearable.
        const onMe = n === cur && !!getMe() && !getMe()?.isCapsule;
        return { id: n, label: n, sub: a?.height ? `${a.height.toFixed(2)} m` : undefined, active: onMe,
          actions: onMe ? [] : [{ k: 'wear', label: 'wear' }] };
      }) },
  ];
}
// THIS BODY (R, 2026-09-30): the worn body's own settings, first two of them — its SIZE and where its NAMEPLATE hangs.
// Fields, so the profile quad in VR gets the same controls (sliders on both renderers). Saved per body, per browser
// (bodyscale.js), and sent on the pose so everyone else sees the size and the plate where you put them.
const pct = (x) => Math.round(x * 100);
function thisBodyFields() {
  const me = getMe();
  if (!me || me.isCapsule) return [];
  const name = getMyAvatarName() ?? 'this body';
  const saved = myBodyPrefs(), p = { scale: me.userScale ?? saved.scale, plateY: me.plateY ?? saved.plateY };   // mid-drag the body is ahead of the store
  // the height a stranger would read off you: the roster's measured height, else the crown this client measured
  const base = (net.avatars ?? []).find((a) => a.name === name)?.height ?? me._plateRest?.height ?? null;
  const cm = Math.round(p.plateY * 100);
  return [
    { t: 'range', k: 'body-scale', label: 'size', value: pct(p.scale), min: pct(BODY_SCALE_MIN), max: pct(BODY_SCALE_MAX), step: 1, dp: 0, unit: '%' },
    { t: 'info', label: 'height', value: base ? `${(base * p.scale).toFixed(2)} m${p.scale !== 1 ? ` (${base.toFixed(2)} m at 100%)` : ''}` : `${pct(p.scale)}% of authored` },
    { t: 'range', k: 'plate-y', label: 'nameplate', value: cm, min: pct(PLATE_Y_MIN), max: pct(PLATE_Y_MAX), step: 1, dp: 0, unit: ' cm' },
    { t: 'info', label: 'plate', value: cm === 0 ? 'auto — over the measured crown' : `auto ${cm > 0 ? '+' : '−'}${Math.abs(cm)} cm${p.scale !== 1 ? ` (× ${pct(p.scale)}% size)` : ''}` },
    ...(p.scale !== 1 ? [{ t: 'btn', k: 'body-scale-reset', label: 'size: back to 100%' }] : []),
    ...(cm !== 0 ? [{ t: 'btn', k: 'plate-y-reset', label: 'nameplate: back to auto' }] : []),
  ];
}
// A drag fires `input` per pixel. The body follows every tick; the store (a JSON rewrite of every body's prefs) is
// written once the value has rested SAVE_MS, or at once on release (mountBodies' `change`). The VR quad has no release
// event of its own, so the rest timer is what saves there. The pending value carries the body it was dragged on: a
// switch inside the window must not file it under the next body.
const SAVE_MS = 250;
let pending = null, saveTimer = 0;
function flushBodyPrefs() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (pending) { const p = pending; pending = null; setMyBodyPref(p.patch, p.name); }
}
function liveBodyPref(patch) {
  const me = getMe(), name = getMyAvatarName();
  if (pending && pending.name !== name) flushBodyPrefs();
  if (patch.scale != null) me?.setUserScale?.(patch.scale);
  if (patch.plateY != null) me?.setPlateY?.(patch.plateY);
  pending = { name, patch: { ...pending?.patch, ...patch } };
  clearTimeout(saveTimer); saveTimer = setTimeout(flushBodyPrefs, SAVE_MS);
}
function bodyDispatch(k, v) {
  if (k === 'body-scale' && Number.isFinite(+v)) liveBodyPref({ scale: +v / 100 });
  else if (k === 'plate-y' && Number.isFinite(+v)) liveBodyPref({ plateY: +v / 100 });
  else if (k === 'body-scale-reset') { flushBodyPrefs(); setMyBodyPref({ scale: 1 }); }
  else if (k === 'plate-y-reset') { flushBodyPrefs(); setMyBodyPref({ plateY: 0 }); }
  else return false;
  bus.emit('xr:repaint');
  return true;
}

function dispatch(k, id) {
  if (bodyDispatch(k, id)) { if (/-reset$/.test(k)) repaintAll(); return; }   // a slider repaints on release (mountBodies), never mid-drag
  if (k !== 'wear' && k !== 'row') return;
  const a = (net.avatars ?? []).find((x) => x.name === id);
  if (a) switchAvatar(a.path, a.name);
}

// The bodies list lives INSIDE the profile (live, 09-05: reachable from
// profile, not its own menu). profile.js mounts it under the avatars tile
// and folds its fields into the profile quad.
const repaints = new Set();
const repaintAll = () => { for (const r of repaints) r(); };
export const bodiesFields = fields;
export const bodiesDispatch = dispatch;
export function mountBodies(host) {
  host.classList.add('schema-panel');
  const scroll = document.createElement('div');
  scroll.className = 'schema-scroll';
  host.append(scroll);
  const repaint = () => renderDOM(scroll, fields(), dispatch);
  repaint();
  repaints.add(repaint);
  bus.on('avatars', repaint);
  bus.on('avatar-worn', repaint);
  // a slider fires `input` all the way through a drag (applied live, no repaint — a rebuild would drop the thumb under
  // the pointer); `change` is the release, and that is when the height and plate readouts catch up
  host.addEventListener('change', (e) => { if (e.target?.classList?.contains('sp-range')) { flushBodyPrefs(); repaint(); } });
  return repaint;
}

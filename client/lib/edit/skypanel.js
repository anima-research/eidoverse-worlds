// skypanel — the sky section of the world panel. Everything here PREVIEWS; only the commit button writes to the world
// (every log entry replays for every future joiner; trying things out shouldn't).

import { sendOps } from './writes.js';
import { bus, report } from '../base.js';
import { serverNow } from '../serverclock.js';   // a server stamp is read on the authority's clock
import { defsRegistry } from '../defs.js';
import { flashHint } from '../ui/ui.js';
import { selectRow } from './rows.js';
import { previewSky, skyArgs, skyImpl, WEATHERS, CLOUDS, SKY_QUALITY, skyQuality, setSkyQuality,
  CLOUD_QUALITY, getCloudChoice, setCloudQuality, cloudCap, skyInXR } from '../sky/sky.js';
import { GRASS_QUALITY, getGrassQuality, setGrassQuality,
  getGrassDensity, getGrassShed, getGrassApplied } from '../terrain.js';
import { MODEL_QUALITY } from '../lod_policy.js';
import { loggedSky, skyPreviewing, skyRendering, skyDegraded, getCloudQuality } from '../sky/sky.js';
import { effectiveClock } from '../../../shared/forecast.js';
import { stateLines } from '../ui/statelines.js';
import { modelQuality, dialModelQuality } from '../realize/models.js';

const SLIDERS = [
  ['hours', 'time', 0, 24, 0.1, 12],
  ['rate', 'rate', 0, 48, 0.5, 0],
  ['azimuth', 'azim', 0, 360, 5, 180],   // shown in degrees, stored in radians
  ['sun', 'sun', 0, 2.5, 0.05, 1],
  ['ambient', 'ambnt', 0, 2.5, 0.05, 1],
  ['fill', 'fill', 0, 2.5, 0.05, 1],
  ['exposure', 'expos', 0.3, 1.8, 0.05, 1],
  ['fog', 'fog', 0, 3, 0.05, 1],
];
// Presets (defs/sky/_presets.json) are authoring conveniences: they fill the sliders and preview; commit writes concrete
// args, so the log never stores a preset name.

export function paintSky(body) {
  if (body.dataset.init) { body._sync?.(); body._readState?.(); return; }
  body.dataset.init = '1';
  body.innerHTML = '';
  const inputs = {};
  const commit = document.createElement('button');

  // what the log says, and what you're seeing instead (only while those differ)
  const lines = stateLines();
  lines.el.classList.add('sky-state');
  body.appendChild(lines.el);
  let lastLogged = null;
  const readState = () => {
    const L = loggedSky();
    if (!L) { lines.set('no sky logged yet', skyRendering() ? 'loading…' : null); return; }
    const a = L.args;
    if (L !== lastLogged) {
      // someone (maybe you) logged a sky: follow it, unless you're mid-edit
      const first = lastLogged === null;
      lastLogged = L;
      if (!first && !commit.classList.contains('dirty')) body._sync?.();
    }
    const parts = [];
    if (a.system === 'skymesh') parts.push('basic sky');
    // what actually drives the sun: no tz follows Los Angeles, and a tz that doesn't resolve leaves the parked clock
    const ec = effectiveClock({ ...a, ts: L.t0 }, serverNow());
    if (ec.mode === 'real') parts.push(`real clock (${ec.tz})`);
    else {
      const h = ((ec.hour % 24) + 24) % 24;
      parts.push(`${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`
        + `${ec.mode === 'rated' ? ' (running)' : ''}${ec.requestedTz ? ` (tz ${ec.requestedTz} not recognised)` : ''}`);
    }
    if (a.weather) parts.push(a.weather);
    // the detailed sky builds cumulus for a log with no (or an unknown) clouds value (sky.js makeSky), so say that
    const basic = a.system === 'skymesh';
    const clouds = basic ? a.clouds : (CLOUDS.includes(a.clouds) ? a.clouds : 'cumulus');
    if (clouds) parts.push(`clouds ${clouds}`);
    if (a.world && a.world !== 'earth') parts.push(a.world);
    const you = [];
    if (skyRendering()) you.push('loading…');
    if (skyPreviewing()) you.push('previewing (not logged)');
    // Unsaved edits and no preview: a log landed on top of it (applySky ends a preview). Said, not re-previewed: that
    // would hide the sky someone just shared the moment it arrived. Touching any control previews the edits again.
    else if (commit.classList.contains('dirty')) you.push("your unsaved edits aren't shown — a new sky was logged");
    if (!basic && getCloudQuality() === 'off' && clouds !== 'clear') you.push('no clouds (your clouds⚙ is off)');
    if (skyDegraded() && a.system !== 'skymesh') you.push("the basic sky (this GPU can't run the full one)");
    lines.set(parts.join(' · '), you.join(' · '));
  };
  bus.on('sky-state', readState);
  bus.on('sky-degraded', readState);
  // the sun moves. The body stays connected when the panel closes (the frame and its tab only hide it), so ask for a
  // rendered box: a closed panel's clock line costs nothing, and reopening the tab reads it at once (top of paintSky)
  setInterval(() => { if (body.getClientRects().length) readState(); }, 30000);
  body._readState = readState;

  const local = {};
  const preview = (patch) => {
    Object.assign(local, patch);
    previewSky({ ...gather() }).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };

  const gather = () => {
    // `local` carries the NON-slider knobs (clouds/weather/world/colors). The
    // sliders must WIN over local (a preset's stale local.hours would shadow
    // the time slider): apply local first, then let the sliders assert.
    const a = { ...skyArgs(), ...local };
    for (const [key, , , , , dflt] of SLIDERS) {
      const v = Number(inputs[key].value);
      if (key === 'hours' || key === 'azimuth' || v !== dflt) a[key] = key === 'azimuth' ? v * Math.PI / 180 : v;
    }
    delete a.world;   // never stored
    return a;
  };

  const mkRow = (label, node) => {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = label;
    row.append(nm, node);
    return row;
  };

  // presets — populated from the def registry, repopulated on a defs push
  const presetWrap = document.createElement('div');
  presetWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-bottom:4px;';
  const fillPresets = () => defsRegistry().then((reg) => {
    presetWrap.innerHTML = '';
    for (const [name, vals] of Object.entries(reg.skyPresets ?? {})) {
      const b = document.createElement('button');
      b.textContent = name;
      b.style.flex = '1 0 auto';
      b.onclick = () => {
        if (vals.hours != null) inputs.hours.value = vals.hours;
        if (vals.clouds) cl.value = vals.clouds;
        inputs.hours.dispatchEvent(new Event('input'));   // previews via the slider path
        preview({ ...vals });
      };
      presetWrap.appendChild(b);
    }
  }).catch((e) => report('sky presets', e));
  fillPresets();
  bus.on('defs-updated', fillPresets);
  body.appendChild(presetWrap);

  // weather — a first-class verb, not a slider
  const { row: wxRow, select: wx } = selectRow('wx', WEATHERS, null,
    (v) => preview({ weather: v, transition: 12 }));
  body.appendChild(wxRow);

  const { row: clRow, select: cl } = selectRow('cloud', CLOUDS, 'cumulus',
    (v) => preview({ clouds: v }));
  body.appendChild(clRow);

  // the sky system: the detailed sky, or the basic one a weak GPU can draw; world data, committed with ✓
  const { row: syRow, select: sy } = selectRow('sky', [['eidoverse', 'detailed'], ['skymesh', 'basic']], 'eidoverse',
    (v) => preview({ system: v }));
  body.appendChild(syRow);
  // the cloud march's tier is yours (sky.js skyQuality): never sent, read at the next sky build
  const { row: sqRow, select: sq } = selectRow('detail⚙', SKY_QUALITY, skyQuality(), (v) => { setSkyQuality(v); flashHint(`sky detail ${v}: applies when the sky is next built (reload to see it now)`); });
  sqRow.title = 'local performance setting — not shared with the world'; void sq;
  body.appendChild(sqRow);

  // the cloud budget is YOURS, never a verb (the march's cost is per fragment)
  const { row: cqRow, select: cq } = selectRow('clouds⚙', CLOUD_QUALITY, getCloudChoice(),
    (v) => { setCloudQuality(v); flashHint(`clouds: ${v} (yours only). The first time a setting is used, your GPU may pause a few seconds to compile it`); });
  cqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(cqRow);
  // In a headset 'high' (the live march) is unavailable: greyed, and when it's YOUR choice, a note says what runs instead
  // and why. Shown only in VR; it goes away at exit.
  const cqNote = document.createElement('div');
  cqNote.className = 'cloud-cap-note';
  cqNote.style.cssText = 'font-size:10px;color:var(--dim);padding:0 2px 4px;line-height:1.35';
  cqNote.hidden = true;
  body.appendChild(cqNote);
  let inXR = skyInXR();   // the panel may first paint mid-session
  const syncCap = () => {
    const live = [...cq.options].find((o) => o.value === 'high');
    if (live && live.disabled !== inXR) live.disabled = inXR;
    const cap = cloudCap();
    const text = inXR && cap ? `In VR your clouds run at medium (baked). High clouds march every pixel for each eye, which halves a headset's frame rate; your high setting comes back when you leave VR.` : '';
    if (cqNote.textContent !== text) cqNote.textContent = text;
    if (cqNote.hidden !== !text) cqNote.hidden = !text;
    cq.value = getCloudChoice();
  };
  bus.on('xr:state', (on) => { inXR = !!on; syncCap(); });
  bus.on('cloud-cap', syncCap);
  syncCap();

  // the grass budget is likewise YOURS: a persisted cap on how much of the field this machine draws; the auto governor
  // may thin below the cap under load, never above it
  const { row: gqRow, select: gq } = selectRow('grass⚙', GRASS_QUALITY, null, null);
  gq.setAttribute('aria-label', 'grass quality — local only, never shared with the world');
  // live dial state as visible text (screen readers too): the select is the cap, ⚙× the governor's dial, → what draws
  const gqState = document.createElement('span');
  // not `.v` (the sliders' fixed readout column would wrap it); the aria-live twin reads a whole sentence
  gqState.style.cssText = 'margin-left:auto; white-space:nowrap; color:var(--accent); font-size:10px;';
  gqState.setAttribute('aria-live', 'polite');
  const gqStateEye = document.createElement('span');
  gqStateEye.setAttribute('aria-hidden', 'true');
  const gqStateEar = document.createElement('span');
  gqStateEar.style.cssText = 'position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0);';
  gqState.append(gqStateEye, gqStateEar);
  gqRow.appendChild(gqState);
  const syncGrassRow = () => {
    gq.value = getGrassQuality();
    const shed = getGrassShed(), eff = getGrassDensity();
    const active = shed < 1 && gq.value !== 'off';
    // the same applied report code reads (getGrassApplied), so the row never claims a density the renderer didn't
    const rep = getGrassApplied();
    const bad = rep.field && rep.status !== 'applied';
    if (bad) {
      const names = rep.strokes.filter((s) => !s.ok).map((s) => s.stroke).join(', ');
      gqStateEye.textContent = `⚠${rep.status}`;
      gqStateEar.textContent = `grass cap ${gq.value} ${rep.status}` +
        (names ? `: stroke ${names} has no working density dial` : '');
      gqRow.title = `your cap asked for ×${eff} but the renderer did not fully apply it` +
        ` (${rep.status}${names ? `: ${names}` : ''}) — affected strokes draw at their built density`;
      return;
    }
    gqStateEye.textContent = active ? `⚙${shed}→${eff}` : '';
    gqStateEar.textContent = active ? `auto governor dial ${shed}, drawing ${eff}` : '';
    gqRow.title = active
      ? `your cap: ${gq.value} — the auto governor's session dial is ×${shed}; the field draws the lower of the two`
      : 'local performance setting — not shared with the world';
  };
  gq.onchange = () => {
    setGrassQuality(gq.value);
    syncGrassRow();
    flashHint(`grass: ${gq.value} (yours only)`);
  };
  syncGrassRow();
  bus.on('grass-budget', syncGrassRow);   // governor sheds repaint immediately
  body.appendChild(gqRow);

  // render scale lives in Settings › Video (videopanel.js) — a local performance dial, not a sky property

  // the model tier is YOURS too: which version of each object THIS machine fetches (realize/models.js dialModelQuality)
  const { row: mqRow, select: mq } = selectRow('models⚙',
    MODEL_QUALITY.map((v) => [v, v === 'auto' ? 'auto' : v === 'full' ? 'full detail' : 'eco (reduce sooner)']),
    modelQuality.quality,
    (v) => flashHint(dialModelQuality(v)));
  mq.setAttribute('aria-label', 'model detail tier — local only, never shared with the world');
  mqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(mqRow);

  // sliders only the BASIC sky answers (the detailed sky owns sun direction and fill): hidden there, not greyed
  const BASIC_ONLY = new Set(['azimuth', 'fill']);
  const basicRows = [];
  const syncBasicOnly = () => {
    const dead = skyImpl() === 'eidoverse';
    for (const { row, input } of basicRows) {
      if (input.disabled !== dead) input.disabled = dead;
      const d = dead ? 'none' : '';
      if (row.style.display !== d) row.style.display = d;   // style, not [hidden]: a .row display rule would beat the attribute
    }
  };

  for (const [key, label, min, max, step, dflt] of SLIDERS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = dflt;
    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = dflt;
    input.oninput = () => {
      val.textContent = input.value;
      previewSky(gather()).catch((e) => report('sky preview', e));
      commit.classList.add('dirty');
    };
    inputs[key] = input;
    const row = mkRow(label, input);
    row.appendChild(val);
    if (BASIC_ONLY.has(key)) basicRows.push({ row, input });
    body.appendChild(row);
  }
  syncBasicOnly();
  // follow the sky that's actually built, while the panel stays open: a logged system switch or the first sky arriving
  // changes skyImpl() after the repaint that last synced these rows
  bus.on('sky-ready', syncBasicOnly);
  bus.on('sky-state', syncBasicOnly);

  // a real clock: a `tz` makes the world's hour that timezone's wall hour (shared/forecast.js hoursAt) and the time
  // slider yields. Clearing stores undefined so the verb's JSON drops the key. Which clocks the row offers is a def
  // (defs/sky/_clocks.json, value = the IANA tz); the commit writes the tz itself.
  const { row: ckRow, select: ck } = selectRow('clock',
    [['', 'authored (slider)']], '', null);
  const fillClocks = () => defsRegistry().then((reg) => {
    const sa = skyArgs(); const want = typeof sa.tz === 'string' ? sa.tz : ck.value;   // a tz present is the wall clock
    ck.textContent = '';
    ck.appendChild(new Option('authored (slider)', ''));
    for (const c of Object.values(reg.skyClocks ?? {})) {
      if (c?.tz) ck.appendChild(new Option(c.label ?? c.tz, c.tz));
    }
    // a tz the def no longer lists still shows (as itself), never as "authored"
    if (want && ![...ck.options].some((o) => o.value === want)) {
      ck.appendChild(new Option(`real time — ${want}`, want));
    }
    ck.value = want;
  }).catch((e) => report('sky clocks', e));
  fillClocks();
  bus.on('defs-updated', fillClocks);
  // under a real clock time and rate do nothing: hidden, like the basic-only rows; presets still set the look, not the hour
  const syncClockUi = () => {
    // the clock the commit will SEND (gather), not what the select shows
    const g = gather(); const real = typeof g.tz === 'string' && g.tz !== '';
    for (const k of ['hours', 'rate']) {
      const input = inputs[k], row = input?.parentNode; if (!input || !row) continue;
      input.disabled = real;
      const d = real ? 'none' : '';
      if (row.style.display !== d) row.style.display = d;
    }
    presetWrap.title = real ? 'under a real clock the presets set the look, not the hour' : '';
  };
  ck.onchange = () => {
    if (ck.value !== '') local.tz = ck.value;
    else {
      local.tz = undefined;   // back to the authored clock: hours/rate stay where the sliders hold them
    }
    syncClockUi();
    previewSky(gather()).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };
  syncClockUi();
  ckRow.title = 'real time: the sun tracks the named city’s actual clock — noon is noon';
  body.appendChild(ckRow);

  commit.textContent = '✓ log to world';
  commit.title = 'share this sky with everyone, permanently';
  commit.onclick = () => {
    sendOps([{ verb: 'sky', args: gather() }], { what: 'the sky', expect: false });
    commit.classList.remove('dirty');
    commit.textContent = '✓ logged';
    setTimeout(() => { commit.textContent = '✓ log to world'; }, 1200);
  };
  body.appendChild(commit);

  body._sync = () => {
    // nothing unsaved: the log speaks for `local` now, so forget it (kept, it overrode later remote changes); with
    // edits pending it's the person's work: keep it
    if (!commit.classList.contains('dirty')) for (const k of Object.keys(local)) delete local[k];
    const a = skyArgs();
    for (const [key, , , , , dflt] of SLIDERS) {
      // under a real clock hours/rate stay stored: loaded (rows hidden) as what the world would return to
      inputs[key].value = key === 'azimuth' ? (typeof a.azimuth === 'number' ? +(a.azimuth * 180 / Math.PI).toFixed(1) : dflt) : (a[key] ?? dflt);
      inputs[key].parentNode.querySelector('.v').textContent = inputs[key].value;
    }
    if (a.weather) wx.value = a.weather;
    if (a.clouds) cl.value = a.clouds;
    sy.value = a.system === 'skymesh' ? 'skymesh' : 'eidoverse';
    // the option list is def-fed; fillClocks appends a raw-tz option when the
    // world's committed clock is one the def no longer lists
    const realTz = typeof a.tz === 'string' ? a.tz : '';   // a tz present is the wall clock
    ck.value = realTz;
    if (realTz && ck.value !== realTz) fillClocks();
    syncClockUi();
    syncBasicOnly();
    syncGrassRow();
  };
  body._sync();
  readState();
}

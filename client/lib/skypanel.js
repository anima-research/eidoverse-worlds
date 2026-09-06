// skypanel — the ☀ sky section of the world panel (split from build.js).
//
// Everything in this panel PREVIEWS. Only the commit button writes to the
// world.
//
// Presets and dropdowns used to send a verb on every click while the sliders
// only previewed — so idly exploring the sky wrote 53 permanent entries into
// one world's log, every one of which replays for every future joiner. The
// log is history; trying things out is not.

import { bus, report } from './base.js';
import { defsRegistry } from './defs.js';
import { sendVerb } from './net.js';
import { flashHint } from './ui.js';
import { selectRow } from './rows.js';
import { previewSky, skyArgs, skyImpl, WEATHERS, CLOUDS, SKY_WORLDS,
  CLOUD_QUALITY, getCloudQuality, setCloudQuality } from './sky.js';
import { GRASS_QUALITY, getGrassQuality, setGrassQuality,
  getGrassDensity, getGrassShed, getGrassApplied } from './terrain.js';
import { RENDER_SCALES, getRenderScale, setRenderScale } from './governor.js';
import { MODEL_QUALITY } from './lod_policy.js';
import { modelQuality, dialModelQuality } from './realize/models.js';

const SLIDERS = [
  ['hours', 'time', 0, 24, 0.1, 12],
  ['rate', 'rate', 0, 48, 0.5, 0],
  ['azimuth', 'azim', 0, 360, 5, 180],
  ['sun', 'sun', 0, 2.5, 0.05, 1],
  ['ambient', 'ambnt', 0, 2.5, 0.05, 1],
  ['fill', 'fill', 0, 2.5, 0.05, 1],
  ['exposure', 'expos', 0.3, 1.8, 0.05, 1],
  ['fog', 'fog', 0, 3, 0.05, 1],
];
// Named times beat eight raw sliders for the 95% case — you want "golden",
// not hours=17.4, exposure=0.86. The presets themselves are DATA now
// (§24, defs/sky/_presets.json) — authoring conveniences only: they fill
// the sliders and preview; commit writes concrete args, so the log never
// stores a preset name and logged meaning never depends on the def file.

export function paintSky(body) {
  if (body.dataset.init) { body._sync?.(); return; }
  body.dataset.init = '1';
  body.innerHTML = '';
  const inputs = {};
  const commit = document.createElement('button');

  const local = {};
  const preview = (patch) => {
    Object.assign(local, patch);
    previewSky({ ...gather() }).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };

  const gather = () => {
    // `local` carries the NON-slider knobs (clouds/weather/world/colors). The
    // sliders own their own keys and must WIN over local — otherwise a preset
    // that stashed a slider key (hours) into local would shadow the time slider
    // for the rest of the session: moving it wrote a.hours, but the stale
    // local.hours overrode it, so lighting stopped changing after you pressed
    // dusk (or any preset). Apply local first, then let the sliders assert.
    const a = { ...skyArgs(), ...local };
    for (const [key, , , , , dflt] of SLIDERS) {
      const v = Number(inputs[key].value);
      if (key === 'hours' || key === 'azimuth' || v !== dflt) a[key] = v;
    }
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
    (v) => preview({ weather: v, weatherSeconds: 12 }));
  body.appendChild(wxRow);

  const { row: clRow, select: cl } = selectRow('cloud', CLOUDS, 'cumulus',
    (v) => preview({ clouds: v }));
  body.appendChild(clRow);

  const { row: wlRow, select: wl } = selectRow('world', SKY_WORLDS, null,
    (v) => preview({ world: v }));
  body.appendChild(wlRow);

  // Cloud budget is YOURS, not the world's — it never becomes a verb. The
  // volumetric march is the most expensive thing the client draws and its cost
  // is per-fragment, so a big high-refresh display pays several times what a
  // small window does for the same sky.
  const { row: cqRow } = selectRow('clouds⚙', CLOUD_QUALITY, getCloudQuality(),
    (v) => { setCloudQuality(v); flashHint(`clouds: ${v} (yours only)`); });
  cqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(cqRow);

  // The meadow budget is likewise YOURS (#60) — a persisted cap on how much
  // of the field this machine draws. Species/seed/extent stay world state;
  // the auto governor may thin below the cap under load, never above it.
  const { row: gqRow, select: gq } = selectRow('grass⚙', GRASS_QUALITY, null, null);
  gq.setAttribute('aria-label', 'grass quality — local only, never shared with the world');
  // Live dial state as visible text, not a tooltip — the governor's shed is
  // state a keyboard or screen-reader user must be able to learn too. The
  // two dials stay attributed to their owners: the select is the RESIDENT's
  // cap, ⚙× is the GOVERNOR's own session dial, ×draws is what min() yields.
  const gqState = document.createElement('span');
  // NOT `.v` — that's the sliders' fixed 34px readout column; this text
  // would wrap inside it, reflowing the whole row. The visible half is
  // compact enough to fit the default 232px panel on one line (measured:
  // ≤62px available beside the select); the aria-live announcement reads a
  // whole sentence instead, via a visually-hidden twin.
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
    // Applied truth (#74): the same report the programmatic surface serves —
    // one source, so the row can never claim a density the renderer didn't.
    // A false cap outranks governor detail for the row's scarce pixels.
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

  // Render scale is YOURS too (§22k) — the whole frame's pixel budget, the
  // one lever a pixel-bound machine actually answers to (§22j's tables).
  // 'auto' lets the governor's cruise drive; a pinned % is the resident's
  // word and turns the cruise off. Persisted like the other two dials.
  const { row: rsRow, select: rs } = selectRow('scale⚙',
    RENDER_SCALES.map((v) => [v, v === 'auto' ? 'auto' : `${Math.round(v * 100)}%`]),
    getRenderScale(),
    (v) => {
      setRenderScale(v);
      flashHint(`render scale: ${v === 'auto' ? 'auto' : `${Math.round(v * 100)}%`} (yours only)`);
    });
  rs.setAttribute('aria-label', 'render scale — local only, never shared with the world');
  rsRow.title = 'local performance setting — not shared with the world';
  body.appendChild(rsRow);

  // The geometry tier is YOURS too (#156): which version of each placed
  // object THIS machine fetches. 'auto' reduces far objects, sooner under
  // GPU pressure; 'full' never reduces; 'eco' reduces sooner always (the
  // pressured band) — no dial reduces what you stand beside. Bodies are
  // never reduced (server contract). Persisted; never a verb.
  const { row: mqRow, select: mq } = selectRow('models⚙',
    MODEL_QUALITY.map((v) => [v, v === 'auto' ? 'auto' : v === 'full' ? 'full detail' : 'eco (reduce sooner)']),
    modelQuality.quality,
    // the whole behaviour lives in models.js (dialModelQuality: set, persist,
    // and say whether a reduced tier can be asked from this browser at all)
    // so the product-door harness gates it; this row only binds and shows
    (v) => flashHint(dialModelQuality(v)));
  mq.setAttribute('aria-label', 'model detail tier — local only, never shared with the world');
  mqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(mqRow);

  // Sliders that only the BASIC sky answers. On the real sky the engine owns
  // sun direction and supplies its own bounce fill (sky.js documents the
  // ownership boundary) — a slider that does nothing must say so, not sit
  // there lying. sun/ambient/fog work on BOTH paths now: fog density was
  // always ours, and sun/ambient ride as post-update multipliers (§12.6).
  const BASIC_ONLY = new Set(['azimuth', 'fill']);
  const basicRows = [];
  const syncBasicOnly = () => {
    const dead = skyImpl() === 'eidoverse';
    for (const { row, input } of basicRows) {
      input.disabled = dead;
      row.style.opacity = dead ? '.45' : '';
      row.title = dead ? 'the detailed sky drives this itself — basic sky only' : '';
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

  // The sun can follow a REAL clock: `clock: real` makes the world's hour BE
  // the named timezone's wall hour (DST included, hoursAt owns the formula)
  // and the time slider yields. World policy like everything else here — it
  // previews live and commits with ✓. Clearing stashes undefined so the JSON
  // the verb carries simply drops the keys (a null would linger in the fold).
  //
  // WHICH clocks the row offers is a def (defs/sky/_clocks.json, option value
  // = the IANA tz) — the commit still writes concrete clock/tz args, so the
  // log never stores a clock's def name. The one hardcoded LA entry this row
  // shipped with (survey §B4) lives there now.
  const { row: ckRow, select: ck } = selectRow('clock',
    [['', 'authored (slider)']], '', null);
  const fillClocks = () => defsRegistry().then((reg) => {
    const want = skyArgs().clock === 'real' ? (skyArgs().tz ?? '') : ck.value;
    ck.textContent = '';
    ck.appendChild(new Option('authored (slider)', ''));
    for (const c of Object.values(reg.skyClocks ?? {})) {
      if (c?.tz) ck.appendChild(new Option(c.label ?? c.tz, c.tz));
    }
    // a world already committed to a tz the def no longer lists: show the
    // truth (the raw tz) rather than silently displaying "authored"
    if (want && ![...ck.options].some((o) => o.value === want)) {
      ck.appendChild(new Option(`real time — ${want}`, want));
    }
    ck.value = want;
  }).catch((e) => report('sky clocks', e));
  fillClocks();
  bus.on('defs-updated', fillClocks);
  const syncClockUi = () => { inputs.hours.disabled = ck.value !== ''; };
  ck.onchange = () => {
    if (ck.value !== '') { local.clock = 'real'; local.tz = ck.value; }
    else {
      local.clock = undefined; local.tz = undefined;
      // returning to the authored clock: the fold parked the prior rated
      // fields under dormantRated (#65) — hand them back to the sliders so
      // commit restores the old day/rate instead of noon-at-rate-0
      const d = skyArgs().dormantRated;
      if (d) for (const k of ['hours', 'rate']) if (d[k] != null && inputs[k]) {
        inputs[k].value = d[k];
        inputs[k].parentNode.querySelector('.v').textContent = inputs[k].value;
      }
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
    sendVerb('sky', gather());
    commit.classList.remove('dirty');
    commit.textContent = '✓ logged';
    setTimeout(() => { commit.textContent = '✓ log to world'; }, 1200);
  };
  body.appendChild(commit);

  body._sync = () => {
    const a = skyArgs();
    for (const [key, , , , , dflt] of SLIDERS) {
      // under a real clock hours/rate live in dormantRated (#65); show them
      // (disabled) as what the world would return to
      inputs[key].value = a[key] ?? a.dormantRated?.[key] ?? dflt;
      inputs[key].parentNode.querySelector('.v').textContent = inputs[key].value;
    }
    if (a.weather) wx.value = a.weather;
    if (a.clouds) cl.value = a.clouds;
    if (a.world) wl.value = a.world;
    // the option list is def-fed; fillClocks appends a raw-tz option when the
    // world's committed clock is one the def no longer lists
    ck.value = a.clock === 'real' ? (a.tz ?? '') : '';
    if (a.clock === 'real' && ck.value !== (a.tz ?? '')) fillClocks();
    syncClockUi();
    syncBasicOnly();
    syncGrassRow();
  };
  body._sync();
}

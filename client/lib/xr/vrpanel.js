// Settings › VR — one section on the video panel's grammar. Prefs live in xr.js
// (xrPrefs / setXrPref) so the frame loop reads them without a round trip.
// Visible whether or not a headset is sensed; the first row says which.
import { makeSection, flashHint } from '../ui.js';
import { checkRow, selectRow, btn, sliderTable } from '../edit/rows.js';
import { currentGrade, setGrade, GRADE_DEFAULT, GRADE_RANGE } from './quadcolour.js';
import { recentreXR, isPresenting } from './xr.js';
import { xrPrefs, setXrPref } from './xr-prefs.js';
import { pointerVisibilityMode } from './xrpointer.js';
import { xrGlyphAvailable } from '../audio/mictoggle.js';

export function initVRPanel() {
  makeSection('🥽 VR', (body) => {
    if (body.dataset.init) return;
    body.dataset.init = '1';

    const sensed = xrGlyphAvailable();
    const note = document.createElement('div');
    note.className = 'row';
    const span = document.createElement('span'); span.className = 'note'; note.appendChild(span);
    span.textContent = sensed
      ? 'A headset can present from this browser. The visor glyph in the HUD enters and leaves VR.'
      : 'No headset sensed. Chrome finds the OpenXR runtime only at browser start — if SteamVR came up after Chrome, use chrome://restart. These settings apply once one is found.';
    body.appendChild(note);

    const { row: turn } = selectRow('turning', [['snap', 'snap (30°)'], ['smooth', 'smooth']], xrPrefs.turn,
      (v) => { setXrPref('turn', v); flashHint(`VR turning: ${v}`); });
    turn.title = 'smooth: continuous, like a desktop mouse — the default. snap: the world pivots 30° per stick flick, a comfort option.';
    body.appendChild(turn);

    // whether the VR laser is drawn (xrpointer.js); dropdown.js opens the list inside the frame, so the <select> works on a quad
    const POINTER_VIS_OPTS = [['always', 'always'], ['never', 'never (still points)'], ['contextual', 'contextual']];
    const { row: pointerVis, select: pointerVisSel } = selectRow('pointer visibility', POINTER_VIS_OPTS, pointerVisibilityMode(xrPrefs.pointerVisibility),
      (v) => { setXrPref('pointerVisibility', pointerVisibilityMode(v)); flashHint(`VR pointer visibility: ${pointerVisibilityMode(v)}`); });
    pointerVisSel.id = 'vr-pointer-visibility';
    pointerVis.title = 'contextual (the default): the beam shows while it rests on a panel or a name, or while you hold grip or trigger. always: always drawn, faint when it points at nothing. never: no beam, but pointing, clicking and name hover still work (the surface dot has its own setting, below).';
    body.appendChild(pointerVis);
    const { row: dotVis, select: dotVisSel } = selectRow('surface dot visibility', POINTER_VIS_OPTS.map(([v, t]) => [v, v === 'never' ? 'never' : t]), pointerVisibilityMode(xrPrefs.dotVisibility),
      (v) => { setXrPref('dotVisibility', pointerVisibilityMode(v)); flashHint(`VR surface dot visibility: ${pointerVisibilityMode(v)}`); });
    dotVisSel.id = 'vr-dot-visibility';
    dotVis.title = 'the small mark where the laser lands, showing what a press would do there. contextual (the default): on panels, names and things you can use. always: on any surface the laser meets. never: no mark.';
    body.appendChild(dotVis);

    // eye resolution: 'auto' is what the headset's runtime asks for; each step is per axis, so pixels go as its square
    const RES_OPTS = [['auto', 'auto (the headset asks)'], ['85', '85% (≈ ¾ the pixels)'], ['70', '70% (≈ ½ the pixels)'], ['50', '50% (¼ the pixels)']];
    const { row: res } = selectRow('resolution', RES_OPTS, String(xrPrefs.res ?? 'auto'),
      (v) => { setXrPref('res', v); flashHint(`VR resolution ${RES_OPTS.find(([k]) => k === v)?.[1] ?? v}${isPresenting() ? ' — applies next time you enter VR' : ''}`); });
    res.title = 'auto: the size your headset runtime asks for (in SteamVR, its own resolution slider sets this; it is larger than the panel because the lens magnifies the centre). Lower is softer and faster. Takes effect when a session starts.';
    body.appendChild(res);

    const vig = checkRow('comfort vignette', () => !!xrPrefs.vignette,
      (on) => { setXrPref('vignette', !!on); flashHint(`VR vignette ${on ? 'on' : 'off'}`); });
    vig.title = 'darkens the edges of your view while you move or turn on the stick; opens again when you stop.';
    body.appendChild(vig);

    const { row: mir } = selectRow('desktop view', [['off', 'off (black)'], ['first', 'mirror my eyes'], ['third', 'third person']], xrPrefs.mirror,
      (v) => { setXrPref('mirror', v); flashHint(`desktop view: ${v}`); });
    mir.title = 'what the browser window shows while you are in the headset. off costs nothing; the others draw one extra frame per tick.';
    body.appendChild(mir);

    const seated = checkRow('seated', () => !!xrPrefs.seated,
      (on) => { setXrPref('seated', !!on); flashHint(`VR seated ${on ? 'on' : 'off'}`); if (isPresenting()) recentreXR('seated'); });
    seated.title = 'playing from a chair: the body stands at its own height under your head, and your real height is not measured. Recentres when toggled.';
    body.appendChild(seated);

    // saturation and contrast of the panel quads only (quadcolour.js); live while presenting, persisted
    const g = { ...currentGrade() };
    const grade = sliderTable([['saturation', ...GRADE_RANGE.saturation, 0.05], ['contrast', ...GRADE_RANGE.contrast, 0.02]], g, {
      set: (k, v) => { g[k] = v; Object.assign(g, setGrade({ [k]: v })); },
      fmt: (k, v) => Number(v).toFixed(2), label: (k) => (k === 'saturation' ? 'panel sat' : 'panel contr'), nmW: '64px', vW: '34px',
    });
    grade.el.title = 'VR panels only: how saturated and how contrasty the panels look in the headset. The desktop and your style colours are untouched.';
    body.appendChild(grade.el);
    body.appendChild(btn('panel look: defaults', () => { Object.assign(g, setGrade(GRADE_DEFAULT)); grade.repaint(); flashHint(`VR panels: saturation ${GRADE_DEFAULT.saturation}, contrast ${GRADE_DEFAULT.contrast}`); }));

    const rc = btn('recentre now', () => { if (!recentreXR('settings')) flashHint('recentre: enter VR first'); else flashHint('recentred'); });
    rc.title = 'body under your head, facing where you face. Also on the VR ring (right-stick press).';
    body.appendChild(rc);
  }, { id: 'vr', host: 'settings' });
}

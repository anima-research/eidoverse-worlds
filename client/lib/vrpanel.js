// Settings › VR (owner, 09-05 18:22: "add VR to the Settings — smooth turning,
// vignette, mirror VR view to desktop, 3rd person"). One section on the
// video panel's grammar; prefs live in xr.js (xrPrefs / setXrPref) so the
// frame loop reads them without a round trip. Visible whether or not a
// headset is sensed — the first row says which, so the rest make sense.
import { makeSection, flashHint } from './ui.js';
import { checkRow, selectRow, btn, sliderTable } from './rows.js';
import { currentGrade, setGrade, GRADE_DEFAULT, GRADE_RANGE } from './quadcolour.js';
import { xrPrefs, setXrPref, recentreXR, isPresenting } from './xr.js';
import { xrGlyphAvailable } from './mictoggle.js';

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

    // rows.js: selectRow(label, options, value, onChange) RETURNS { row, select }; checkRow(label, get, set) returns the element
    const { row: turn } = selectRow('turning', [['snap', 'snap (30°)'], ['smooth', 'smooth']], xrPrefs.turn,
      (v) => { setXrPref('turn', v); flashHint(`VR turning: ${v}`); });
    turn.title = 'smooth: continuous, like a desktop mouse — the default. snap: the world pivots 30° per stick flick, a comfort option.';
    body.appendChild(turn);

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

    // C15: seated + recentre. Seated keeps the body standing while you sit (the head is lifted to the
    // avatar's standing eye height and your real height is not measured); recentre puts the body
    // under your head and turns it to face where you face — also on the VR ring.
    const seated = checkRow('seated', () => !!xrPrefs.seated,
      (on) => { setXrPref('seated', !!on); flashHint(`VR seated ${on ? 'on' : 'off'}`); if (isPresenting()) recentreXR('seated'); });
    seated.title = 'playing from a chair: the body stands at its own height under your head, and your real height is not measured. Recentres when toggled.';
    body.appendChild(seated);

    // the VR panels' look (owner, 09-30: colours read less vibrant in the headset): saturation and contrast applied to
    // the panel quads only (quadcolour.js), never the design tokens or the desktop. Live while presenting; persisted.
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

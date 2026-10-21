// style — live token editing.
// Three swatches drive the token sheet directly: if any hex is hiding
// outside :root, the picker exposes it by NOT restyling that element.
// Persisted per-browser; "reset" returns to the sheet's own values.

import { makeSection } from './ui.js';
import { bus } from './base.js';

const LS = 'ew-style-tokens';
const FIELDS = [
  { key: '--panel-rgb', label: 'panel',     kind: 'rgbTriplet' },
  { key: '--brand',     label: 'accent',    kind: 'hex' },
  { key: '--attn',      label: 'attention', kind: 'hex' },
  { key: '--fg',        label: 'text',      kind: 'hex' },
];

const rootStyle = () => document.documentElement.style;
const hexToTriplet = (h) => {
  const n = parseInt(h.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const tripletToHex = (t) => {
  const p = t.trim().split(/\s+/).map(Number);
  return '#' + p.map((v) => v.toString(16).padStart(2, '0')).join('');
};

function load() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } }
function save(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch {} }

export function applyStyleTokens() {
  const o = load();
  // one-time migration: /panels used to keep its own key
  try {
    const old = parseFloat(localStorage.getItem('ew-panel-a'));
    if (old >= 0.3 && old <= 1 && o['--panel-a'] == null) { o['--panel-a'] = String(old); save(o); }
    localStorage.removeItem('ew-panel-a');
  } catch {}
  for (const [k, v] of Object.entries(o)) rootStyle().setProperty(k, v);
  bus.emit('style', { key: '*', value: null });
}

// --panel-a: the sheet's value unless a person dialed it (stored with the tokens)
export const panelAlpha = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-a'));
export function setPanelAlpha(v) {
  rootStyle().setProperty('--panel-a', String(v));
  const o = load(); o['--panel-a'] = String(v); save(o);
}

// --xr-panel-a: the VR quads' panel alpha (domquad.js reads it; 1 = opaque, today's VR). Separate from --panel-a on
// purpose: the desktop's glass tints a live viewport, a quad has none, so the desktop dial never reached VR (owner, 09-30).
export const XR_PANEL_A_RANGE = [0.6, 1];
export const xrPanelAlphaToken = () => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--xr-panel-a'));
  return Number.isFinite(v) ? v : 1;
};
export function setXrPanelAlpha(v) {
  const n = Math.min(XR_PANEL_A_RANGE[1], Math.max(XR_PANEL_A_RANGE[0], Number(v)));
  if (!Number.isFinite(n)) return;
  rootStyle().setProperty('--xr-panel-a', String(n));
  const o = load(); o['--xr-panel-a'] = String(n); save(o);
  bus.emit('style', { key: '--xr-panel-a', value: String(n) });   // the VR quads re-raster and pick their pass on this
}

// the opacity dials follow the token whoever sets it (a command, a reset, code): a dial that kept showing 1.00 while
// the VR panels sat at 0.6 is a control that lies (probe shot 148, 09-30). One listener, the newest panel's repaint.
let repaintDials = null;
bus.on('style', (e) => { if (e?.key === '--xr-panel-a' || e?.key === '*') repaintDials?.(); });

function currentHex(f) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(f.key).trim();
  return f.kind === 'rgbTriplet' ? tripletToHex(v) : v;
}

export function initStylePanel() {
  applyStyleTokens();
  makeSection('🎨 style', (body) => {
    body.innerHTML = '';
    for (const f of FIELDS) {
      const row = document.createElement('label');
      row.className = 'row';
      row.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const sw = document.createElement('input');
      sw.type = 'color';
      sw.value = currentHex(f);
      // no inline styling: input[type=color] is the house swatch (outlined — the
      // 'panel' swatch vanished on the panel without it)
      sw.oninput = () => {
        const v = f.kind === 'rgbTriplet' ? hexToTriplet(sw.value) : sw.value;
        rootStyle().setProperty(f.key, v);
        bus.emit('style', { key: f.key, value: v });   // sprites baked from tokens (nameplates, pills) repaint on this
        const o = load(); o[f.key] = v; save(o);
      };
      const name = document.createElement('span');
      name.textContent = f.label;
      row.append(sw, name);
      body.appendChild(row);
    }
    // panel visibility — two dials, because a desktop panel and a VR panel are different glass. The desktop one is
    // --panel-a (the visionOS "Tinted" lesson already lived behind /panels; asked for here, 09-01 23:31); it tints a
    // live viewport and never reached the headset, which the label now says (owner, 09-30). The VR one is --xr-panel-a.
    const dial = (label, title, min, max, get, set) => {
      const row = document.createElement('label');
      row.className = 'row'; row.title = title;
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = label;
      const input = document.createElement('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = 0.02;
      input.value = get();
      const val = document.createElement('span');
      val.className = 'v'; val.textContent = Number(input.value).toFixed(2);
      input.oninput = () => { set(input.value); val.textContent = Number(input.value).toFixed(2); };
      row.append(nm, input, val);
      body.appendChild(row);
      return { repaint: () => { input.value = get(); val.textContent = Number(input.value).toFixed(2); } };
    };
    const vis = dial('desktop panel opacity', 'the desktop panels\' glass: lower lets the world show through. VR panels have their own dial below.',
      0.3, 1, panelAlpha, setPanelAlpha);
    const xrVis = dial('VR panel opacity', 'the panels in a headset: 1 is solid (the default); lower lets the world show through behind the text.',
      ...XR_PANEL_A_RANGE, xrPanelAlphaToken, setXrPanelAlpha);
    repaintDials = () => { vis.repaint(); xrVis.repaint(); };

    const reset = document.createElement('button');
    reset.textContent = 'reset to defaults';
    reset.style.cssText = 'margin-top:6px;';
    reset.onclick = () => {
      for (const f of FIELDS) rootStyle().removeProperty(f.key);
      rootStyle().removeProperty('--panel-a');
      rootStyle().removeProperty('--xr-panel-a');
      save({});
      // repaint swatches + both opacity sliders from the sheet's own values
      const inputs = reset.parentElement.querySelectorAll('input[type=color]');
      FIELDS.forEach((f, i) => { inputs[i].value = currentHex(f); });
      vis.repaint(); xrVis.repaint();
      bus.emit('style', { key: '*', value: null });   // the VR quads re-raster at the sheet's values
      // ui.js's 1s sweep repaints the --p fill; dispatching input here would
      // re-save the default into the just-emptied store
    };
    body.appendChild(reset);
  }, { id: 'style', host: 'settings' });
}

// consentpanel — Settings ▸ body: my body's consent table, one row per act
// class, a select of the authority's three answers (everyone / ask / nobody),
// for strangers and for friends. The rows are consent.js's table; the table is
// the server's (PROTOCOL L6, shared/protocol/consent.js) — localbody.js sends
// it whenever a cell changes. Plain: the same .row.wide / .nm / .ctl markup
// contract as the video and audio sections (index.html owns it).
import { makeSection, flashHint } from './ui.js';
import { CLASSES, TIERS, MODES, CLASS_WORDS, PRESET_NAMES, cell, setCell, applyPreset, onConsentChange } from './consent.js';

const TIER_WORDS = { strangers: 'strangers', friends: 'friends' };
function selectRow(label, hint, options, value, onChange) {
  const row = document.createElement('div');
  row.className = 'row wide';
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', label);
  for (const [v, text] of options) sel.appendChild(new Option(text, v));
  sel.value = value;
  sel.onchange = () => onChange(sel.value, sel);
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = label; nm.title = hint;
  const ctl = document.createElement('span'); ctl.className = 'ctl'; ctl.appendChild(sel);
  row.append(nm, ctl);
  return row;
}
function heading(text) {
  const h = document.createElement('div');
  h.style.cssText = 'display:block;width:100%;box-sizing:border-box;padding:6px 8px 2px;font-size:11px;color:var(--dim)';
  h.textContent = text; return h;
}

export function initConsentPanel() {
  makeSection('🧍 body', (body) => {
    if (body.dataset.init) return;
    body.dataset.init = '1';
    body.dataset.panel = 'consent';
    body.appendChild(heading('who may do what to my body — the server refuses before anything reaches me; my own client has the last word'));
    body.appendChild(selectRow('preset', 'the server\'s presets; each fills every row below', [['', '—'], ...PRESET_NAMES.map((p) => [p, p])], '', (v, sel) => {
      if (v && applyPreset(v)) flashHint(`body consent: ${v}`);
      sel.value = '';
    }));
    const selects = [];
    for (const tier of TIERS) {
      body.appendChild(heading(TIER_WORDS[tier]));
      for (const cls of CLASSES) {
        const row = selectRow(CLASS_WORDS[cls] ?? cls, `${cls} — ${tier}`, MODES.map((m) => [m, m]), cell(tier, cls), (v) => { setCell(tier, cls, v); });
        const sel = row.querySelector('select'); sel.dataset.tier = tier; sel.dataset.class = cls;
        selects.push(sel); body.appendChild(row);
      }
    }
    // a change from elsewhere (/pushable, a preset, EW.setPosable) repaints the rows
    onConsentChange(() => { for (const s of selects) s.value = cell(s.dataset.tier, s.dataset.class); });
  }, { id: 'body', host: 'settings' });
}

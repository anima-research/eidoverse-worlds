// consentpanel — Settings ▸ body: my body's one switch (recut A2): accept / ask / refuse. The authority decides every
// act on my body by it (PROTOCOL; spec/NORMATIVE.md); consentsync sends it. Same .row.wide / .nm / .ctl markup as the
// video and audio sections (index.html owns it).
import { makeSection, flashHint } from './ui.js';
import { SWITCHES, SWITCH_WORDS, mySwitch, setSwitch, onConsentChange } from './consent.js';

export function initConsentPanel() {
  makeSection('🧍 body', (body) => {
    if (body.dataset.init) return;
    body.dataset.init = '1';
    body.dataset.panel = 'consent';
    const row = document.createElement('div'); row.className = 'row wide';
    const sel = document.createElement('select'); sel.setAttribute('aria-label', 'my body');
    for (const v of SWITCHES) sel.appendChild(new Option(`${v} — ${SWITCH_WORDS[v]}`, v));
    sel.value = mySwitch(); sel.dataset.switch = '1';
    sel.onchange = () => { if (setSwitch(sel.value)) flashHint(`my body: ${sel.value}`); };
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = 'who may do things to my body';
    nm.title = 'one answer for posing, shoving, dragging and touching me; the world decides by it before anything reaches me';
    const ctl = document.createElement('span'); ctl.className = 'ctl'; ctl.appendChild(sel);
    row.append(nm, ctl); body.appendChild(row);
    onConsentChange(() => { sel.value = mySwitch(); });
  }, { id: 'body', host: 'settings' });
}

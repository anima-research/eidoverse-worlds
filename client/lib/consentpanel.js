// consentpanel — Settings ▸ body: my body's two gates (Move me, Touch me), each a checkbox with a tooltip saying what it
// covers, then the people I always or never allow, each with a remove button (R 10-28). The lists are set from People
// Here (right-click a person: people.js). The authority decides every act on my body by these (PROTOCOL §5); consentsync
// sends them. Same .row.wide / .nm / .ctl markup as the video and audio sections (index.html owns it).
import { makeSection, flashHint } from './ui.js';
import { GATES, GATE_WORDS, gate, setGate, listed, setListed, onConsentChange } from './consent.js';

const LISTS = [['allow', 'Always allowed', 'always yes, whatever the switches say'], ['block', 'Never allowed', 'always no, whatever the switches say']];

export function initConsentPanel() {
  makeSection('🧍 body', (body) => {
    if (body.dataset.init) return;
    body.dataset.init = '1';
    body.dataset.panel = 'consent';
    const boxes = {};
    for (const g of GATES) {
      const { label, tip } = GATE_WORDS[g];
      const row = document.createElement('div'); row.className = 'row wide'; row.title = tip;
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = label; nm.title = tip;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = gate(g); cb.title = tip; cb.dataset.gate = g; cb.setAttribute('aria-label', label);
      cb.onchange = () => { if (setGate(g, cb.checked)) flashHint(`${label}: ${cb.checked ? 'on' : 'off'}`); };
      const ctl = document.createElement('span'); ctl.className = 'ctl'; ctl.appendChild(cb);
      row.append(nm, ctl); body.appendChild(row); boxes[g] = cb;
    }
    const lists = document.createElement('div'); lists.dataset.lists = '1'; body.appendChild(lists);
    const paintLists = () => {
      lists.textContent = '';
      for (const [list, title, says] of LISTS) {
        const people = listed(list); if (!people.length) continue;
        const head = document.createElement('div'); head.className = 'row wide';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = title; nm.title = says; head.append(nm); lists.append(head);
        for (const p of people) {
          const row = document.createElement('div'); row.className = 'row wide'; row.dataset.list = list; row.dataset.id = p.id;
          const who = document.createElement('span'); who.className = 'nm'; who.textContent = p.name; who.title = p.id;
          const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'remove'; rm.title = `take ${p.name} off this list: the switches answer them again`;
          rm.onclick = () => { if (setListed(p.id, null)) flashHint(`${p.name}: the switches answer them again`); };
          const ctl = document.createElement('span'); ctl.className = 'ctl'; ctl.appendChild(rm);
          row.append(who, ctl); lists.append(row);
        }
      }
      if (!lists.childElementCount) { const hint = document.createElement('div'); hint.className = 'row wide';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = 'right-click someone in People Here to always or never allow them'; hint.append(nm); lists.append(hint); }
    };
    paintLists();
    onConsentChange(() => { for (const g of GATES) boxes[g].checked = gate(g); paintLists(); });
  }, { id: 'body', host: 'settings' });
}

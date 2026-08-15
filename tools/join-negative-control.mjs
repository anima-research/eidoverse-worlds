import { chromium } from 'playwright';
const [,, URL, KEY, label] = process.argv;
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args:['--use-fake-ui-for-media-stream'] });
const pg = await (await b.newContext({permissions:['microphone']})).newPage();   // FRESH context, no localStorage
await pg.goto(`${URL}/?world=staging&key=${KEY}&name=rabscuttle`, {waitUntil:'domcontentloaded'});
// 🔴 DO NOT read the HUD name — the client paints it OPTIMISTICALLY before the
// server answers, so a REFUSED join still shows "rabscuttle @ staging". The
// only visible tell is ●(connected) vs ○(retrying), which I misread as cosmetic
// and nearly reported as an auth bypass (2026-08-15). Direct ws probe proves
// the server is correct: bad token → CLOSE 4003 "bad token".
//
// Assert the CONNECTION, not the label.
// 🔴 READ THE STATE, NOT THE NAME. The client paints the world name
// optimistically before the server answers, so a REFUSED join still shows
// "rabscuttle @ staging". And the glyph alone is ambiguous — hud.js:14-15 uses
// ● for BOTH live and retrying, separated only by a CSS class:
//     live '<span class="ok">●</span>'      connecting '<span>○</span>'
//     retrying '<span class="bad">●</span>' rejected  '<span class="bad">✕</span>'
// So assert on the CLASS: span.ok = the server said yes. ✕ = it said no.
const r = await pg.evaluate(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 18000) {
    const hud = document.querySelector('#hud');
    const txt = hud?.textContent || '';
    if (hud?.querySelector('span.ok')) return { joined: true,  state: 'live',     hud: txt.slice(0, 50) };
    if (/✕/.test(txt))                 return { joined: false, state: 'rejected', hud: txt.slice(0, 50) };
    await new Promise(r => setTimeout(r, 300));
  }
  return { joined: false, state: 'timeout', hud: (document.querySelector('#hud')?.textContent || '').slice(0, 50) };
});
console.log(`  ${label}: ${JSON.stringify(r)}`);
await b.close();

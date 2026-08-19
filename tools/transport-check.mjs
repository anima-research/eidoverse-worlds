// transport-check — the #132 transport-selection receipt, owned and asserting.
//
// Post-cutover there is ONE transport, so what "selection" must mean is:
//   1. Against an owned VOICE_TRANSPORT=sfu server, a real browser reaches
//      __voiceTransport 'sfu' — and legacy transport params (?mesh=1,
//      ?relay=1, ?sfu=1) are INERT: same one transport, no branch. A param
//      that used to pick a transport must not be able to resurrect one.
//   2. Against an owned server with VOICE_TRANSPORT unset (voice off), the
//      world still boots — panels render, no page errors. A silent world is
//      a degraded world, never a broken one.
//
// (Its ancestor was a field diagnostic that console-dumped four URL arms
// against an ambient server and asserted nothing — the review's exact
// objection, retired here.)
//
//   bun tools/transport-check.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();

async function boot(world, param) {
  const { page, close } = await launchBrowser({ mic: true });
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=probe${param}&key=${world.key}&name=tprobe`,
    { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#d-go', { timeout: 15000 }).catch(() => {});
  const nameField = await pg.$('#d-name');
  if (nameField) await nameField.fill('tprobe').catch(() => {});
  await pg.click('#d-go').catch(() => {});
  await pg.waitForFunction(() => window.__voiceTransport === 'sfu'
    || String(window.__voiceTransport || '').startsWith('failed'), null, { timeout: 20000 }).catch(() => {});
  const r = await pg.evaluate(() => ({
    transport: window.__voiceTransport ?? '(none)',
    panels: document.querySelectorAll('.sec').length,
  }));
  await close();
  return { ...r, errs };
}

// ── arm 1: sfu server, legacy params inert ───────────────────────────────────
{
  const world = await ownedWorld({ env: { VOICE_TRANSPORT: 'sfu' } });
  try {
    for (const [label, param] of [['bare', ''], ['?sfu=1', '&sfu=1'], ['?mesh=1', '&mesh=1'], ['?relay=1', '&relay=1']]) {
      const r = await boot(world, param);
      check(`${label}: the one transport (sfu) and nothing else`,
        r.transport === 'sfu' && r.errs.length === 0,
        JSON.stringify({ transport: r.transport, errs: r.errs.slice(0, 2) }));
    }
  } finally { await world.close(); }
}

// ── arm 2: voice off — degraded, never broken ────────────────────────────────
{
  const world = await ownedWorld({});
  try {
    const r = await boot(world, '');
    check('voice-off world still boots: panels render, no page errors',
      r.panels > 0 && r.errs.length === 0,
      JSON.stringify({ panels: r.panels, errs: r.errs.slice(0, 2) }));
  } finally { await world.close(); }
}

done();

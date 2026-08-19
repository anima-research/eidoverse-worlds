// audio-cmd-probe — EXECUTE /audio in a real browser against a live world.
//
// audio-report-test.mjs re-implements the report to test its shape; this
// drives the shipped one through the real chat input (Escape first — the
// leading / opens command autocomplete, and Enter with it open feeds acceptAC,
// not submit). First run caught a missing import that left two probes
// "unreadable" while every node-side test stayed green.
//
//   node tools/audio-cmd-probe.mjs   (world on :8960; JOIN_KEY env for the key)
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:8960';
const KEY = process.env.JOIN_KEY || 'dev';
const b = await chromium.launch({ executablePath: process.env.SFU_TEST_CHROME || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const pg = await (await b.newContext({ permissions: ['microphone'] })).newPage();
await pg.goto(`${ORIGIN}/?world=staging&name=audioprobe&key=${KEY}`, { waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 3000));
await pg.click('#chatline');
await pg.keyboard.type('/audio');
await pg.keyboard.press('Escape');   // the / opened command autocomplete — close it or Enter feeds acceptAC
await pg.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 1000));
const out = await pg.evaluate(() => {
  const lines = [...document.querySelectorAll('#chatlog *')].map((e) => e.textContent);
  const fresh = lines.filter((t) => t.includes('build:') && t.includes('audio ▸') && t.length < 600).pop();
  return fresh ?? 'no fresh report (no build: line)';
});
console.log(out);
await b.close();
// The report must exist, carry the SERVED build (a stale page and a broken
// probe are otherwise indistinguishable), and have no probe dead on arrival —
// "unreadable" is the guarded-probe marker for a throw, and this caught a
// missing import the whole node-side suite could not see.
const ok = /audio ▸/.test(out) && /build: [0-9a-f]{7}/.test(out) && !/unreadable/.test(out);
console.log(ok ? 'PASS — /audio runs, every probe answers, build is stamped from /version' : 'FAIL');
process.exit(ok ? 0 : 1);

// Which transport does a URL actually get? Asserts window.__voiceTransport.
import { chromium } from 'playwright';
const [,, BASE, KEY] = process.argv;
const cases = [['(bare — no param)',''], ['?sfu=1','&sfu=1'], ['?mesh=1','&mesh=1'], ['?relay=1','&relay=1']];
const b = await chromium.launch({ executablePath:'/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
for (const [label, param] of cases) {
  const pg = await (await b.newContext({permissions:['microphone']})).newPage();
  await pg.goto(`${BASE}/?world=staging${param}&key=${KEY}&name=tprobe`, {waitUntil:'domcontentloaded'});
  // 🔴 THERE IS A FRONT DOOR, AND ITS BUTTON IS #d-go (ui.js:369).
  // main.js only calls start() from openDoor's onEnter callback, so a probe
  // that merely LOADS the url never picks a transport — it sits at the panel.
  // Every browser check I ran on 2026-08-15 was measuring the door, not the
  // world; the HUD paints behind the overlay, which is why refused joins still
  // "showed" a name. I then guessed at button:has-text("Enter") and clicked
  // whatever `button` matched first. Read the markup instead of guessing.
  await pg.waitForSelector('#d-go', { timeout: 15000 }).catch(() => {});
  const nameField = await pg.$('#d-name');
  if (nameField) await nameField.fill('tprobe').catch(() => {});
  await pg.click('#d-go').catch(() => {});
  await new Promise(r=>setTimeout(r,7000));
  const t = await pg.evaluate(() => window.__voiceTransport ?? '(none)');
  console.log(`  ${label.padEnd(20)} → ${t}`);
  await pg.context().close();
}
await b.close();

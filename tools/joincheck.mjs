import { chromium } from 'playwright';
const [URL, KEY] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/home/claude/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
for (const [label, key] of [['good key', KEY], ['bad key ', 'definitely-wrong']]) {
  const ctx = await b.newContext();                    // fresh — no localStorage carryover
  const pg = await ctx.newPage();
  await pg.goto(`${URL}/?world=staging&key=${key}&name=keycheck`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 6000));
  const hud = await pg.evaluate(() => document.querySelector('#hud')?.textContent || '(no hud)');
  // ● = connected, ✕ = not — the NAME paints either way, so matching it is
  // exactly the broken-harness case the runbook's negative control exists for.
  console.log(`${label} → ${hud.includes('●') ? 'JOINED' : 'not joined'}   hud: ${hud.slice(0, 60)}`);
  await ctx.close();
}
await b.close();

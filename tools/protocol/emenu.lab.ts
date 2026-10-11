// LAB: where the ∃ menu opens relative to the ∃ (R 10-10: "slightly offset down and to the right").
// @ts-nocheck
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const { cdp, evalJson, cleanup, BASE } = await scratchBench("emenu", {});
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Probe` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  await sleep(3000);
  const r = await evalJson(`(async () => { const ui = await import('/lib/ui.js'); ui.toggleEMenu(true); await new Promise((z) => setTimeout(z, 400));
    const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { l: b.left, t: b.top, r: b.right, b: b.bottom, pad: cs.padding, border: cs.borderTopWidth, bg: cs.backgroundColor }; };
    const h = document.getElementById('hud'), m = document.getElementById('emenu');
    return { hud: R(h), hudParent: R(h.parentElement), parentTag: h.parentElement.id || h.parentElement.className, menu: R(m), first: R(m.firstElementChild) }; })()`);
  console.log(JSON.stringify(r));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 320, height: 200, scale: 2 } });
  await Bun.write(process.env.SHOT ?? "/home/claude/eido/logs/emenu.png", Buffer.from(shot.data, "base64"));
} finally { await cleanup(); }

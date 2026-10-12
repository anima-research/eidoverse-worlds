// LAB: the status bar's copy pill after a long refusal (R 10-11 22:48). Screenshots to logs/hintbar-{short,long}.png.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, sleep } from "../tools/harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = "/home/claude/eido/scratch-worlds/v4-garden";
const { evalJson, cleanup, BASE, cdp } = await scratchBench("hintbar", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Lab&world=gym` });
  for (let i = 0; i < 120; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 1) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  const shot = async (name, text) => {
    await evalJson(`import('/lib/ui.js').then((m) => (m.flashHint ?? m.default?.flashHint)(${JSON.stringify(text)}, 20000, 'attn'))`);
    await sleep(600);
    const r = await evalJson(`(() => { const h = document.getElementById('hintbar'), b = h.querySelector('.hint-copy'), hb = h.getBoundingClientRect(), bb = b?.getBoundingClientRect(); return { bar: [hb.width, hb.height].map(Math.round), btn: bb ? [bb.width, bb.height].map(Math.round) : null, btnRightOfText: bb ? bb.right >= hb.right - 20 : null, inside: bb ? bb.right <= hb.right && bb.bottom <= hb.bottom : null }; })()`);
    console.log(name, JSON.stringify(r));
    const png = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 240, y: 560, width: 800, height: 160, scale: 2 } });
    fs.writeFileSync(`/home/claude/eido/logs/hintbar-${name}.png`, Buffer.from(png.data, "base64"));
  };
  await shot("short", "couldn't get to “pyramid crate 2”: something is in the way");
  await shot("long", "couldn't put “pyramid crate 2” down: nothing in reach has room for it (tried in front, both sides and behind; the tray is full, the sign is locked, and the floor there is taken by three other crates and a lantern)");
} finally { await cleanup(); }

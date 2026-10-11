// LAB: R's gym, copied. R 10-11 12:57: "With 'Rab' as the name, it won't let me do anything… I can't seem to change the
// display name anywhere". Join as Rab (an owner), rename in the profile header, reload: same person (id, role), new name.
//   WORLDS_SRC=/home/claude/eido/scratch-worlds/v4-garden bun tools/protocol/gym-rename.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC;
const { cdp, cws, evalJson, cleanup, BASE } = await scratchBench("gymrename", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 300)); if (!ok) fail++; };
const ready = async () => { for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); } await sleep(3000); };
const who = () => page(`const n = await import('/lib/net.js'), b = await import('/lib/base.js'); return { name: b.CONFIG.name, account: b.CONFIG.account, role: n.net.myRights?.role ?? null, me: n.net.myId ?? n.net.me ?? null, url: location.search };`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Rab&world=gym` }); await ready();
  const a = await who(); check("RN1 Rab joins as an owner", a.role === "owner", a);
  const opened = await page(`const w = await import('/lib/windows.js'); const f = w.getFrame('profile'); f?.show?.() ?? (f && (f.root.hidden = false, f.root.style.display = '')); return !!document.querySelector('.pf-rename');`);
  const dlg = await page(`document.querySelector('.pf-name').click(); await new Promise((z) => setTimeout(z, 200)); const d = document.querySelector('.pf-rename-dlg'); const i = d.querySelector('.pf-rename-in'); i.value = 'Rabscuttle'; i.dispatchEvent(new Event('input')); const warn = d.querySelector('.pf-rename-warn').textContent; d.querySelector('.pf-rename-ok').click(); return { warn };`).catch((e) => ({ err: String(e) }));
  console.log('DLG', JSON.stringify(dlg));
  await sleep(1500); await ready();
  const b = await who(); check("RN2 after rename: the new name, the same account, still an owner, the URL carries the new name", b.name === "Rabscuttle" && b.account === "Rab" && b.role === "owner" && !/name=Rab(&|$)/.test(b.url), { opened, b });
  // a second rename inside the cooldown: the door keeps the name, says when; the dialog then shows the date, input off
  const dlg2 = await page(`document.querySelector('.pf-name').click(); await new Promise((z) => setTimeout(z, 200)); const d = document.querySelector('.pf-rename-dlg'); return { disabled: d.querySelector('.pf-rename-in').disabled, warn: d.querySelector('.pf-rename-warn').textContent };`);
  check("RN3 straight after a rename the dialog says when the next one is allowed, and won't take one", dlg2.disabled && /again on/.test(dlg2.warn), dlg2);
  await page(`localStorage.setItem('ew-name', 'Rabbit'); const u = new URL(location.href); u.searchParams.set('name', 'Rabbit'); location.href = u.href; return 1;`).catch(() => null);
  await sleep(1500); await ready();
  const c = await who(); check("RN4 the door refuses a rename inside the cooldown: the old name stands, the URL follows it, still an owner", c.name === "Rabscuttle" && c.role === "owner" && /name=Rabscuttle/.test(c.url), c);
} catch (e) { console.log("ERR", e?.message ?? e); fail++; }
finally { await cleanup(0); }
console.log(`[gym-rename] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);

// tools/protocol/access-panel-probe.ts — World Settings › Who may come in › Listed here, in headless Chromium against a scratch
// sequencer (tools/harness.ts scratchBench). The panel reads @world's roles:* from the page's own fold and edits them with
// ordinary requests; the authority judges, and its refusal is shown in words (R 10-27; docs/DESIGN-world-access.md § UX).
//   AP1  an unlisted person here is a chip; adding them writes roles:<their identity>; the row then shows them listed, here now
//   AP2  a name search covers only people this world has seen: someone known elsewhere on the server isn't found by name
//   AP3  an exact identity (u-…) adds someone the world hasn't seen, with the chosen role and time
//   AP4  a row's role change keeps the grant's end (merge); ✕ deletes the grant
//   AP7  a row's "ends ▸" changes only the end (merge): a role someone changed since the panel painted is kept; "no end" removes it
//   AP5  a refusal (an identity this server doesn't know) is shown in the panel in the authority's words; nothing written
//   AP6  a non-owner sees the list read-only; pressing add anyway is refused by the authority, and the words are shown
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck } from "../harness.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import { pageWaiter, tryUntil } from "./wait.ts";

const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "accbot", WORLD = "accp", AWAY = "accp-away";
process.env.TRUST_NAMES = "1";   // a private test server: a name is the account local:<name> (server/config.ts)
let worldsDir = "";
const found = (w: string, owner: string) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", w, "--owner", owner, "--title", "access panel probe"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString()); };
const { cdp, evalJson, cleanup, die, BASE } = await scratchBench("access-panel", {
  prepare: (scratch) => { worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true }); found(WORLD, ME); found(AWAY, "carol"); },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : typeof detail === "string" ? detail.slice(0, 600) : (JSON.stringify(detail) ?? "").slice(0, 600));
const wc = () => fold(readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")))).entities["@world"]?.c ?? {};
const waitFor = pageWaiter(evalJson);
const waitDisk = async (pred: () => boolean, ms = 8000) => (await tryUntil("the log on disk", () => pred() || undefined, { ms })) !== undefined;
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
// a plain socket in a world; its identity is the one its snapshot names
const sock = (world: string, name: string) => new Promise<{ ws: WebSocket; id: string }>((res, rej) => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/ws");
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, avatar: "", replica: true }));
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === "snapshot" && m.cut?.you) res({ ws, id: m.cut.you }); };
  ws.onerror = rej; setTimeout(() => rej(new Error(`${name} never joined ${world}`)), 15000);
});
const P = `document.querySelector('#__acc .ap-listed')`;
const mount = () => page(`document.getElementById('__acc')?.remove(); const m = await import('/lib/rolespanels.js'); const b = document.createElement('div'); b.id = '__acc'; document.body.append(b); m._test.paintAccess(b); return true;`);
const panelText = () => evalJson(`${P}?.textContent ?? null`);
const find = (q: string) => evalJson(`(() => { const p = ${P}; const i = p?.querySelector('input.ap-q'); if (!i) return false; i.value = ${JSON.stringify(q)}; p.querySelector('button.ap-find').click(); return true; })()`);
const pick = (sel: string, v: string) => evalJson(`(() => { const s = ${P}?.querySelector(${JSON.stringify(sel)}); if (!s) return false; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); return true; })()`);
const click = (sel: string) => evalJson(`(() => { const b = ${P}?.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
const boot = async (name: string) => {
  // a fresh person: the page keeps who it was (cookie, stored identity) across a navigation
  await cdp.send("Network.clearBrowserCookies"); await cdp.send("Storage.clearDataForOrigin", { origin: BASE, storageTypes: "all" });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${name}&world=${WORLD}` });
  const up = await waitFor(`document.querySelectorAll('.sec').length >= 4`, 80000);
  if (!up) await die(1, "the page never booted");
  await evalJson(`(() => { const s = document.querySelector('#splash'); if (s) s.style.pointerEvents = 'none'; return true; })()`);
  return waitFor(`import('/lib/net.js').then((m) => m.replicaActive() && !!m.net.myRights)`, 20000);
};

try {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message));` });
  const carol = await sock(AWAY, "carol");   // the server knows carol (she is in another world); this world has never seen her
  check("boot: the owner's page is in the world", await boot(ME));
  const bob = await sock(WORLD, "bob");
  await waitFor(`import('/lib/net.js').then((m) => [...m.identities.values()].includes(${JSON.stringify(bob.id)}))`);
  await mount();
  check("AP0 Who may come in carries a Listed-here part, with my own identity on it", await waitFor(`!!${P} && ${P}.querySelector('.ap-you')?.textContent.includes(${JSON.stringify("u-")})`, 6000), await panelText());

  // AP1 bob is here and unlisted: a chip; adding him writes roles:<bob> {role: builder}
  check("AP1 bob (here, unlisted) is offered as a chip", await waitFor(`!!${P}?.querySelector('.ap-here button[data-who=${JSON.stringify(bob.id)}]')`, 6000), await panelText());
  await pick("select.ap-add-role", "builder");
  await click(`.ap-here button[data-who="${bob.id}"]`);
  const bobListed = await waitDisk(() => wc()[`roles:${bob.id}`]?.role === "builder");
  check("AP1 …adding him writes roles:<his identity> {role: builder}; his row says builder, here now", bobListed && await waitFor(`(() => { const r = ${P}?.querySelector('.ap-row[data-who=${JSON.stringify(bob.id)}]'); return !!r && /builder/.test(r.textContent) && /here now/.test(r.textContent); })()`, 6000), { roles: wc()[`roles:${bob.id}`], text: await panelText() });

  // AP2 the name search is this world's: carol is known to the server, never seen here
  const n2 = Object.keys(wc()).length;
  await find("carol");
  check("AP2 a name search finds only people this world has seen: 'carol' (known elsewhere on this server) isn't found, and the panel says how to add her", await waitFor(`/nobody called "carol" has been in this world/.test(${P}?.querySelector('.ap-note')?.textContent ?? '') && /identity/.test(${P}.querySelector('.ap-note').textContent) && !${P}.querySelector('.ap-hit')`, 6000) && Object.keys(wc()).length === n2, await panelText());
  await find("bob");
  check("AP2b …while bob (seen here) is found by name", await waitFor(`!!${P}?.querySelector('.ap-hit[data-who=${JSON.stringify(bob.id)}]')`, 6000), await panelText());

  // AP3 an exact identity adds someone the world hasn't seen, with the role and time chosen
  await pick("select.ap-add-role", "builder"); await pick("select.ap-add-span", "3600000");
  await find(carol.id);
  await waitFor(`!!${P}?.querySelector('.ap-hit[data-who=${JSON.stringify(carol.id)}] button')`, 6000);
  const t0 = Date.now();
  await click(`.ap-hit[data-who="${carol.id}"] button`);
  const carolIn = await waitDisk(() => wc()[`roles:${carol.id}`]?.role === "builder");
  const until = wc()[`roles:${carol.id}`]?.until;
  check("AP3 an exact identity (u-…) adds someone the world hasn't seen: roles:<carol> {role: builder, until ≈ now + 1 h}", carolIn && Number.isSafeInteger(until) && Math.abs(until - (t0 + 3_600_000)) < 120_000, wc()[`roles:${carol.id}`]);
  check("AP3b …and her row is listed, with the time left", await waitFor(`/left/.test(${P}?.querySelector('.ap-row[data-who=${JSON.stringify(carol.id)}]')?.textContent ?? '')`, 6000), await panelText());

  // AP4 a role change from the row keeps the end; ✕ takes the grant away
  await pick(`.ap-row[data-who="${carol.id}"] select.ap-role`, "member");
  const moved = await waitDisk(() => wc()[`roles:${carol.id}`]?.role === "member");
  check("AP4 the row's role select changes her role and keeps the grant's end (merge)", moved && wc()[`roles:${carol.id}`]?.until === until, wc()[`roles:${carol.id}`]);
  // AP7 another write lands while the row is in use (focused: the panel doesn't repaint under a hand), then "ends ▸" is picked
  const rowSel = `.ap-row[data-who="${carol.id}"] select.ap-until`;
  await waitFor(`!!${P}?.querySelector(${JSON.stringify(rowSel)})`, 6000);
  await evalJson(`(${P}.querySelector(${JSON.stringify(rowSel)}).focus(), true)`);
  await page(`await (await import('/lib/net.js')).sendRequest('set', { id: '@world', component: 'roles:${carol.id}', value: { role: 'builder' }, merge: true }); return true;`);
  const changed = await waitDisk(() => wc()[`roles:${carol.id}`]?.role === "builder");
  const t7 = Date.now();
  await pick(rowSel, "86400000");
  const ended = await waitDisk(() => Math.abs((wc()[`roles:${carol.id}`]?.until ?? 0) - (t7 + 86_400_000)) < 120_000);
  check("AP7 the row's \"ends ▸\" (1 day) sets only the end: the role another write made since the panel painted (builder) stays", changed && ended && wc()[`roles:${carol.id}`]?.role === "builder", wc()[`roles:${carol.id}`]);
  await pick(`.ap-row[data-who="${carol.id}"] select.ap-until`, "never");
  check("AP7b …and \"no end\" removes the end, the role kept", await waitDisk(() => { const g = wc()[`roles:${carol.id}`]; return !!g && !("until" in g) && g.role === "builder"; }), wc()[`roles:${carol.id}`]);
  await waitFor(`!!${P}?.querySelector(${JSON.stringify(rowSel)})`, 6000);
  await pick(rowSel, "3600000");
  const timed = await waitDisk(() => Number.isSafeInteger(wc()[`roles:${carol.id}`]?.until));
  await pick("select.ap-add-role", "builder"); await pick("select.ap-add-span", "");
  await find(carol.id); await waitFor(`!!${P}?.querySelector('.ap-hit[data-who=${JSON.stringify(carol.id)}] button')`, 6000);
  await click(`.ap-hit[data-who="${carol.id}"] button`);
  check("AP8 adding someone already listed with a timed grant, for \"no end\", removes the end", timed && await waitDisk(() => { const g = wc()[`roles:${carol.id}`]; return !!g && !("until" in g) && g.role === "builder"; }), wc()[`roles:${carol.id}`]);
  await waitFor(`!!${P}?.querySelector('.ap-row[data-who=${JSON.stringify(carol.id)}] button.ap-rm')`, 6000);
  await click(`.ap-row[data-who="${carol.id}"] button.ap-rm`);
  check("AP4b ✕ deletes roles:<carol>, and her row goes", carolIn && await waitDisk(() => !wc()[`roles:${carol.id}`]) && await waitFor(`!${P}?.querySelector('.ap-row[data-who=${JSON.stringify(carol.id)}]')`, 6000), await panelText());

  // AP5 a refusal is shown in the panel, in the authority's words
  const GHOST = "u-aaaaaaaaaaaaaaaaaaaa"; const n5 = Object.keys(wc()).length;
  await find(GHOST); await waitFor(`!!${P}?.querySelector('.ap-hit[data-who=${JSON.stringify(GHOST)}] button')`, 6000);
  await click(`.ap-hit[data-who="${GHOST}"] button`);
  check("AP5 adding an identity this server doesn't know: the authority's refusal is shown in the panel, and nothing is written", await waitFor(`/identity this server doesn't know/.test(${P}?.querySelector('.ap-refused')?.textContent ?? '')`, 6000) && Object.keys(wc()).length === n5, await panelText());

  const owned = (js: string) => page(`await (await import('/lib/net.js')).sendRequest(${js}); return true;`);
  const folded = (js: string) => waitFor(`import('/lib/net.js').then((m) => { const c = m.replica.st?.entities?.['@world']?.c ?? {}; return ${js}; })`, 6000);
  const dr0 = wc()["default-role"];
  await owned(`'set', { id: '@world', component: 'default-role', value: { role: 'builder', guests: null }, merge: true }`);
  await folded(`c['default-role']?.role === 'builder' && !('guests' in c['default-role'])`);
  await mount();
  const guests = await evalJson(`(() => { const s = document.querySelector('#__acc select[data-k=guests]'); return s && { value: s.value, options: [...s.options].map((o) => o.value) }; })()`);
  check("AP9 with newcomers made builders and no guests role written, the guests select shows member, what a guest is, not the first role it lists", guests?.value === "member" && guests.options.includes("builder"), guests);
  await owned(dr0 ? `'set', { id: '@world', component: 'default-role', value: ${JSON.stringify(dr0)} }` : `'delete', { id: '@world', component: 'default-role' }`);
  await waitDisk(() => JSON.stringify(wc()["default-role"]) === JSON.stringify(dr0));

  await owned(`'set', { id: '@world', component: 'spawn', value: { pos: [1, 0, 2], radius: 3, yaw: 1.57 } }`);
  await folded(`c.spawn?.yaw === 1.57`);
  await page(`document.getElementById('__places')?.remove(); const m = await import('/lib/rolespanels.js'); const b = document.createElement('div'); b.id = '__places'; document.body.append(b); m._test.paintPlaces(b); return true;`);
  await evalJson(`(() => { const b = document.getElementById('__places'); b.querySelector('[data-k=spawn][data-i="0"]').value = '4'; b.querySelector('[data-k=radius]').value = ''; b.querySelector('[data-save]').click(); return true; })()`);
  check("AP10 Places' Save writes the spawn's place and radius and keeps the rest of it: an emptied radius goes, and the arrival's facing (yaw) stays", await waitDisk(() => { const s = wc().spawn; return !!s && s.pos?.[0] === 4 && !("radius" in s) && s.yaw === 1.57; }), wc().spawn);
  await owned(`'delete', { id: '@world', component: 'spawn' }`);
  await waitDisk(() => !wc().spawn);

  // AP6 a non-owner: the same list, read-only; pressing add anyway is the authority's to refuse
  check("(setup) dave's page is in the world (no role: the newcomer role, no grantRoles)", await boot("dave"));
  await mount();
  const ro = await waitFor(`!!${P}?.querySelector('.ap-row[data-who=${JSON.stringify(bob.id)}]')`, 6000) && await evalJson(`({ ctl: ${P}.querySelectorAll('select, button, input').length })`);
  const daveId = await evalJson(`import('/lib/net.js').then((m) => m.net.you)`);
  check("(setup) dave is someone else (his own identity, not the owner's)", daveId && daveId !== bob.id && !/owner/.test(await evalJson(`import('/lib/net.js').then((m) => m.net.myRights?.role)`)), daveId);
  check("AP6 a non-owner sees bob listed, with no controls (no add box, no selects, no ✕)", ro && ro.ctl === 0, { ro, text: await panelText() });
  await page(`const n = await import('/lib/net.js'); n.net.myRights = { ...n.net.myRights, permissions: [...(n.net.myRights.permissions ?? []), 'grantRoles'] }; return true;`);   // as if the panel were wrong about dave
  await mount();
  const n6 = Object.keys(wc()).length;
  await find(carol.id); await waitFor(`!!${P}?.querySelector('.ap-hit[data-who=${JSON.stringify(carol.id)}] button')`, 6000);
  await click(`.ap-hit[data-who="${carol.id}"] button`);
  check("AP6b …a non-owner pressing add anyway is refused by the authority (grantRoles), the words are shown, and nothing is written", await waitFor(`/grantRoles|owner/.test(${P}?.querySelector('.ap-refused')?.textContent ?? '')`, 6000) && Object.keys(wc()).length === n6 && !wc()[`roles:${carol.id}`], await panelText());

  check("no page errors", !(await evalJson(`__errs.length`)), await evalJson(`__errs`));
  bob.ws.close(); carol.ws.close();
} catch (e: any) { check("probe ran to the end", false, String(e?.stack ?? e).slice(0, 500)); }
console.log(`[access-panel-probe] ${tally.passed} passed, ${tally.failed} failed`);
await cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);

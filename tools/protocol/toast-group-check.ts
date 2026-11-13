// tools/protocol/toast-group-check.ts — load failures of one kind are ONE toast that counts the things (R 10-28), each
// thing's line in the console; dismissing it quiets that kind for the session; any other error still toasts on its own.
import { scratchBench, mkCheck } from "../harness.ts";
import { until } from "./wait.ts";

const WORLD = "toasts";
const b = await scratchBench("toast-group", { worlds: [WORLD] });
const { check, tally } = mkCheck();
const warns: string[] = [];
b.cws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "warning") warns.push(String(m.params.args?.[0]?.value ?? ""));
});
const js = (x: string) => b.evalJson(`(async () => { ${x} })()`);
const toasts = () => js("return [...document.querySelectorAll('#toasts .toast:not(.out)')].map((t) => t.textContent);");
try {
  await b.cdp.send("Page.navigate", { url: `${b.BASE}/?world=${WORLD}&name=T` });
  await until("the HUD is up", () => js("return !!document.getElementById('toasts') && !!(await import('/lib/ui.js')).errorToast;").catch(() => false), { ms: 60000 });
  await js("document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); return true;");
  await js(`const { errorToast } = await import('/lib/ui.js');
    for (const n of ['water-terrain', 'water-habitat', 'water-submarine']) for (let i = 0; i < 3; i++) errorToast('realize spawn ' + n, 'fetch /library/store/models/' + n + '.glb: 404');
    return true;`);
  const grouped = (await toasts()).filter((t: string) => /couldn't load|realize spawn/.test(t));   // the world's own notices may toast too
  check("TG1 three things failing 404 nine times are ONE toast that counts three things", grouped.length === 1 && /^3 things couldn't load \(not on this server\)/.test(grouped[0] ?? ""), JSON.stringify(grouped));
  check("TG2 each thing's failure is on the console", ["water-terrain", "water-habitat", "water-submarine"].every((n) => warns.some((w) => w.includes(n))), JSON.stringify(warns.slice(0, 4)));
  await js("[...document.querySelectorAll('#toasts .toast:not(.out)')].find((t) => /couldn't load/.test(t.textContent))?.click(); return true;");
  await until("the toast leaves", async () => !(await toasts()).some((t: string) => /couldn't load/.test(t)), { ms: 3000 });
  await js("(await import('/lib/ui.js')).errorToast('realize spawn water-platform', 'fetch /library/store/models/p.glb: 404'); return true;");
  const afterDismiss = await toasts();
  check("TG3 dismissed, that kind stays quiet for the session (still logged)", !afterDismiss.some((t: string) => /couldn't load/.test(t)) && warns.some((w) => w.includes("water-platform")), JSON.stringify(afterDismiss));
  await js("(await import('/lib/ui.js')).errorToast('sky', 'shader compile failed'); return true;");
  const other = await toasts();
  check("TG4 an error of another kind still toasts on its own, in its own words", other.filter((t: string) => t.startsWith("sky: shader compile failed")).length === 1, JSON.stringify(other));
} catch (e) { check("the run threw", false, String((e as any)?.stack ?? e)); }
console.log(`[toast-group-check] ${tally.passed} passed, ${tally.failed} failed${tally.note()}`);
await b.cleanup(tally.failed ? 1 : 0);
process.exit(tally.failed ? 1 : 0);

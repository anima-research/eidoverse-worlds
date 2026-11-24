// test/client/toast-group-test.ts — load failures of one HTTP status (ui.js errorToast: `fetch <url>: NNN`) are ONE
// toast that counts the things (R 10-28), each thing's line in the console; dismissing it quiets that kind for the
// session; a network error ("Failed to fetch") isn't grouped; any other error still toasts on its own. Under happy-dom:
// ui.js against the HUD's own element ids (was the protocol folder's toast-group check, in headless Chromium: G4-213).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/toast-group-test.ts
// @ts-nocheck
import path from "node:path";
import { ENGINE } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";

const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
GlobalRegistrator.register();
// the HUD's elements ui.js finds at load (client/index.html)
document.body.innerHTML = ["toasts", "hud", "loading", "hintbar", "door", "help", "dock", "touch"].map((id) => `<div id="${id}"></div>`).join("");
const warns: string[] = []; const warn0 = console.warn; console.warn = (...a: any[]) => { warns.push(a.map(String).join(" ")); };
const { errorToast } = await import(path.join(ENGINE, "client/lib/ui/ui.js"));
const SU = suite("toast-group");
const toasts = () => [...document.querySelectorAll("#toasts .toast:not(.out)")].map((t) => t.textContent ?? "");

for (const n of ["water-terrain", "water-habitat", "water-submarine"]) for (let i = 0; i < 3; i++) errorToast("realize spawn " + n, "fetch /library/store/models/" + n + ".glb: 404");
const grouped = toasts().filter((t) => /couldn't load|realize spawn/.test(t));
SU.ok(grouped.length === 1 && /^3 things couldn't load \(not on this server\)/.test(grouped[0] ?? ""), "TG1 three things failing 404 nine times are ONE toast that counts three things", grouped);
SU.ok(["water-terrain", "water-habitat", "water-submarine"].every((n) => warns.filter((w) => w.includes(n)).length === 3), "TG2 each failure is on the console", warns.slice(0, 4));
(document.querySelector("#toasts .toast:not(.out)") as any)?.click();
const gone = !toasts().some((t) => /couldn't load/.test(t));
errorToast("realize spawn water-platform", "fetch /library/store/models/p.glb: 404");
const afterDismiss = toasts();
SU.ok(gone && !afterDismiss.some((t) => /couldn't load/.test(t)) && warns.some((w) => w.includes("water-platform")), "TG3 dismissed, that kind stays quiet for the session (still logged)", [gone, afterDismiss]);
errorToast("realize spawn water-gate", "fetch /library/store/models/g.glb: 500");
errorToast("sky", "shader compile failed"); errorToast("realize spawn lamp", "Failed to fetch");
const other = toasts();
SU.ok(other.filter((t) => t.startsWith("sky: shader compile failed")).length === 1 && other.filter((t) => /^1 thing couldn't load \(the server answered 500\)/.test(t)).length === 1
  && other.filter((t) => t.startsWith("realize spawn lamp: Failed to fetch")).length === 1,
  "TG4 an error of another kind still toasts on its own, in its own words; another status is its own group; a network error isn't grouped", other);
console.warn = warn0;
SU.done();

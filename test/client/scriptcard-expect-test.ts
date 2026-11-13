// scriptcard-expect-test — the editor's new-script card (client/lib/edit/scriptcard.js) takes its `expect` from the thing as it
// planned, not as it stands after the upload (house 6340433633: the planner picked a free action from the thing at
// Create, and sendOps read expect after the upload's await, so a reaction someone added meanwhile was overwritten with
// no refusal). Headless: happy-dom, edit/writes.js and net stubbed (test/stubs/scriptcard-expect-stub.mjs).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/scriptcard-expect-test.ts
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({ name: "scriptcard-expect-stubs", setup(b) {
  for (const m of ["writes", "net"]) stubResolve(b, new RegExp(`^(\\.\\.?/)+${m}\\.js$`), () => ({ path: here("../stubs/scriptcard-expect-stub.mjs") }));
} });
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const S = await import("../stubs/scriptcard-expect-stub.mjs");
const { openNewScript } = await import("../../client/lib/edit/scriptcard.js");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); } };

// a bell with no reactions: the planner picks `use`. While the upload is out, someone gives it a use reaction of their own.
S.T.comps.bell = { model: "crate", label: "a bell" };
S.T.uploadGate = async () => { S.T.comps.bell = { ...S.T.comps.bell, reactions: { use: { kind: "toggle", component: "openable" } } }; };
const done = openNewScript("bell");
(document.querySelector("#script-new .sn-name") as any).value = "chime";
(document.querySelector("#script-new .sn-ok") as any).click();
const r: any = await done;
const ops = S.T.sent.find((x: any) => x.kind === "sendOps");
const base = ops?.opts?.base?.bell;
check("the card created the script on its action (use: the bell had none when planned)", r?.ok === true && r.action === "use", r);
check("its batch's expect is read from the bell as planned: base holds the bell without the reaction added during the upload", !!base && !("reactions" in base) && base.label === "a bell", ops?.opts ?? null);
console.log(`[scriptcard-expect] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

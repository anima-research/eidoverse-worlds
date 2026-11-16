// editquad-lock-test — build mode's VR quad (fieldpanels.js renderCanvas, theme 'edit') offers a tree row's padlock
// only where this viewer may lift it, as the legacy quad and the desktop row do (333-cm bug a9).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/editquad-lock-test.ts
// Mutation (must go red): in client/lib/edit/widgets.js's edit-quad row, push the 'lock' region regardless of r.lockable.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
(globalThis as any).Path2D ??= class Path2D { constructor(public d?: string) {} };
HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true }) as any;
};
const { renderCanvas } = await import("../../client/lib/edit/fieldpanels.js");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `  — ${detail}` : ""}`); };
const rows = [{ id: "high", label: "high", locked: true, lockable: false }, { id: "mine", label: "mine", locked: true }, { id: "free", label: "free", locked: false }];
for (const theme of ["edit", null]) {
  const regions: any[] = renderCanvas(document.createElement("canvas"), [{ t: "tree", k: "sel", rows }], { theme }) ?? [];
  const locks = regions.filter((r) => r.action === "lock").map((r) => r.payload);
  check(`a9 ${theme ?? "legacy"} quad: a padlock for the rows this viewer may lock or lift, none for one locked above their rank`,
    locks.length === 2 && locks.includes("mine") && locks.includes("free") && !locks.includes("high"), JSON.stringify(locks));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

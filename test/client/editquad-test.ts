// editquad-test — build mode's VR quad (fieldpanels.js renderCanvas, theme 'edit') agrees with the legacy quad and the
// desktop row: a tree row's padlock only where this viewer may lift it (333-cm a9); a range's face trimmed (a-lesser).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/editquad-test.ts
// Mutations (must go red): in client/lib/edit/widgets.js's edit painters, push the 'lock' region regardless of r.lockable;
// face a range with v.toFixed(dp).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { suite } from "../gate/suite.ts";
GlobalRegistrator.register();
(globalThis as any).Path2D ??= class Path2D { constructor(public d?: string) {} };
const painted: string[] = [];
HTMLCanvasElement.prototype.getContext = function () {
  return new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : k === "fillText" ? (s: string) => { painted.push(String(s)); } : () => {}), set: () => true }) as any;
};
const { renderCanvas } = await import("../../client/lib/edit/fieldpanels.js");
const S = suite("editquad");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
const rows = [{ id: "high", label: "high", locked: true, lockable: false }, { id: "mine", label: "mine", locked: true }, { id: "free", label: "free", locked: false }];
for (const theme of ["edit", null]) {
  const regions: any[] = renderCanvas(document.createElement("canvas"), [{ t: "tree", k: "sel", rows }], { theme }) ?? [];
  const locks = regions.filter((r) => r.action === "lock").map((r) => r.payload);
  check(`a9 ${theme ?? "legacy"} quad: a padlock for the rows this viewer may lock or lift, none for one locked above their rank`,
    locks.length === 2 && locks.includes("mine") && locks.includes("free") && !locks.includes("high"), JSON.stringify(locks));
}
for (const theme of ["edit", null]) {
  painted.length = 0;
  renderCanvas(document.createElement("canvas"), [{ t: "range", k: "mix", label: "mix", value: 0.3, unit: "×" }], { theme });
  check(`${theme ?? "legacy"} quad: a range's value is faced trimmed (0.3×, as the desktop row shows it), not 0.30×`, painted.includes("0.3×") && !painted.includes("0.30×"), JSON.stringify(painted));
}
S.done();

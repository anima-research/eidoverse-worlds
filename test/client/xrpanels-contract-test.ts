// xrpanels — the registration contract docs/guide/MODDING-UI.md advertises.
// The VR runtime (xrPanelsEnter, xrPanelsPick) is covered only by the laser rows
// below; the rest is the seam a mod calls: registerXRPanel(def) validates its def
// and an id registers once. Most other suites STUB xrpanels (edittheme-test's D section is one that doesn't), so this one
// drives the real module — a stub would only assert its own shim.
// RED when: the validation guard goes (a def with no dispatch registers), or
// the findIndex/replace becomes a push (re-registering an id duplicates it).
import { fileURLToPath } from "node:url";
import { plugin } from "bun";
import { stubResolve } from "../harness/stub.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
plugin({
  name: "xrpanels-stubs",
  setup(b) {
    stubResolve(b, /^(\.\.?\/)+core\.js$/, () => ({ path: here("../stubs/core-stub.mjs") }));
    stubResolve(b, /^(\.\.?\/)+base\.js$/, () => ({ path: here("../stubs/core-stub.mjs") }));
    // edit/fieldpanels.js stays REAL — renderCanvas/hitRegion are the schema this seam speaks
    stubResolve(b, /^(\.\.?\/)+(xr\/)?domquad\.js$/, () => ({ path: here("../stubs/xrpanels-domquad-stub.mjs") }));
    // quadcolour's node material is the WebGPU build's only: an identity here, as test/client/edittheme-test.ts has it
    stubResolve(b, /^(\.\.?\/)+(xr\/)?quadcolour\.js$/, () => ({ path: "quadcolour", namespace: "xrpanels-stub" }));
    b.onLoad({ filter: /.*/, namespace: "xrpanels-stub" }, () => ({ contents: "export const quadMaterial = () => {};", loader: "js" }));
  },
});
GlobalRegistrator.register();
(globalThis as any).Path2D ??= class Path2D {};
(globalThis as any).requestAnimationFrame ??= (f: any) => setTimeout(f, 0);
// a 2D context that paints nothing (the quads are painted when shown)
(HTMLCanvasElement.prototype as any).getContext = () => new Proxy({ measureText: (t: string) => ({ width: t.length * 8 }) } as any, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
const xr = await import("../../client/lib/xr/xrpanels.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("XRPANELS — registerXRPanel validates the def a mod hands it");
const good = { id: "modpanel", fields: () => [], dispatch: () => {} };
check("a well-formed def registers (true)", xr.registerXRPanel(good) === true);
check("its id is in the registry", xr.xrPanelIds().includes("modpanel"), JSON.stringify(xr.xrPanelIds()));
check("no id → refused", xr.registerXRPanel({ fields: () => [], dispatch: () => {} } as any) === false);
check("fields not a function → refused", xr.registerXRPanel({ id: "b1", fields: [], dispatch: () => {} } as any) === false);
check("no dispatch → refused", xr.registerXRPanel({ id: "b2", fields: () => [] } as any) === false);
check("undefined → refused, no throw", xr.registerXRPanel(undefined as any) === false);
check("a refused def leaves the registry alone", !xr.xrPanelIds().some((i: string) => i.startsWith("b")), JSON.stringify(xr.xrPanelIds()));

console.log("XRPANELS — an id registers ONCE (a re-register replaces)");
const before = xr.xrPanelIds().filter((i: string) => i === "modpanel").length;
check("registered exactly once to begin with", before === 1, String(before));
xr.registerXRPanel({ id: "modpanel", fields: () => [{ t: "info", k: "v", label: "second" }], dispatch: () => {} });
const after = xr.xrPanelIds().filter((i: string) => i === "modpanel");
check("re-registering the same id does NOT duplicate", after.length === 1, JSON.stringify(xr.xrPanelIds()));
xr.registerXRPanel({ id: "other", fields: () => [], dispatch: () => {} });
check("a different id appends", xr.xrPanelIds().filter((i: string) => i === "other").length === 1 && xr.xrPanelIds().length >= 2, JSON.stringify(xr.xrPanelIds()));

console.log("XRPANELS — the laser hits only the quads that are showing");
{ const { THREE } = await import("../stubs/core-stub.mjs");
  const rig = new THREE.Group(); xr.xrPanelsEnter(rig); rig.updateMatrixWorld(true);
  const quads = rig.children as any[];
  check("a quad per registered panel rides the rig", quads.length === xr.xrPanelIds().length, String(quads.length));
  xr.showXRPanel("modpanel", true); xr.showXRPanel("other", false);
  const [shownQ, hiddenQ] = ["modpanel", "other"].map((id) => quads[xr.xrPanelIds().indexOf(id)]);
  check("the setup: one quad shown, one hidden", shownQ?.visible === true && hiddenQ?.visible === false);
  const eye = new THREE.Vector3(0, 1.15, 0);
  const rayAt = (q: any) => ({ matrixWorld: new THREE.Matrix4().lookAt(eye, q.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 1, 0)).setPosition(eye) });
  const dShown = xr.xrPanelsPick(rayAt(shownQ));
  check("aimed at the shown quad, the pick hits it", typeof dShown === "number" && dShown > 0.5 && dShown < 1.2, String(dShown));
  check("aimed at the hidden quad, the pick hits nothing", xr.xrPanelsPick(rayAt(hiddenQ)) === null, String(xr.xrPanelsPick(rayAt(hiddenQ))));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

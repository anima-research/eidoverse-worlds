// xrpanels — the registration contract docs/MODDING-UI.md advertises.
// The VR RUNTIME (entry, quads, grab) is part 4 and inert at this rung; what
// ships here is the seam a mod calls: registerXRPanel(def) validates its def
// and an id registers once. Every other suite STUBS xrpanels, so this one
// drives the real module — a stub would only assert its own shim.
// RED when: the validation guard goes (a def with no dispatch registers), or
// the findIndex/replace becomes a push (re-registering an id duplicates it).
import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const here = (p: string) => new URL(p, import.meta.url).pathname;
plugin({
  name: "xrpanels-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./core-stub.mjs") }));
    // panels.js stays REAL — renderCanvas/hitRegion are the schema this seam speaks
    b.onResolve({ filter: /^\.\/domquad\.js$/ }, () => ({ path: here("./xrpanels-domquad-stub.mjs") }));
  },
});
GlobalRegistrator.register();
const xr = await import("../client/lib/xrpanels.js");

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

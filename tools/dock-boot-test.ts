// ui.js — the wrench's auto-pin across a RELOAD, run headless against the real module (dock-test's stubs).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/dock-boot-test.ts
//
// dock-test drives one module instance through a whole session, so it cannot see a boot. The auto-pin fires on the
// EDGE of the edit gate (a grant pins the wrench, a revoke unpins it), and the gate is closed at boot for everyone:
// rights arrive with the snapshot, after initDock. Measured in the browser (10-01): a builder who unpinned the wrench
// found it pinned again after every reload — the snapshot's rights read as a grant. The first rights report is where
// you START, not a change.
import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "dock-stubs",
  setup(b) {
    for (const m of ["base", "mictoggle", "xrpanels", "assets", "defs", "profile", "stylepanel", "videopanel", "capnotice"])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here("./dock-stub.mjs") }));
  },
});
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const saved = () => JSON.parse(localStorage.getItem("ew-dock-pins") ?? "null");
const CHROME = `<button id="hud" class="emark">∃</button><div id="dock" class="panel"></div><div id="emenu" class="panel" hidden></div>
  <div id="loading" class="panel"></div><div id="toasts"></div><div id="hintbar" class="panel"></div><div id="touch"></div>
  <div id="door" class="scrim"><div class="sheet panel"></div></div><div id="help" class="scrim"><div class="sheet panel"></div></div>`;

// one "page load": a fresh ui.js instance (the query string makes Bun evaluate it again) over the same localStorage
let boots = 0;
async function boot(gate: { open: boolean }) {
  document.body.innerHTML = CHROME;
  const ui = await import(`../client/lib/ui.js?boot=${++boots}`);
  const { bus } = await import("./dock-stub.mjs");
  ui.initDock([{ id: "edit", label: "🔧", icon: "wrench", last: true, action: () => {}, active: () => false, gate: () => gate.open }]);
  await new Promise((r) => setTimeout(r, 0));
  const btn = () => document.querySelector('#dock button[data-toggles="edit"]') as HTMLButtonElement;
  return { ui, bus, btn };
}

console.log("DOCK BOOT — a builder's unpinned wrench stays unpinned across a reload");
{
  localStorage.setItem("ew-dock-pins", JSON.stringify(["chat"]));   // the builder unpinned the wrench last session
  const gate = { open: false };                                     // rights not in yet
  const { bus, btn } = await boot(gate);
  gate.open = true; bus.emit("your-rights");                        // the snapshot's rights: builder, as before
  check("the snapshot's rights are where you start, not a grant: the wrench stays unpinned", !saved().includes("edit") && btn().hidden === true,
    `saved=${JSON.stringify(saved())} hidden=${btn().hidden}`);
  gate.open = false; bus.emit("your-rights");
  gate.open = true; bus.emit("your-rights");
  check("…a real grant later in the session still pins it", saved().includes("edit") && btn().hidden === false, JSON.stringify(saved()));
}
console.log("DOCK BOOT — a visitor's first report is a level too");
{
  localStorage.setItem("ew-dock-pins", JSON.stringify(["chat", "edit"]));   // pinned (a builder somewhere, once)
  const gate = { open: false };
  const { bus, btn } = await boot(gate);
  bus.emit("your-rights");                                          // arrives: still no rights here
  check("arriving without rights leaves the pin set alone (the wrench shows dead, as before)", saved().includes("edit") && btn().hidden === false && btn().disabled,
    `saved=${JSON.stringify(saved())} hidden=${btn().hidden} disabled=${btn().disabled}`);
  gate.open = true; bus.emit("your-rights");
  gate.open = false; bus.emit("your-rights");
  check("…a real revoke later still unpins it", !saved().includes("edit") && btn().hidden === true, JSON.stringify(saved()));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

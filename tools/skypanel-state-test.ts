// skypanel — the "world:" / "you:" lines, against the REAL panel over a stubbed sky.
//
//   bun tools/skypanel-state-test.ts
//
// What tools/sky-state-probe.mjs checks in a browser, minus the browser: the lines say what the log has and, only
// while this client shows something else, what and why. Here the sky is tools/skypanel-stub.mjs, so the cases the
// probe can't reach cheaply are cheap: a log with no clouds on the detailed sky, a real clock with no tz or a tz that
// doesn't resolve, and a new log landing on top of your unsaved preview.

import { fileURLToPath } from "node:url";
import { tryUntil } from "./protocol/wait.ts";
import { plugin } from "bun";
const stub = fileURLToPath(new URL("./skypanel-stub.mjs", import.meta.url));
plugin({
  name: "skypanel-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(base|defs|net|ui|sky|terrain|lod_policy|realize\/models|editwrites)\.js$/ }, () => ({ path: stub }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 1000, height: 700 });
// happy-dom has no Option constructor
(globalThis as any).Option ??= function (text = "", value = text) { const o = document.createElement("option"); o.textContent = text; o.value = value; return o; };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const { S, logSky } = await import("./skypanel-stub.mjs");
const { paintSky } = await import("../client/lib/skypanel.js");

const body = document.createElement("div");
document.body.append(body);
const world = () => body.querySelector(".state-world")?.textContent ?? "";
const you = () => { const y = body.querySelector(".state-you") as HTMLElement | null; return y && !y.hidden ? y.textContent ?? "" : ""; };

console.log("SKY PANEL — the clouds the detailed sky actually draws");
S.cloudQuality = "off";
logSky({ hours: 18.5, rate: 0, weather: "clear" });   // no clouds authored: the detailed sky builds cumulus
paintSky(body);
check("a log with no clouds reads as the cumulus the detailed sky draws", world() === "world: 18:30 · clear · clouds cumulus", world());
check("...and clouds⚙ off says so against it", /no clouds \(your clouds⚙ is off\)/.test(you()), you());
logSky({ hours: 18.5, rate: 0, weather: "clear", clouds: "nimbus" });
check("an unknown clouds value reads as cumulus too", world() === "world: 18:30 · clear · clouds cumulus", world());
logSky({ hours: 18.5, rate: 0, weather: "clear", system: "skymesh" });
check("the basic sky with none authored names none", world() === "world: basic sky · 18:30 · clear", world());
logSky({ hours: 18.5, rate: 0, weather: "clear", system: "skymesh", clouds: "stratus" });
check("...an authored value is still the log's to name", world() === "world: basic sky · 18:30 · clear · clouds stratus", world());
check("...and the clouds⚙ note is not about the basic sky, which draws none", !/clouds⚙/.test(you()), you());
logSky({ hours: 18.5, rate: 0, weather: "clear", clouds: "clear" });
check("authored clear: no note either", !/clouds⚙/.test(you()), you());
S.cloudQuality = "medium";

console.log("SKY PANEL — the clock line names what drives the sun");
logSky({ clock: "real", weather: "clear", clouds: "clear" });
check("the old spelling clock: 'real' with no tz is read no more (S6): no real clock, the authored hour", !/real clock/.test(world()) && /^world: 12:00/.test(world()), world());
logSky({ tz: "Europe/Paris", weather: "clear", clouds: "clear" });
check("a real clock names its tz", world().startsWith("world: real clock (Europe/Paris)"), world());
logSky({ tz: "Nowhere/Typo", hours: 9, rate: 0, weather: "clear", clouds: "clear" });
check("an unresolvable tz is not called a real clock", !/real clock/.test(world()), world());
check("...the parked clock's hour shows, and the tz is named as unrecognised",
  /^world: 09:00 .*Nowhere\/Typo/.test(world()), world());

console.log("SKY PANEL — a new log over your unsaved preview");
logSky({ hours: 12, rate: 0, weather: "clear", clouds: "clear" });
const slider = body.querySelector('input[type="range"]') as HTMLInputElement;
slider.value = "7"; slider.dispatchEvent(new Event("input"));
check("a slider edit previews", /previewing \(not logged\)/.test(you()), you());
logSky({ hours: 15, rate: 0, weather: "rain", clouds: "stratus" });   // someone else logs
check("...a log landing on it says your edits aren't shown", /unsaved edits aren't shown/.test(you()), you());
check("...and the slider still holds your edit", slider.value === "7", slider.value);
slider.value = "8"; slider.dispatchEvent(new Event("input"));
check("touching a slider previews your edits again", /previewing \(not logged\)/.test(you()) && !/unsaved/.test(you()), you());
(body.querySelector("button.dirty") as HTMLButtonElement).click();
logSky({ ...S.sent.at(-1)[1] });   // your own commit comes back as the log
check("after ✓ your log is the sky: nothing to say", you() === "", you());
logSky({ hours: 20, rate: 0, weather: "clear", clouds: "clear" });
check("with nothing unsaved a new log is simply followed", you() === "" && slider.value === "20", `${you()} slider=${slider.value}`);

// R 10-28 (item 13's bonus bug): the "world" select saved nothing (the sky stores no world since the 10-16 shape audit). Every
// world control in the panel must commit what it shows: each option chosen, then ✓, is in what is sent. Local ones are exempt.
console.log("SKY PANEL — every shared select commits what it shows");
{ const local = (sel: Element) => /local/.test(sel.getAttribute("aria-label") ?? "") || /local/.test((sel.closest(".row") as HTMLElement | null)?.title ?? "");
  // fillClocks fills the clock select from defsRegistry() (async): wait for the stub's clock to land
  await tryUntil("the clock select filled", () => [...body.querySelectorAll("option")].some((o) => (o as HTMLOptionElement).value === "Europe/Paris"), { ms: 3000 });
  const dead: string[] = []; const tried: string[] = [];
  for (const sel of [...body.querySelectorAll("select")] as HTMLSelectElement[]) { if (local(sel)) continue;
    const name = sel.closest(".row")?.querySelector(".nm")?.textContent ?? "?";
    for (const o of [...sel.options].map((x) => x.value)) {
      sel.value = o; sel.dispatchEvent(new Event("change")); (body.querySelector("button.dirty") as HTMLButtonElement | null)?.click();
      const sent = S.sent.at(-1)?.[1] ?? {}; tried.push(`${name}=${o}`);
      // the clock's '' is "authored (slider)": the commit carries no clock and no tz (skypanel.js ck.onchange)
      const ok = o === "" ? sent.clock === undefined && sent.tz === undefined : JSON.stringify(sent).includes(JSON.stringify(o));
      if (!ok) dead.push(`${name}=${o}`); } }
  check("(setup) the clock select offers the stub's clock and the authored option, among ≥ 6 options tried", tried.includes("clock=Europe/Paris") && tried.includes("clock=") && tried.length >= 6, tried.join(", "));
  check("no select whose choice the commit drops (the world select is gone: earth is the only sky world, and it isn't stored)", dead.length === 0, dead.join(", ")); }

// sun and fill are registered sky fields; their sliders commit what they show
console.log("SKY PANEL — the sun and fill sliders commit");
{ const got: Record<string, unknown> = {};
  for (const key of ["sun", "fill"]) { const row = [...body.querySelectorAll(".row")].find((r) => r.querySelector(".nm")?.textContent === key);
    const inp = row?.querySelector('input[type="range"]') as HTMLInputElement | null; if (!inp) { got[key] = "no slider"; continue; }
    inp.value = "1.5"; inp.dispatchEvent(new Event("input")); (body.querySelector("button.dirty") as HTMLButtonElement | null)?.click(); got[key] = S.sent.at(-1)?.[1]?.[key]; }
  check("sun 1.5 and fill 1.5 are in what ✓ sends", got.sun === 1.5 && got.fill === 1.5, JSON.stringify(got)); }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

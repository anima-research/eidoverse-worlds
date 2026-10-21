// skypanel — the "world:" / "you:" lines, against the REAL panel over a stubbed sky.
//
//   bun tools/skypanel-state-test.ts
//
// What tools/sky-state-probe.mjs checks in a browser, minus the browser: the lines say what the log has and, only
// while this client shows something else, what and why. Here the sky is tools/skypanel-stub.mjs, so the cases the
// probe can't reach cheaply are cheap: a log with no clouds on the detailed sky, a real clock with no tz or a tz that
// doesn't resolve, and a new log landing on top of your unsaved preview.

import { plugin } from "bun";
const stub = new URL("./skypanel-stub.mjs", import.meta.url).pathname;
plugin({
  name: "skypanel-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(base|defs|net|ui|sky|terrain|lod_policy|realize\/models)\.js$/ }, () => ({ path: stub }));
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
check("a real clock with no tz names the default it follows", world().startsWith("world: real clock (America/Los_Angeles)"), world());
logSky({ clock: "real", tz: "Europe/Paris", weather: "clear", clouds: "clear" });
check("a real clock names its tz", world().startsWith("world: real clock (Europe/Paris)"), world());
logSky({ clock: "real", tz: "Nowhere/Typo", dormantRated: { hours: 9, rate: 0, ts: Date.now() }, weather: "clear", clouds: "clear" });
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

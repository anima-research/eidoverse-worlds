import { suite } from "../gate/suite.ts";
// bus-events-test: a gesture's key hint rides the module bus (base.js), so a mod or probe listening there hears it; no
// window CustomEvent carries a client event (one-binding-test's row). The dock's move and the lantern's emits aren't driven here.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/bus-events-test.ts
const { bus } = await import("../../client/lib/base.js");
const kh = await import("../../client/lib/edit/keyhints.js");
const S = suite("bus-events");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);
const heard: any[] = [];
bus.on("keyhint", (h: any) => heard.push(h == null ? null : String(h)));
check("the setup: scrub has a during line", !!kh.KEYHINTS.scrub.during);
kh.engage("scrub"); kh.release();
check("engage puts the gesture's keys on the bus, release clears them", heard.length === 2 && /Shift/.test(heard[0] ?? "") && heard[1] === null, JSON.stringify(heard));
S.done();

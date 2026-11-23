// detach-test: a promise run for its effects goes through server/detach.ts, whose rejection is logged and never left
// unhandled (the server exits on an unhandled rejection: sfuguard.ts). `bun test/server/detach-test.ts`
import { suite } from "../gate/suite.ts";
import { detach } from "../../server/detach.ts";

const S = suite("detach");
const loose: unknown[] = []; process.on("unhandledRejection", (e) => loose.push(e));
const logged: unknown[][] = []; const err = console.error; console.error = (...a: unknown[]) => { logged.push(a); };
const turn = () => new Promise((r) => setImmediate(r));

detach(Promise.reject(new Error("boom")), "label-a");
detach((async () => { await turn(); throw new Error("later"); })(), "label-b");
detach(Promise.resolve(1), "label-c");
await turn(); await turn(); await turn();
console.error = err;

S.check("a rejection through detach is not an unhandled rejection", loose.length === 0, String(loose[0] ?? ""));
S.check("...and is logged under its label", logged.some((a) => a[0] === "[label-a]" && String(a[1]).includes("boom")) && logged.some((a) => a[0] === "[label-b]"), JSON.stringify(logged.map((a) => String(a[0]))));
S.check("a promise that resolves logs nothing", !logged.some((a) => a[0] === "[label-c]"));
S.done();

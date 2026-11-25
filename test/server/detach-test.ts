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

// a caller that owes someone an answer (a join waiting on its door) says so when the promise fails, not nothing
{ const told: string[] = []; const logged2: unknown[][] = []; console.error = (...a: unknown[]) => { logged2.push(a); };
  detach(Promise.reject(new Error("door unreadable")), "join", (err) => told.push(`refused: ${(err as Error).message}`));
  detach(Promise.resolve("fine"), "join", () => told.push("wrongly refused"));
  detach(Promise.reject(new Error("again")), "join", () => { throw new Error("the socket is gone"); });
  await turn(); await turn(); await turn();
  console.error = err;
  S.check("D2 a failure's handler runs once, with the error (the joiner is sent a refusal), and only on failure", told.length === 1 && told[0] === "refused: door unreadable", told);
  S.check("D2b ...a handler that itself throws is logged too, never an unhandled rejection", loose.length === 0 && logged2.some((a) => String(a[1]).includes("socket is gone")), JSON.stringify(logged2.map((a) => String(a[1]))));
}
S.done();

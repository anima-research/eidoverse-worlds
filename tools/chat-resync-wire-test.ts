// A re-join asks chat for what it missed — through the real net.js.
//
//   bun tools/chat-resync-wire-test.ts
//
// chat-scrollback-test drives resyncChatAfter by hand; this pins the call
// site (net.js onSnapshot): the FIRST snapshot resyncs nothing, a second one
// resyncs from the last seq the old socket delivered — read before the new
// snapshot's throughSeq or tail moves lastSeq on, or the hole is skipped.
// Same stub set as remotes-lifecycle-test; snapshots go in through _dispatch.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const stubs: any = await import("./remotes-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar", "xrbody"]) {
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
}
const { _dispatch } = (await import("../client/lib/net.js")) as any;
const say = (seq: number) => ({ seq, ts: Date.now(), actor: "cairn", verb: "say", args: { text: `#${seq}` } });
const snapshot = (throughSeq: number, entries: any[]) => ({ type: "snapshot", you: "tester",
  yourRights: { role: "member" }, present: [], state: null, entries, throughSeq });

console.log("a re-join's snapshot resyncs chat from the last delivered seq");
await _dispatch(snapshot(100, [say(101), say(102)]));
check("the first snapshot resyncs nothing", stubs.resyncCalls.length === 0, JSON.stringify(stubs.resyncCalls));
// (ported 10-17) this client folds the log stream itself ({type: "log", entries} through its replica, which needs an
// adopted cut these stubs don't build), so the live says between the two joins aren't fed here; what this pins is the
// call site: lastSeq — in the chat's numbering, seq × 1000, as the snapshot's throughSeq is — is what the resync asks
// from, read before the new snapshot moves it on
// the socket drops; 30 more entries happen; the re-join's snapshot is past them
await _dispatch(snapshot(130, [say(131), say(132)]));
check("the second snapshot resyncs once", stubs.resyncCalls.length === 1, JSON.stringify(stubs.resyncCalls));
check("…from the last seq the old socket had (in the chat's numbering, unscaled)", stubs.resyncCalls[0] === 100, `${stubs.resyncCalls[0]}`);
await _dispatch(snapshot(140, []));
check("a third resyncs from the second's", stubs.resyncCalls[1] === 130, JSON.stringify(stubs.resyncCalls));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

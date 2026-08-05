// chat log — the spoken-utterance merge and unread accounting, run headless.
//
//   bun tools/chat-log-test.ts
//
// This exists because logChat's merge fast-path once keyed on nothing but
// "agent + same author + 15 seconds", which collapsed ordinary agent chat
// into unrelated rows and skipped the unread/mention counters entirely
// (found in review, PR#7). The contract now: a row merges ONLY as the
// continuation of one spoken utterance (spoken:true + author + utt), a
// mention arriving in a merged sentence counts exactly like one arriving
// as its own row, and `t0` may reorder display only inside the spoken
// protocol's bounded window.

import { plugin } from "bun";
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({
  name: "chat-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/frames\.js$/ }, () => ({ path: here("./chat-frames-stub.mjs") }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here("./chat-net-stub.mjs") }));
  },
});

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { logChat, initChat, chat } = await import("../client/lib/chat.js");
const { frameStub } = await import("./chat-frames-stub.mjs");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

initChat({ send: () => {}, people: () => [{ id: "keir", agent: true }] });
const log = () => document.getElementById("chatlog")!;
const rows = () => [...log().children].filter((c) => !c.classList.contains("sys"));
const texts = () => rows().map((r) => r.querySelector(".body")?.textContent);
const reset = () => { log().innerHTML = ""; chat.markRead?.(); };

// --- one spoken utterance -> one durable row (flush + continuation merge)
let ts = Date.now();
logChat("keir", "First aired half —", "agent", { seq: 1, ts, spoken: true, utt: 7, t0: ts - 3000 });
logChat("keir", "and the finish.", "agent", { seq: 2, ts: ts + 400, spoken: true, utt: 7 });
check("one utterance, two says, ONE row", rows().length === 1, `${rows().length} rows`);
check("merged row reads as a paragraph",
  texts()[0]?.includes("First aired half") && texts()[0]?.includes("and the finish."), texts()[0] ?? "");

// --- two distinct utterances stay two rows
logChat("keir", "A new thought.", "agent", { seq: 3, ts: ts + 900, spoken: true, utt: 8 });
check("a NEW utt is a new row", rows().length === 2, `${rows().length} rows`);

// --- ordinary agent says never merge (the review's core regression)
reset();
logChat("keir", "tool output one", "agent", { seq: 4, ts });
logChat("keir", "tool output two", "agent", { seq: 5, ts: ts + 100 });
check("ordinary agent says keep their own rows", rows().length === 2, `${rows().length} rows`);

// --- an interrupter breaks the continuation chain
reset();
logChat("keir", "I was saying —", "agent", { seq: 6, ts, spoken: true, utt: 9, t0: ts - 2000 });
logChat("rab", "wait!", "", { seq: 7, ts: ts + 100 });
logChat("keir", "…as I was saying.", "agent", { seq: 8, ts: ts + 200, spoken: true, utt: 9 });
check("continuation after an interrupter is its own row (no cross-merge)",
  rows().length === 3, `${rows().length} rows`);

// --- merged mention hits the counters exactly once while hidden
reset();
frameStub.visible = false;
logChat("keir", "quiet start", "agent", { seq: 9, ts, spoken: true, utt: 10 });
const before = chat.unreadCounts?.() ?? null;
logChat("keir", "hey tester, look", "agent", { seq: 10, ts: ts + 300, spoken: true, utt: 10 });
const after = chat.unreadCounts?.() ?? null;
check("mention in a merged sentence counts while away",
  after && before && after.mentions === before.mentions + 1,
  JSON.stringify({ before, after }));
check("merged sentence does not double-count unread rows",
  after && before && after.unread === before.unread,
  JSON.stringify({ before, after }));
frameStub.visible = true;

// --- t0 reorders only inside the spoken protocol's bounded window
reset();
ts = Date.now();
logChat("rab", "the interrupt", "", { seq: 11, ts: ts - 1000 });
logChat("keir", "speech that began first", "agent",
  { seq: 12, ts, spoken: true, utt: 11, t0: ts - 5000 });
check("valid spoken t0 slots the speech before the interrupt",
  texts()[0] === "speech that began first", JSON.stringify(texts()));

reset();
logChat("rab", "later line", "", { seq: 13, ts: ts - 1000 });
logChat("keir", "malicious ancient t0", "agent",
  { seq: 14, ts, spoken: true, utt: 12, t0: 1 });
check("out-of-window t0 cannot rewrite history order",
  texts()[1] === "malicious ancient t0", JSON.stringify(texts()));

reset();
logChat("rab", "later line", "", { seq: 15, ts: ts - 1000 });
logChat("keir", "unspoken t0 smuggle", "", { seq: 16, ts, t0: ts - 5000 });
check("t0 outside the spoken protocol is ignored",
  texts()[1] === "unspoken t0 smuggle", JSON.stringify(texts()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

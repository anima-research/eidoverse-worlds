// requestHistory answers with a page, or rejects when it can't get one.
//
//   bun tools/history-request-test.ts
//
// chat.js reads an empty page as "nothing there": the beginning of the world
// for the backward walk, the end of what was missed for a re-join's catch-up.
// So a request that got no answer, with no socket joined or nothing back
// within 8 s, must not look like one: it rejects. This runs the real net.js,
// with tools/remotes-stubs.mjs for its imports, a fake socket, and a
// stand-in for the 8 s timer.

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
const { requestHistory, net, _dispatch } = (await import("../client/lib/net.js")) as any;
type Settled = { ok: true; value: any } | { ok: false; error: unknown };
const settle = (p: Promise<unknown>): Promise<Settled> =>
  p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
const fakeSocket = (sent: any[]) => ({ readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) });

const reason = (r: Settled) => (r.ok ? "" : String((r.error as Error)?.message ?? r.error));

console.log("no socket joined");
{
  net.joined = false;
  net.ws = null;
  const r = await settle(requestHistory({ before: 10, limit: 40 }));
  check("a request with no socket joined rejects, as not connected", !r.ok && /not connected/.test(reason(r)), JSON.stringify(r));
}

console.log("a socket that is joined but closed, or open but not joined");
for (const [label, joined, readyState] of [["joined but closed", true, 3], ["open but not joined", false, 1]] as const) {
  const sent: any[] = [];
  net.joined = joined;
  net.ws = { readyState, send: (s: string) => sent.push(JSON.parse(s)) };
  const r = await settle(requestHistory({ before: 10, limit: 40 }));
  check(`${label}: the request rejects as not connected, and nothing goes out`,
    !r.ok && /not connected/.test(reason(r)) && sent.length === 0, `${reason(r) || "resolved"}, ${sent.length} sent`);
}

console.log("a joined socket that answers");
{
  const sent: any[] = [];
  net.joined = true;
  net.ws = fakeSocket(sent);
  const p = settle(requestHistory({ before: 10, limit: 40, verbs: ["say"] }));
  check("the request goes out with its id", sent.length === 1 && sent[0].type === "history" && typeof sent[0].reqId === "string",
    JSON.stringify(sent));
  await _dispatch({ type: "history", reqId: sent[0].reqId, entries: [], oldestSeq: null, hasMore: false });
  const r = await p;
  check("an empty answer resolves, as the page it is", r.ok && Array.isArray(r.value.entries) && r.value.entries.length === 0,
    JSON.stringify(r));
}

console.log("a joined socket that never answers");
{
  const sent: any[] = [];
  net.joined = true;
  net.ws = fakeSocket(sent);
  // stand in for the clock: the 8 s timer fires at once, any other as asked
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
    delays.push(ms ?? 0);
    return realSetTimeout(fn, ms === 8000 ? 0 : ms, ...args);
  }) as typeof setTimeout;
  let r: Settled;
  try { r = await settle(requestHistory({ before: 10, limit: 40 })); }
  finally { globalThis.setTimeout = realSetTimeout; }
  check("the request waits 8 s for its answer", delays.includes(8000), JSON.stringify(delays));
  check("…then rejects, as no answer", !r.ok && /no answer within 8 s/.test(reason(r)), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

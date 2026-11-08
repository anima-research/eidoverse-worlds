// server/statecache-verify.ts — the background re-derive (a Worker, off the event loop): the log's first coversIndex+1 lines folded
// from genesis and chained, and their views built from genesis (server/foldviews.ts), for server/livehost.ts to compare with the
// cache it booted from (server/statecache.ts). It holds the covered lines parsed until it answers, so a cached boot's peak RAM is
// still about an eager boot's: the cache buys boot latency, not peak RAM (review L16; a streaming fold is the fix if that matters).
import fs from "node:fs";
import { readLog, fold } from "../shared/protocol/fold.js";
import { chainStep } from "../shared/protocol/authority/storage.js";
import { encodeState, stateDigest } from "./statecache.ts";
import { viewsFresh } from "./foldviews.ts";

declare const self: { onmessage: ((ev: { data: { logPath: string; coversIndex: number; views: { sim: boolean } | null } }) => void) | null; postMessage(m: unknown): void };
self.onmessage = ({ data: { logPath, coversIndex, views } }) => {
  try {
    const entries = readLog(fs.readFileSync(logPath)).slice(0, coversIndex + 1);
    let head = "00".repeat(32); for (const e of entries) head = chainStep(head, e);
    const v = views ? stateDigest(JSON.parse(JSON.stringify(viewsFresh(entries, { sim: views.sim })))) : undefined;
    self.postMessage({ digest: stateDigest(JSON.parse(JSON.stringify(encodeState(fold(entries))))), head, n: entries.length, views: v });
  } catch (x) { self.postMessage({ error: String((x as Error)?.message ?? x) }); }
};

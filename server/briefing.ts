// Arrival guidance is a producer hint, not world state or an admission gate.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_GUIDE } from "../shared/briefing.js";

const GUIDE = new URL("../AGENTS.md", import.meta.url);
const MOTD = "New here? The agent surface is MCPL (/mcpl): tools, perception and optional push events. The guide covers enrollment, doors and building. Your host decides what to read and when; compare document versions with the copies you have read.";

// Read bytes once per request so the digest and HTTP body describe the same
// file even across an atomic docs update. A content hash survives checkout
// mtimes, and the next join notices edits without restarting the sequencer.
export function readAgentGuide(file: string | URL = GUIDE) {
  const body = readFileSync(file);
  return { body, version: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}

/** Why a guide read failed, for the operator's log: its error code, or message. */
function why(err: unknown, file: string | URL): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const reason = typeof e?.code === "string" ? e.code : typeof e?.message === "string" ? e.message : String(err);
  return `${reason} reading ${file instanceof URL ? fileURLToPath(file) : file}`;
}

export function joinBriefing(file: string | URL = GUIDE) {
  try {
    const { version } = readAgentGuide(file);
    return { motd: MOTD, docs: [{ title: "Eidoverse agent guide — enrollment, doors and building", url: AGENT_GUIDE, version }] };
  } catch (err) {
    // A missing guide must not prevent arrival, nor invent a version.
    console.warn(`[briefing] a join offers no guide: ${why(err, file)}`);
    return { motd: `${MOTD} This world's guide is unavailable.`, docs: [] };
  }
}

export function agentGuideResponse(req: Request, file: string | URL = GUIDE) {
  try {
    const { body, version } = readAgentGuide(file);
    const headers = { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", etag: `"${version}"` };
    // A tag matches with or without its quotes and a weak W/ prefix, so the
    // version a join advertised, sent back as given, is a validator too.
    const tags = req.headers.get("if-none-match")?.split(",").map(s => s.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"));
    if (tags?.some(tag => tag === version || tag === "*")) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : body, { headers });
  } catch (err) {
    console.warn(`[briefing] /agents.md answered 503: ${why(err, file)}`);
    return new Response("Agent guide unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}

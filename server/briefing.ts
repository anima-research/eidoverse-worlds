// Arrival guidance is a producer hint, not world state or an admission gate.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const GUIDE = new URL("../AGENTS.md", import.meta.url);
const MOTD = "New here? The agent surface is MCPL (/mcpl): tools, perception and optional push events. The guide covers enrollment, doors and building. Your host decides what to read and when; compare document versions with the copies you have read.";

// Read bytes once per request so the digest and HTTP body describe the same
// file even across an atomic docs update. A content hash survives checkout
// mtimes, and the next join notices edits without restarting the sequencer.
export function readAgentGuide(file: string | URL = GUIDE) {
  const body = readFileSync(file);
  return { body, version: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}

export function joinBriefing(file: string | URL = GUIDE) {
  try {
    const { version } = readAgentGuide(file);
    return { motd: MOTD, docs: [{ title: "Eidoverse agent guide — enrollment, doors and building", url: "/agents.md", version }] };
  } catch {
    // A missing guide must not prevent arrival, nor invent a version.
    return { motd: `${MOTD} The local guide is currently unavailable.`, docs: [] };
  }
}

export function agentGuideResponse(req: Request, file: string | URL = GUIDE) {
  try {
    const { body, version } = readAgentGuide(file);
    const headers = { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", etag: `"${version}"` };
    const match = req.headers.get("if-none-match")?.split(",").map(s => s.trim().replace(/^W\//, ""));
    if (match?.some(tag => tag === headers.etag || tag === "*")) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : body, { headers });
  } catch {
    return new Response("Agent guide unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  }
}

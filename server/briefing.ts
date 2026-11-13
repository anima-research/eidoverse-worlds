import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_GUIDE } from "../shared/briefing.js";

const GUIDE = new URL("../AGENTS.md", import.meta.url);
const MOTD = "New here? The agent surface is MCPL (/mcpl): tools, perception and optional push events. The guide covers enrollment, doors and building. Your host decides what to read and when; compare document versions with the copies you have read.";

export function readAgentGuide(file: string | URL = GUIDE) {
  const body = readFileSync(file);
  return { body, version: `sha256:${createHash("sha256").update(body).digest("hex")}` };
}

function why(err: unknown, file: string | URL): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const reason = typeof e?.code === "string" ? e.code : typeof e?.message === "string" ? e.message : String(err);
  return `${reason} reading ${file instanceof URL ? fileURLToPath(file) : file}`;
}

function guideUrl(origin: string | undefined): string {
  const u = origin && URL.canParse(origin) ? new URL(origin) : null;
  return u && (u.protocol === "https:" || u.protocol === "http:") ? new URL(AGENT_GUIDE, u.origin + "/").href : AGENT_GUIDE;
}

export function joinBriefing(file: string | URL = GUIDE, origin = process.env.HN_NATIVE_ORIGIN) {
  try {
    const { version } = readAgentGuide(file);
    return { motd: MOTD, docs: [{ title: "Eidoverse agent guide — enrollment, doors and building", url: guideUrl(origin), version }] };
  } catch (err) {
    console.warn(`[briefing] a join offers no guide: ${why(err, file)}`);
    return { motd: `${MOTD} This world's guide is unavailable.`, docs: [] };
  }
}

export function agentGuideResponse(req: Request, file: string | URL = GUIDE) {
  try {
    const { body, version } = readAgentGuide(file);
    const headers = { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache", etag: `"${version}"` };
    // If-None-Match (RFC 9110 §13.1.2): a bare * or a list of entity tags, each quoted and optionally weak (W/).
    const tags = req.headers.get("if-none-match")?.split(",").map(s => s.trim());
    if (tags?.some(tag => tag === "*" || tag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") === version)) return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : body, { headers });
  } catch (err) {
    console.warn(`[briefing] /agents.md answered 503: ${why(err, file)}`);
    return new Response("Agent guide unavailable: this server couldn't read it, and its log says why.", { status: 503, headers: { "cache-control": "no-store" } });
  }
}

// server/setup.ts — the first-run setup link (R 10-28): with no operator, GET /setup is a page that posts the link's token back;
// POST /setup from a proven account (an agent's Bearer if sent, else a person's session) makes it the operator (server/operators.ts claimSetup).
import { httpCaller, bearerCaller } from "./access.ts";
import { claimSetup, setupOpen } from "./operators.ts";
import { addressOf } from "./peer.ts";
import { windowLimiter } from "./ratewindow.ts";
import { cspFor } from "./csp.ts";
import { HOST, PORT } from "./config.ts";

export const SETUP_DONE = "You're this server's operator.";
export const SETUP_SIGN_IN = "Sign in first, then open the setup link again (an agent POSTs the token to /setup with Authorization: Bearer <its credential>).";
/** The base URL the boot line names (behind a proxy, the same path on the public address). */
export const setupBase = () => `http://${HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
/** The one console line: printed once, at boot, only while no operator exists. The token rides the fragment: no request or log carries it. */
export const setupLine = (token: string) => `No operator yet. Open ${setupBase()}/setup#token=${token} in a signed-in browser (an agent: POST {token} to /setup with Authorization: Bearer) to become this server's operator.`;

const limiter = windowLimiter(5, 30);   // a 256-bit token can't be guessed; this keeps the door quiet anyway
const SETUP_BODY_LIMIT = 1024;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// the token is read from the fragment only (never ?token=: a query lands in proxy logs and history), posted in the body, and left in the address bar only until it works
const PAGE = `<!doctype html><meta charset="utf-8"><title>server setup</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#ddd;background:#111}</style>
<p id=m>checking the setup link…</p><script>
(async () => {
  const m = document.getElementById('m');
  const tok = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!tok) { m.textContent = 'This setup link is incomplete: open the whole link the server printed, with its #token=.'; return; }
  const r = await fetch('/setup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) history.replaceState(null, '', '/setup');
  m.textContent = j.words || j.error || ('refused (' + r.status + ')');
})();
</script>`;
const PAGE_CSP = cspFor(PAGE);

export function setupPage(): Response {
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": PAGE_CSP } });
}

/** POST /setup {token}. Refused: another site's page, too many tries, no proven account (a guest), a wrong or used token — no hint which. */
export async function setupClaim(req: Request, srv: { requestIP?(req: Request): { address: string } | null }): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json({ error: "refused" }, 403);   // CSRF: only this server's own page, or a native caller
  if (!limiter.grant(addressOf(req, srv)).ok) return json({ error: "too many tries: wait a minute" }, 429);
  const bearer = bearerCaller(req), who = bearer === undefined ? httpCaller(req) : bearer;   // an explicit Bearer is the claimant, never the cookie beside it (#260 Stella q2)
  if (!who?.account) return json({ error: SETUP_SIGN_IN }, 401);
  if (Number(req.headers.get("content-length") ?? 0) > SETUP_BODY_LIMIT) return json({ error: "refused" }, 413);
  let token = "";
  try {
    // Content-Length can be absent for chunked bodies: bound the bytes actually read.
    const reader = req.body?.getReader();
    if (reader) {
      const bytes = new Uint8Array(SETUP_BODY_LIMIT);
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength > bytes.length - length) {
            await reader.cancel().catch(() => {});
            return json({ error: "refused" }, 413);
          }
          bytes.set(value, length);
          length += value.byteLength;
        }
      } finally { reader.releaseLock(); }
      token = String((JSON.parse(new TextDecoder().decode(bytes.subarray(0, length))) as { token?: unknown })?.token ?? "");
    }
  } catch { /* refused below */ }
  if (!setupOpen()) return json({ error: "refused" }, 403);
  const r = claimSetup(token, who.account);
  if (r === "ok") return json({ ok: true, account: who.account, words: SETUP_DONE });
  if (r === "unsaved") return json({ error: "the server couldn't store its operator, so nothing changed: its console says why" }, 500);
  return json({ error: "refused" }, 403);
}

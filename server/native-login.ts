// Browser-approved native login. No world/log mutations and no OAuth tokens in
// the native client. Pending grants are memory-only, bounded, and single-use.
import { randomBytes } from "node:crypto";
import type { HnSession } from "./auth.ts";

type Options = {
  origin: string; login: string; enabled: boolean;
  session(cookie: string | null): HnSession | null;
  issue(session: HnSession): string;
  now?: () => number;
};
type Pair = { code: string; exp: number; pollAt: number; browserCookie?: string; denied?: boolean };
const CODE = /^[A-F0-9]{5}-[A-F0-9]{5}$/;
export function createNativeLogin(o: Options) {
  const pairs = new Map<string, Pair>();
  const now = o.now ?? Date.now;
  let windowAt = 0, starts = 0, requests = 0;
  const json = (status: number, data: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: {
      "content-type": "application/json", "cache-control": "no-store",
      "referrer-policy": "no-referrer", ...headers,
    } });
  return async function nativeLogin(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname; let t = now();
    if (t - windowAt >= 60_000) { windowAt = t; starts = requests = 0; }
    for (const [key, p] of pairs) if (p.exp <= t) pairs.delete(key);
    if (++requests > 1200) return json(429, { error: "slow_down" });
    if (!o.enabled) return json(503, { error: "identity_unavailable" });
    if (path === "/native" && req.method === "GET") return nativePage(o.login);
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    // Browser mutations must be same-origin. Non-browser native start/poll have
    // no Origin and no browser authority. Never accept credentialed CORS.
    const origin = req.headers.get("origin");
    if (origin && origin !== o.origin) return json(403, { error: "wrong_origin" });
    if (!req.headers.get("content-type")?.startsWith("application/json")) return json(415, { error: "json_required" });
    let body: any;
    try {
      // Bound streamed/chunked bodies too, not just the declared length.
      const reader = req.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) return json(400, { error: "bad_request" });
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 1024) { await reader.cancel(); return json(413, { error: "too_large" }); }
        chunks.push(value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json(400, { error: "bad_request" }); }
    t = now(); // Body reads can yield; never authorize against stale time.
    for (const [key, p] of pairs) if (p.exp <= t) pairs.delete(key);
    if (path === "/native/start") {
      if (++starts > 30 || pairs.size >= 256) return json(429, { error: "slow_down" });
      const secret = randomBytes(32).toString("hex");
      let code: string;
      do { code = randomBytes(5).toString("hex").toUpperCase().replace(/(.{5})(.{5})/, "$1-$2"); }
      while ([...pairs.values()].some(p => p.code === code));
      pairs.set(secret, { code, exp: t + 300_000, pollAt: 0 });
      return json(200, { device_code: secret, user_code: code, expires_in: 300, interval: 2 });
    }
    if (path === "/native/approve" || path === "/native/deny") {
      if (origin !== o.origin) return json(403, { error: "origin_required" });
      const cookie = req.headers.get("cookie");
      const s = o.session(cookie);
      if (!s || s.exp <= t) return json(401, { error: "sign_in_required" });
      if (s.nativeWorld || !s.scopes.includes("worlds:join")) return json(403, { error: "world_access_required" });
      const p = typeof body.user_code === "string" && CODE.test(body.user_code)
        ? [...pairs.values()].find(p => p.code === body.user_code) : undefined;
      if (!p || p.browserCookie || p.denied) return json(410, { error: "expired_or_used" });
      if (path === "/native/deny") p.denied = true;
      else p.browserCookie = cookie!;
      return json(200, { ok: true }); // Do NOT set a native cookie in the browser.
    }
    if (path === "/native/poll" || path === "/native/cancel") {
      const key = typeof body.device_code === "string" && /^[a-f0-9]{64}$/.test(body.device_code) ? body.device_code : "";
      const p = pairs.get(key);
      if (!p) return json(410, { error: "expired_or_used" });
      if (path === "/native/cancel") { pairs.delete(key); return json(200, { ok: true }); }
      if (t < p.pollAt) return json(429, { error: "slow_down" });
      p.pollAt = t + 2000;
      if (p.denied) { pairs.delete(key); return json(403, { error: "access_denied" }); }
      if (!p.browserCookie) return json(202, { status: "pending" });
      const s = o.session(p.browserCookie);
      pairs.delete(key); // Consume before issuing, including failures.
      if (!s || s.exp <= t || s.nativeWorld || !s.scopes.includes("worlds:join")) return json(403, { error: "session_expired" });
      const exp = Math.min(s.exp, t + 12 * 3600_000);
      const sid = o.issue({ sub: s.sub, name: s.name, scopes: s.scopes.filter(v => v === "worlds:join" || v === "worlds:spectate"),
        claims: s.claims, exp, nativeWorld: "water" });
      const seconds = Math.max(1, Math.floor((exp - t) / 1000));
      return json(200, { name: s.name, expires_in: seconds }, {
        "set-cookie": `ew_sess=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${o.origin.startsWith("https:") ? "; Secure" : ""}`,
      });
    }
    return json(404, { error: "not_found" });
  };
}

function nativePage(login: string): Response {
  const nonce = randomBytes(18).toString("base64");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connect Unreal · Eidoverse</title><style>body{font:18px/1.6 system-ui;max-width:34rem;margin:10vh auto;padding:0 1.5rem;color:#dcebed;background:#0b1820}button,a{font:inherit;color:inherit}button{padding:.6rem 1rem;background:#164650;border:1px solid #58b7ba;border-radius:.4rem;cursor:pointer;margin:.5rem .5rem .5rem 0}strong{color:#71ded7}input{font:inherit;width:10rem;text-transform:uppercase}#code{font-size:2rem;letter-spacing:.15rem} [hidden]{display:none!important}</style>
<h1>Connect your Unreal client</h1><p>Destination: <strong>water</strong> on Eidoverse.</p>
<p id="status">Checking your browser sign-in…</p>
<p id="code"></p><p>Only approve if this code matches the one in <strong>your own running Unreal client</strong>. Never approve a code sent by someone else.</p>
<p>This grants a separate session for up to 12 hours, limited to water. Joining shares your identity, avatar and movement; public chat is recorded. An existing water connection under your name may be replaced.</p>
<a id="login" hidden>Sign in with Discord</a>
<div id="actions" hidden><button id="approve">Authorize Unreal for water</button><button id="deny">Deny</button></div>
<p id="result" role="status"></p>
<script nonce="${nonce}">
// Reopening into an existing tab can be a same-document fragment navigation.
addEventListener('hashchange', () => location.reload());
(async () => {
  const $ = id => document.getElementById(id);
  const code = new URLSearchParams(location.hash.slice(1)).get('code') || sessionStorage.getItem('ew-native-pair-code') || '';
  history.replaceState(null, '', '/native');
  if (!/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(code)) { $('status').textContent = 'Start sign-in from Unreal to get a fresh pairing code.'; return; }
  sessionStorage.setItem('ew-native-pair-code', code); $('code').textContent = code;
  const r = await fetch('/whoami', {cache:'no-store'});
  if (!r.ok) { $('status').textContent = 'Sign in with your usual Eidoverse Discord account, then approve here.';
    $('login').href = ${JSON.stringify(login).replace(/</g, "\\u003c")}; $('login').hidden = false; return; }
  const s = await r.json(); $('status').textContent = 'Signed in as ' + s.name; $('actions').hidden = false;
  for (const action of ['approve','deny']) $(action).onclick = async () => {
    $('approve').disabled = $('deny').disabled = true;
    try { const r = await fetch('/native/' + action, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user_code:code})});
      $('result').textContent = r.ok ? (action === 'approve' ? 'Approved. Return to Unreal and choose Join water.' : 'Denied. You can close this tab.') : 'Could not approve. The code may have expired or your account may lack world access. Start again in Unreal.';
      sessionStorage.removeItem('ew-native-pair-code');
    } catch { $('result').textContent = 'Network error. Start again in Unreal.'; }
  };
})().catch(() => { document.getElementById('status').textContent = 'Sign-in could not load. Start again in Unreal.'; });
</script></html>`, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    "x-frame-options": "DENY",
  } });
}

// server/reqbody.ts — a request body read under a byte cap (native-login, setup, /clientlog all read one).
/** The body as text, or null once it passes `cap` bytes (the rest is cancelled, never buffered). */
export async function readCapped(req: Request, cap: number): Promise<string | null> {
  const r = req.body?.getReader(); if (!r) return "";
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await r.read(); if (done) break;
    n += value.byteLength; if (n > cap) { await r.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

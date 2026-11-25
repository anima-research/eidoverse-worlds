// server/request-body.ts — a request body read under a byte cap; every body the server reads comes through here.
/** The body's bytes, or null once it passes `cap` bytes (the rest is cancelled, never buffered). */
export async function readCappedBytes(req: Request, cap: number): Promise<Uint8Array | null> {
  const r = req.body?.getReader(); if (!r) return new Uint8Array(0);
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await r.read(); if (done) break;
    n += value.byteLength; if (n > cap) { await r.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}
/** The body as text, or null once it passes `cap` bytes. */
export async function readCapped(req: Request, cap: number): Promise<string | null> {
  const b = await readCappedBytes(req, cap); return b === null ? null : new TextDecoder().decode(b);
}

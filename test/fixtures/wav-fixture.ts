// A real WAV for tests and probes: 8 kHz mono 16-bit PCM, `seconds` of a
// quiet 220 Hz tone. Pure bytes, no deps, no side effects on import.
export function wavBytes(seconds = 0.25, rate = 8000): Uint8Array {
  const n = Math.floor(seconds * rate); const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 6000), true);
  return new Uint8Array(buf);
}

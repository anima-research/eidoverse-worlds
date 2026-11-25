// wavpcm — WAV (PCM s16) → {pcm, sampleRate}. No imports, so it runs outside a browser.
// The sample rate is parsed, not assumed: a non-22050Hz voice would otherwise play at the wrong pitch.

export function decodeWavToPcm(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 12 || dv.getUint32(0, false) !== 0x52494646) throw new Error('not a WAV');
  let off = 12, sampleRate = 22050, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false), size = dv.getUint32(off + 4, true);
    if (id === 0x666d7420) sampleRate = dv.getUint32(off + 12, true);   // 'fmt '
    else if (id === 0x64617461) { dataOff = off + 8; dataLen = size; }  // 'data'
    off += 8 + size + (size & 1);   // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error('WAV has no data chunk');
  // slice(), not a view: the caller keeps these samples past the buffer's life.
  return { pcm: new Int16Array(arrayBuffer.slice(dataOff, dataOff + dataLen)), sampleRate };
}

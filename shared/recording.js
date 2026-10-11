// Presentation of stage archival status, outside the authored world fold.
// Only these fields are a snapshot: byte/rate counters belong to /recordings.

/** Each stop, in plain words, by its code (server/frame-archive.ts). */
export const STOP_WORDS = {
  'world-byte-limit': "this world's recordings reached their size limit",
  'segment-count-limit': "this world's recordings reached their file limit",
  'frame-exceeds-segment-limit': 'a stage frame was larger than a recording file may hold',
  'disk-floor': 'the server is low on disk space',
  'archive-io': "the server couldn't write the recording",
  'log-identity': "the server couldn't identify this world's log",
};

/** The three fields a client is told: state, stop code, performance. */
export function recordingSummaryOf(s) {
  if (!s || typeof s.state !== 'string') return null;
  return { state: s.state, ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
    ...(typeof s.performance === 'string' ? { performance: s.performance } : {}) };
}

export function recordingState(msg) {
  const s = recordingSummaryOf(msg.recordingStatus);
  if (s) return s;
  return typeof msg.recording === 'boolean' ? { state: msg.recording ? 'recording' : 'disabled' } : null;
}

export function recordingNotice(status) {
  if (status?.state === 'ready' || status?.state === 'recording')
    return '⏺ this performance is being recorded (movement + chat, for the archive)';
  if (status?.state === 'stopped')
    return 'Stage-frame recording stopped: ' + (STOP_WORDS[status.reason] ?? 'it is unavailable') +
      '. Movement since then is not recorded; world chat remains in the authored log.';
  return null;
}

/** When to say a notice again: once per (state, stop code, performance), so
 *  a repeated stop message or a reconnect into the same stop says nothing
 *  new. The browser and the MCPL agent both key on this. */
export function recordingNoticeKey(status) {
  return status ? JSON.stringify([status.state, status.reason ?? null, status.performance ?? null]) : null;
}

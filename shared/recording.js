// Presentation of stage archival status, outside the authored world fold.
// Only these fields are a snapshot: byte/rate counters belong to /recordings.
export function recordingState(msg) {
  const s = msg.recordingStatus;
  if (s && typeof s.state === 'string') {
    return { state: s.state, ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
      ...(typeof s.performance === 'string' ? { performance: s.performance } : {}) };
  }
  return typeof msg.recording === 'boolean' ? { state: msg.recording ? 'recording' : 'disabled' } : null;
}
export function recordingNotice(status) {
  if (status?.state === 'ready' || status?.state === 'recording')
    return '⏺ this performance is being recorded (movement + chat, for the archive)';
  if (status?.state === 'stopped')
    return 'Stage-frame recording stopped: ' + (status.reason ?? 'unavailable') + '. World chat remains in the authored log.';
  return null;
}

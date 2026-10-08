// serverclock — the server's clock, as this client estimates it: the ONE place a client reads "now" for anything the
// authority stamped (motion t0, sound t0, a seat's pose time). Frames carry the server's `t`; noteServerTime smooths the
// offset. Its own module (it was remotes.js's) so a small realizer (sounds.js) can read it without pulling the body code in.
let clockOffset = null;
export function noteServerTime(t) {
  if (typeof t !== 'number') return;
  const sample = t - performance.timeOrigin - performance.now();
  clockOffset = clockOffset === null ? sample : clockOffset * 0.92 + sample * 0.08;
}
export const serverNow = () => performance.timeOrigin + performance.now() + (clockOffset ?? 0);

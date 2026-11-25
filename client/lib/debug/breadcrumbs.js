// breadcrumbs — crash breadcrumbs (?bc=1), streamed over the live world socket: the server rings the last 40 per client and
// prints them when the socket dies — the one observer a renderer crash can't take down (same-origin tabs share the
// renderer, and a dying renderer's localStorage writes can be discarded). Dev-only.
// A leaf on purpose: imports net.js only. avatar.js reads globalThis.__ewBC rather than importing — keep it that way,
// or frame → avatar → frame closes a loop.

import { net } from '../net.js';

let _bcN = 0;
export const BC = new URLSearchParams(location.search).has('bc')
  ? (tag) => {
    try { net.ws?.readyState === 1 && net.ws.send(JSON.stringify({ type: 'bc', tag: `${++_bcN} ${tag}` })); } catch { /* dying */ }
  }
  : () => {};
globalThis.__ewBC = BC;

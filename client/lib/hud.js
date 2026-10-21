// hud — now the ∃ mark. The status BAR is gone:
// identity lives in Profile-to-be, fps lives in debug, the people list lives
// behind the ∃ menu and the rail. What survives here is what must be ambient:
// connection truth (mark dims + pulses when the socket is down) and the
// editing flag (warn dot). The mic/ear glyphs anchor themselves to this
// element's right edge (mictoggle.js) — inboard of the corner, per spec.
// Painted at 1Hz by the pulse system.

import { net } from './net.js';

export function paintHud() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  hud.classList.toggle('net-live', net.status === 'live');
  hud.classList.toggle('net-wait', net.status === 'connecting' || net.status === 'retrying');
  hud.title = net.status === 'live'
    ? 'eidoverse — menu'
    : `eidoverse — ${net.status}…`;
}

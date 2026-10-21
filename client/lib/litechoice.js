// litechoice — choosing the lite client or the full 3D world, as a person's own choice on this device. One place,
// because three presses make it (lite's ∃, the ∃ menu's Lite client, the desktop retry pill) and each got it a
// little differently wrong before (review of #212, 2026-10-02).
//
// The choice is SAVED (index.html decideLite rule 3), so the next plain visit honours it, and the URL is left
// CLEAN: a ?lite=0 kept in the address outranks the crash tripwire (rule 1 beats rule 2), so a phone the full
// world kills would reload into the same crash for as long as the address said so. Only where storage is blocked
// does the URL carry the choice, because then nothing else can.
//
// Choosing 3D also clears this world's tripwire: the person has just asked to try again, and a stale flag would
// bounce them straight back to lite. If the world kills the device again, the boot re-arms it and the next plain
// visit lands in lite: one crash, not a loop. No imports: lite.js (an entry point with no engine) uses this too.

export function chooseClient(lite) {
  const u = new URL(location.href);
  u.searchParams.delete('lite');
  let saved = false;
  try {
    localStorage.setItem('ew-lite', lite ? '1' : '0');
    saved = localStorage.getItem('ew-lite') === (lite ? '1' : '0');
    if (!lite) {
      const q = new URLSearchParams(location.search);
      localStorage.removeItem(globalThis.__ewTripKey?.(q) ?? 'ew-boot-attempt');
      localStorage.removeItem(globalThis.__ewRetryKey?.(q) ?? 'ew-boot-retried');   // a fresh try gets its own retry
    }
  } catch { /* storage blocked: the URL carries it below */ }
  if (!saved) u.searchParams.set('lite', lite ? '1' : '0');
  location.assign(u);
}

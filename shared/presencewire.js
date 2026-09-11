// Presence (present / away / busy) on the embodied plane, the same way the
// wing fold rides: one small field on the pose packet, no new message type,
// relayed by the server untouched and remembered for late joiners with the
// rest of the settled pose (a tester, 09-05: "broadcast that state so the Who panel
// can show it"). Shared by client and server so both agree on the vocabulary.
export const PRESENCE_STATES = ['present', 'away', 'busy'];

export function presenceWire(state) {
  return PRESENCE_STATES.includes(state) ? { presence: state } : {};
}

export function applyPresenceWire(target, sample) {
  if (!target || !sample || !PRESENCE_STATES.includes(sample.presence)) return false;
  target.presence = sample.presence;
  return true;
}

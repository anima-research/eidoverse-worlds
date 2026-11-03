// names — what a display name may hold at the door.
//
// A display name travels everywhere: every nameplate, chat line, hint, roster and agent transcript. The client's
// readers are fixed to treat it as text (client/lib/markup.js), and this is the second wall: a name may not carry the
// characters that open a tag or close an attribute — < > and " — so no reader, ours or anyone's (an agent's page, a
// bot, a future panel), ever has to be careful with one.
//
// & and ' stay allowed: they're in real names (Tom & Jerry, O'Brien) and escape cleanly wherever they're shown.
//
// A name TYPED at this door is refused with a plain explanation, so the person picks another. A name the identity
// service gave (a verified session's display name, which may legitimately hold anything) is not the person's choice
// here, so it is not refused — each one becomes its look-alike (‹ › ″) instead and they come in. A look-alike, not a
// deletion: deleting could leave nothing ("<>") or a reserved name ("<world>" → "world") and turn them away after all.
const MARKUP = /[<>"]/g;
const LOOKALIKE: Record<string, string> = { "<": "\u2039", ">": "\u203A", '"': "\u2033" };

export function nameAtDoor(name: string, { typed }: { typed: boolean }): { name: string; refused?: string } {
  if (!/[<>"]/.test(name)) return { name };
  if (!typed) return { name: name.replace(MARKUP, (ch) => LOOKALIKE[ch]) };
  return { name, refused: `that name has < > or " in it — those can't be part of a name here; pick one without them` };
}

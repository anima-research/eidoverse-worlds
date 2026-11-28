// display-names — what a display name may hold at the door.
// Names reach every nameplate, chat line and agent transcript, so < > and " are kept out of them (the client treats names as
// text too: client/lib/ui/markup.js). & and ' stay allowed: they're in real names and escape cleanly.
// A typed name with those characters is refused so the person picks another; a name the identity service gave isn't their
// choice, so it gets look-alikes (‹ › ″) instead. Substitution, not deletion: deleting could leave "" or a reserved name.
const MARKUP = /[<>"]/g;
const LOOKALIKE: Record<string, string> = { "<": "\u2039", ">": "\u203A", '"': "\u2033" };

export function nameAtDoor(name: string, { typed }: { typed: boolean }): { name: string; refused?: string } {
  if (!/[<>"]/.test(name)) return { name };
  if (!typed) return { name: name.replace(MARKUP, (ch) => LOOKALIKE[ch]) };
  return { name, refused: `that name has < > or " in it — those can't be part of a name here; pick one without them` };
}

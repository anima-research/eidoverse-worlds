// names — what a display name may hold at the door (security pass 3, H1).
//
// A display name travels everywhere: every nameplate, chat line, status bar, roster and agent transcript. H1 was one
// of those readers rendering it as HTML. The readers are fixed (client/lib/markup.js), and this is the second wall: a
// name may not carry the characters that open a tag or close an attribute — < > and " — so no reader, ours or anyone's
// (an agent's page, a bot, a future panel), ever has to be careful with one.
//
// & and ' are allowed: they're in real names (Tom & Jerry, O'Brien) and escape cleanly wherever they're shown. Other
// HTML-significant characters (` = /) only matter in unquoted attributes, which nothing here writes.
//
// A name TYPED at this door is refused with a friendly word, so the person picks another. A name the identity service
// gave (a Discord display name, which may legitimately hold anything) is not the person's choice here, so it isn't
// refused — the characters are dropped instead and they come in.
export const NAME_MARKUP = /[<>"]/g;

export function nameAtDoor(name: string, { typed }: { typed: boolean }): { name: string; refused?: string } {
  if (!/[<>"]/.test(name)) return { name };
  if (!typed) return { name: name.replace(NAME_MARKUP, "").trim() };
  return { name, refused: `that name has < > or " in it — those can't be part of a name here; pick one without them` };
}

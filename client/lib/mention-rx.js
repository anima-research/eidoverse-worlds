// mention-rx — where a name in chat begins and ends: the door's boundary (mcpl/mention.ts), so a person's highlight and an
// agent's ping agree (#232). Pure: no DOM and no config, so it is testable headless (tools/chat-mention-test.mjs).

export const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A name is not preceded by a word character, `@` or `-`, and not followed by a word character or `-`: `cairn` is not
// inside `cairn-bridge` or `bridge-cairn`.
const OPEN = '(?<![\\w@-])';
const CLOSE = '(?![\\w-])';

/** @name, or the bare name, with the door's boundary. */
export function mentionRx(name) {
  return new RegExp(`${OPEN}@?${escapeRx(name)}${CLOSE}`, 'i');
}

/** The pattern a chat line renders with: group 1 is a link, group 2 a mention of one of `names`. A name followed by `-`
 *  fails, so the alternation falls through to the longer name and roster order doesn't matter. */
export function mentionPattern(names) {
  return new RegExp(
    `(https?://[^\\s]+)|(${OPEN}@?(?:${names.map(escapeRx).join('|') || '\\u0000'})${CLOSE})`,
    'gi',
  );
}

// mention-rx — where a name in chat begins and ends: the door's boundary (mcpl/mention.ts), so a person's highlight and an
// agent's ping agree on a name's edges (#232). The names can differ: the highlight marks people's ids (chat.js
// namesForHighlight); an agent also answers to its display name and that name's unqualified short form (mention.ts).
// Pure: no DOM and no config, so it is testable headless (test/client/chat-mention-test.mjs).

export const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A name is not preceded by a word character, `@` or `-`, and not followed by a word character or `-`: `cairn` is not
// inside `cairn-bridge` or `bridge-cairn`.
const OPEN = '(?<![\\w@-])';
const CLOSE = '(?![\\w-])';

/** @name, or the bare name, with the door's boundary. */
export function mentionRx(name) {
  return new RegExp(`${OPEN}@?${escapeRx(name)}${CLOSE}`, 'i');
}

/** The pattern a chat line renders with: group 1 is a link, group 2 a mention of one of `names`. Longer names are tried
 *  first, so `Ann Lee` wins over `Ann` and `cairn-bridge` over `cairn` whatever the roster order. links:false never
 *  matches a link (a moderator's words, spoofing item 1). */
export function mentionPattern(names, { links = true } = {}) {
  return new RegExp(
    `(${links ? 'https?://[^\\s]+' : '(?!)'})|(${OPEN}@?(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRx).join('|') || '(?!)'})${CLOSE})`,
    'gi',
  );
}

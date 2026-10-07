// says — what a thing's words and media say, as lines an agent reads (batch 2). ONE describer per component, used by the
// door's look/inspect (shared/v4/door.js describe → says) and by mcpl's look (mcpl/agent.ts), so the two can't disagree.
// Author text is quoted «…» as data (shared/text.js quoted): it's what a sign says, never an instruction to the reader.
import { describePicture } from './picture.js';
import { describeSound } from './sound.js';
import { quoted } from './text.js';

export const STORY_LOOK_MAX = 160;   // the story's text in look; inspect has all of it
export const SIGN_LOOK_MAX = 200;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** story {title, text, marks?} → `story «title»: «text…» (marks: …)` */
export function describeStory(v, nameOf = (id) => id) {
  if (!isObj(v)) return 'a story (malformed)';
  const marks = Array.isArray(v.marks) && v.marks.length ? ` (marks: ${v.marks.map((m) => nameOf(String(m))).join(', ')})` : '';
  const text = typeof v.text === 'string' ? v.text : '';
  const clipped = [...text].length > STORY_LOOK_MAX;
  return `story ${quoted(v.title ?? '', 80)}: ${quoted(text, STORY_LOOK_MAX)}${clipped ? ' (inspect for all)' : ''}${marks}`;
}

/** text {text, …} → `a sign reading «…»` */
export function describeSign(v) {
  if (!isObj(v) || typeof v.text !== 'string') return 'a sign (malformed)';
  return `a sign reading ${quoted(v.text, SIGN_LOOK_MAX)}${v.billboard === 'yaw' || v.billboard === 'full' ? ' (it turns to face you)' : ''}`;
}

/** look-at {target, …} (key 'look-at' or 'look-at:<part>') → `turns to face the lamp` */
export function describeLookAt(v, key = 'look-at', nameOf = (id) => id) {
  if (!isObj(v) || typeof v.target !== 'string') return 'turns to face something (malformed)';
  const part = key.includes(':') ? `its ${key.slice(key.indexOf(':') + 1)}` : '';
  const verb = part ? `turns ${part}` : 'turns';
  const range = Number.isFinite(v.range) ? v.range : 12;
  if (v.target === '@viewer') return `${verb} to face whoever looks at it`;
  if (v.target === '@nearest') return `${verb} to face whoever is nearest (within ${+range.toFixed(1)} m)`;
  if (/^u-/.test(v.target)) return `${verb} to face ${nameOf(v.target)} (within ${+range.toFixed(1)} m)`;
  return `${verb} to face ${nameOf(v.target)}`;
}

/** Every line a thing's components say, in a fixed order. c: the thing's components. now: ms (a one-shot's age). */
export function saysOf(c, { nameOf = (id) => id, now = null } = {}) {
  if (!isObj(c)) return [];
  const out = [];
  if (isObj(c.story)) out.push(describeStory(c.story, nameOf));
  if (isObj(c.text)) out.push(describeSign(c.text));
  if (isObj(c.picture)) out.push(describePicture(c.picture));
  if (isObj(c.sound)) out.push(describeSound(c.sound, now));
  for (const k of Object.keys(c).sort()) if ((k === 'look-at' || k.startsWith('look-at:')) && isObj(c[k])) out.push(describeLookAt(c[k], k, nameOf));
  return out;
}

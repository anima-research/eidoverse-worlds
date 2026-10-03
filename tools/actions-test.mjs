// actions — the action registry's ranking and merge contract, against the REAL module.
//
//   bun tools/actions-test.mjs
//
// client/lib/actions.js is pure (no imports, no DOM), so this runs with nothing stubbed. What it pins:
// the tier order the lantern prompt depends on (exact > prefix > key > word-start > substring >
// subsequence), that keywords count but a notch under the title, that `when` hides, that a second
// registration of an id MERGES (the key table adds a key to the dock's entry), and that grouping keeps
// the best row first.
import * as A from '../client/lib/actions.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : '  ' + extra}`);
  ok ? pass++ : fail++;
};
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
const noop = () => {};
const ids = (q) => A.list(q).map((r) => r.action.id);

A.clear();
A.register({ id: 'emote:wave', title: 'wave', group: 'emotes', key: '4', run: noop });
A.register({ id: 'section:world:sky', title: 'sky', keywords: ['world', 'weather'], group: 'world', run: noop });
A.register({ id: 'key:screenshot', title: 'save a screenshot', keywords: ['picture'], group: 'view', key: 'F2', run: noop });
A.register({ id: 'cmd:who', title: '/who — list everyone present', keywords: ['who'], group: 'commands', run: noop });
A.register({ id: 'voice:mic', title: 'microphone on / off', keywords: ['mute', 'talk', 'speak'], group: 'voice', key: 'V', run: noop });
A.register({ id: 'panel:settings', title: 'settings', group: 'panels', run: noop });
A.register({ id: 'section:settings:audio', title: 'audio', keywords: ['settings', 'sound'], group: 'settings', run: noop });
A.register({ id: 'body:skydive', title: 'skydive', group: 'body', run: noop });

console.log('ranking tiers');
check('exact title wins: "wave" → emote:wave first', ids('wave')[0] === 'emote:wave', ids('wave').join());
check('exact beats a longer prefix: "sky" → sky before skydive', ids('sky')[0] === 'section:world:sky' && ids('sky')[1] === 'body:skydive', ids('sky').join());
check('prefix: "sk" finds sky first (shorter completion ranks higher)', ids('sk')[0] === 'section:world:sky', ids('sk').join());
A.register({ id: 'key:micpin', title: 'pin the mic glyph', group: 'voice', run: noop });
check('prefix beats word-start: "mic" → "microphone…" (prefix) before "pin the mic glyph" (word-start)',
  ids('mic')[0] === 'voice:mic' && A.score('mic', A.get('voice:mic')) > A.score('mic', A.get('key:micpin')) && A.score('mic', A.get('key:micpin')) === 700,
  `${ids('mic').join()} ${A.score('mic', A.get('voice:mic'))} vs ${A.score('mic', A.get('key:micpin'))}`);
check('word-start beats subsequence: "list" → cmd:who (word "list") over nothing weaker',
  A.score('list', A.get('cmd:who')) === 700, String(A.score('list', A.get('cmd:who'))));
check('word-start > substring: "shot" is a substring of "screenshot" (400) and not a word-start',
  A.score('shot', A.get('key:screenshot')) === 400, String(A.score('shot', A.get('key:screenshot'))));
check('subsequence still matches but ranks lowest: "scrnsht" → screenshot, 100..199',
  (() => { const s = A.score('scrnsht', A.get('key:screenshot')); return s >= 100 && s < 200; })(), String(A.score('scrnsht', A.get('key:screenshot'))));
check('a tighter subsequence scores higher than a looser one ("mcro" vs "mne" in microphone)',
  (() => { const t = A.score('mcro', A.get('voice:mic')), l = A.score('mne', A.get('voice:mic')); return t > l && l >= 100 && t < 200; })(),
  `${A.score('mcro', A.get('voice:mic'))} vs ${A.score('mne', A.get('voice:mic'))}`);
check('no match → 0 and not listed ("zzqx")', ids('zzqx').length === 0);
check('one stray letter is not a match inside a word ("h" is in "screenshot", not at a word start)',
  A.score('h', A.get('key:screenshot')) === 0, String(A.score('h', A.get('key:screenshot'))));
check('…but one letter still finds a title or word that starts with it ("s" → screenshot)', A.score('s', A.get('key:screenshot')) >= 700);
check('the prefix length penalty is real: "sk" scores sky above skydive (not just the shorter-title tie-break)',
  A.score('sk', A.get('section:world:sky')) > A.score('sk', A.get('body:skydive')),
  `${A.score('sk', A.get('section:world:sky'))} vs ${A.score('sk', A.get('body:skydive'))}`);
A.register({ id: 'tmp:long', title: 'volume of everything around you, every voice and every sound at once', group: 'voice', run: noop });
check('a long title prefix still outranks a key ("v": the long title over the mic\'s V)',
  A.score('v', A.get('tmp:long')) > A.score('v', A.get('voice:mic')),
  `${A.score('v', A.get('tmp:long'))} vs ${A.score('v', A.get('voice:mic'))}`);
A.unregister('tmp:long');

console.log('keywords and keys');
check('a keyword finds it: "mute" → voice:mic first', ids('mute')[0] === 'voice:mic', ids('mute').join());
check('a keyword counts a tier under the same match on a title (exact keyword = 900)', A.score('mute', A.get('voice:mic')) === 900);
check('STRONG: exact keyword, title prefix and key are strong; a keyword prefix is not ("mu")',
  A.score('mute', A.get('voice:mic')) >= A.STRONG && A.score('sk', A.get('section:world:sky')) >= A.STRONG
  && A.score('f2', A.get('key:screenshot')) >= A.STRONG && A.score('mu', A.get('voice:mic')) < A.STRONG,
  `mu=${A.score('mu', A.get('voice:mic'))}`);
check('a keyword SUBSEQUENCE is not a match ("sk" is in "speak" only as s…k): the mic stays out of "sk"',
  A.score('sk', A.get('voice:mic')) === 0, String(A.score('sk', A.get('voice:mic'))));
check('a keyword SUBSTRING is not a match either ("ute" inside "mute")', A.score('ute', A.get('voice:mic')) === 0);
check('the key finds it: "f2" → screenshot', ids('f2')[0] === 'key:screenshot', ids('f2').join());
check('"audio" (title) outranks "settings" matched only as a keyword for query "settings": panel first',
  ids('settings')[0] === 'panel:settings' && ids('settings').includes('section:settings:audio'), ids('settings').join());
check('multi-word: "list every" → cmd:who via every word starting a word', A.score('list every', A.get('cmd:who')) >= 650);

console.log('when / merge / run');
let gate = false, ran = 0;
A.register({ id: 'panel:edit', title: 'edit mode', group: 'panels', when: () => gate, run: () => ran++ });
check('when() false hides it from list', !ids('edit').includes('panel:edit'));
check('when() false: run() refuses', A.run('panel:edit') === false && ran === 0);
gate = true;
check('when() true lists it', ids('edit')[0] === 'panel:edit');
A.register({ id: 'panel:edit', key: 'B', keywords: ['build'] });
const merged = A.get('panel:edit');
check('re-register MERGES: key added, title + run kept', merged.key === 'B' && merged.title === 'edit mode' && A.run('panel:edit') && ran === 1);
check('merged keywords are searchable ("build")', ids('build')[0] === 'panel:edit');
const off = A.register({ id: 'tmp', title: 'temporary', run: noop });
off();
check('the returned unregister removes it', A.get('tmp') === null);
let threw = false; try { A.register({ id: 'bad', title: 'no run' }); } catch { threw = true; }
check('a new id without run or fill is refused', threw);
A.register({ id: 'cmd:w', title: '/w <name> <message>', fill: '/w ', group: 'commands' });
check('fill-only actions register (a command that needs an argument)', A.get('cmd:w')?.fill === '/w ');
const throwingWhen = A.register({ id: 'boom', title: 'boom', when: () => { throw new Error('x'); }, run: noop });
check('a throwing when() hides rather than breaking the list', !ids('boom').includes('boom') && ids('wave').length > 0);
throwingWhen();

console.log('grouping');
A.register({ id: 'emote:wave2', title: 'wave hello', group: 'emotes', run: noop });
A.register({ id: 'cmd:wavefile', title: '/wavefile', group: 'commands', run: noop });
const g = A.grouped(A.list('wave'));
check('grouped: the best row stays first (emotes group first, wave first in it)', g[0].group === 'emotes' && g[0].rows[0].action.id === 'emote:wave', JSON.stringify(g.map((x) => [x.group, x.rows.map((r) => r.action.id)])));
check('grouped: each group appears once', new Set(g.map((x) => x.group)).size === g.length);
check('empty query lists everything visible', A.list('').length === A.all().filter((a) => !a.when || a.when()).length);

done();

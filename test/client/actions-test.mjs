// actions — the action registry's ranking and merge contract, against the REAL module.
//
//   bun test/client/actions-test.mjs
//
// client/lib/ui/actions.js is pure (no imports, no DOM), so this runs with nothing stubbed. What it pins:
// the tier order the lantern prompt depends on (exact > prefix > key > word-start > substring >
// subsequence), that keywords count but a notch under the title, that `when` hides, that a second
// registration of an id MERGES (the key table adds a key to the dock's entry), and that grouping keeps
// the best row first.
import * as A from '../../client/lib/ui/actions.js';
import { suite } from "../gate/suite.ts";

const S = suite("actions");
const check = (name, ok, extra) => S.check(name, ok, extra);
const done = () => { S.done(); };
const noop = () => {};
const ids = (q) => A.list(q).map((r) => r.action.id);

A.clear();
A.register({ id: 'bar:wave', title: 'wave', group: 'action bar', key: '4', run: noop });
A.register({ id: 'section:world:sky', title: 'sky', keywords: ['world', 'weather'], group: 'world', run: noop });
A.register({ id: 'key:screenshot', title: 'save a screenshot', keywords: ['picture'], group: 'view', key: 'F2', run: noop });
A.register({ id: 'cmd:who', title: '/who — list everyone present', keywords: ['who'], group: 'commands', run: noop });
A.register({ id: 'voice:mic', title: 'microphone on / off', keywords: ['mute', 'talk', 'speak'], group: 'voice', key: 'V', run: noop });
A.register({ id: 'panel:settings', title: 'settings', group: 'panels', run: noop });
A.register({ id: 'section:settings:audio', title: 'audio', keywords: ['settings', 'sound'], group: 'settings', run: noop });
A.register({ id: 'body:skydive', title: 'skydive', group: 'body', run: noop });

console.log('ranking tiers');
// every tier, generated against one synthetic title, then the same queries against it as a keyword: each band, every
// adjacent pair strictly ordered, and a keyword a notch (-100) under the title from word-start up (below: no match)
const T = 'alpha bravo charlie';
const TIERS = [
  ['exact', T, 1000, 1000], ['prefix', 'alpha br', 851, 899], ['key', 'k9', 850, 850], ['word-start', 'bra', 700, 700],
  ['all-words', 'bra cha', 650, 650], ['substring', 'lph', 400, 400], ['subsequence', 'acr', 100, 199], ['none', 'zzqx', 0, 0],
];
A.register({ id: 'tier:title', title: T, key: 'K9', run: noop }); A.register({ id: 'tier:kw', title: 'qq', keywords: [T], run: noop });
const tierScores = TIERS.map(([kind, q, lo, hi]) => {
  const s = A.score(q, A.get('tier:title')), k = A.score(q, A.get('tier:kw')), want = lo >= 650 ? s - 100 : 0;
  check(`${kind}: "${q}" scores ${lo}..${hi}; as a keyword ${want ? 'a notch under' : 'no match'}`, s >= lo && s <= hi && (kind === 'key' || k === want), `${s} / keyword ${k}`);
  return s;
});
TIERS.slice(1).forEach(([kind], i) => check(`${TIERS[i][0]} > ${kind}`, tierScores[i] > tierScores[i + 1], `${tierScores[i]} vs ${tierScores[i + 1]}`));
A.unregister('tier:title'); A.unregister('tier:kw');
check('no match is not listed ("zzqx")', ids('zzqx').length === 0);
check('one stray letter is not a match inside a word ("h" is in "screenshot", not at a word start)',
  A.score('h', A.get('key:screenshot')) === 0, String(A.score('h', A.get('key:screenshot'))));
check('…but one letter still finds a title or word that starts with it ("s" → screenshot)', A.score('s', A.get('key:screenshot')) >= 700);
check('the prefix length penalty is real: "sk" scores sky above skydive, and lists it first',
  A.score('sk', A.get('section:world:sky')) > A.score('sk', A.get('body:skydive')) && ids('sk')[0] === 'section:world:sky',
  `${A.score('sk', A.get('section:world:sky'))} vs ${A.score('sk', A.get('body:skydive'))}`);
check('a tighter subsequence scores higher than a looser one ("mcro" vs "mne" in microphone)',
  (() => { const t = A.score('mcro', A.get('voice:mic')), l = A.score('mne', A.get('voice:mic')); return t > l && l >= 100 && t < 200; })(),
  `${A.score('mcro', A.get('voice:mic'))} vs ${A.score('mne', A.get('voice:mic'))}`);
A.register({ id: 'tmp:long', title: 'volume of everything around you, every voice and every sound at once', group: 'voice', run: noop });
check('a long title prefix still outranks a key ("v": the long title over the mic\'s V)',
  A.score('v', A.get('tmp:long')) > A.score('v', A.get('voice:mic')),
  `${A.score('v', A.get('tmp:long'))} vs ${A.score('v', A.get('voice:mic'))}`);
A.unregister('tmp:long');

console.log('keywords and keys');
check('a keyword finds it: "mute" → voice:mic first', ids('mute')[0] === 'voice:mic', ids('mute').join());
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
A.register({ id: 'panel:edit', title: 'build mode', group: 'panels', when: () => gate, run: () => ran++ });
check('when() false hides it from list', !ids('build').includes('panel:edit'));
check('when() false: run() refuses', A.run('panel:edit') === false && ran === 0);
gate = true;
check('when() true lists it', ids('build')[0] === 'panel:edit');
A.register({ id: 'panel:edit', key: 'B', keywords: ['build'] });
const merged = A.get('panel:edit');
check('re-register MERGES: key added, title + run kept', merged.key === 'B' && merged.title === 'build mode' && A.run('panel:edit') && ran === 1);
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
A.register({ id: 'bar:wave2', title: 'wave hello', group: 'action bar', run: noop });
A.register({ id: 'cmd:wavefile', title: '/wavefile', group: 'commands', run: noop });
const g = A.grouped(A.list('wave'));
check('grouped: the best row stays first (gestures group first, wave first in it)', g[0].group === 'action bar' && g[0].rows[0].action.id === 'bar:wave', JSON.stringify(g.map((x) => [x.group, x.rows.map((r) => r.action.id)])));
check('grouped: each group appears once', new Set(g.map((x) => x.group)).size === g.length);
check('empty query lists everything visible', A.list('').length === A.all().filter((a) => !a.when || a.when()).length);

done();

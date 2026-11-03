// spoken-form — what the larynx gets. Table-driven, executable.
import { spokenForm, ttsChunks } from '../client/lib/tts-chunk.js';
let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
};
t('fenced code never speaks', spokenForm('before ```js\nconst x = 1;\n``` after'), 'before after');
t('unterminated fence drops to end', spokenForm('look: ```raw dump of everything'), 'look:');
t('bare URL becomes link', spokenForm('grab https://a-b.trycloudflare.com/?k=v&x=1 now'), 'grab link now');
t('markdown link keeps its label', spokenForm('see [the runbook](https://x.y/z) here'), 'see the runbook here');
t('world:staging pauses instead of naming the colon', spokenForm('join world:staging'), 'join world, staging');
t('times keep their colon', spokenForm('at 6:04 sharp'), 'at 6:04 sharp');
t('arrows become pauses', spokenForm('a -> b => c'), 'a , b , c');
t('bullets become pauses', spokenForm('x · y • z'), 'x , y , z');
t('emphasis + emoji still stripped', spokenForm('*hello* 🌒 **there**'), 'hello there');
t('spaced colon untouched (prosodic already)', spokenForm('one thing: the gate'), 'one thing: the gate');
// end-to-end: chunks of a fenced-only message = nothing to say
t('fence-only utterance is silent', JSON.stringify(ttsChunks('```\nlogs\n```')), '[]');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

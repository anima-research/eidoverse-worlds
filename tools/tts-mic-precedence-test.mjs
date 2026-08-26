// The row must SAY that a live mic outranks TTS, and must not claim otherwise.
let micOn = false, ttsEnabled = false, avail = false, busy = null, loadingId = null, needVoice = false;
const voiceName = () => 'hesperus-clockwork';
const headNote = () => {
  if (busy) return busy;
  if (loadingId) return `loading…`;
  if (micOn) return 'not available while your mic is on';
  if (needVoice) return 'add a voice with one of the options below';
  const live = avail && ttsEnabled;
  return live ? voiceName() : avail ? 'ready' : '';
};
const headDimmed = () => !(avail && ttsEnabled) || micOn;

const cases = [
  ['fresh, no voice',        {},                                     '',                                  true ],
  ['voice loaded, tts off',  {avail:1},                              'ready',                             true ],
  ['tts on, mic off',        {avail:1, ttsEnabled:1},                'hesperus-clockwork',                false],
  ['tts on, MIC ON',         {avail:1, ttsEnabled:1, micOn:1},       'not available while your mic is on', true ],
  ['loading beats mic note', {avail:1, ttsEnabled:1, micOn:1, loadingId:'x'}, 'loading…',                  true ],
];
let pass = true;
for (const [name, st, wantNote, wantDim] of cases) {
  ({ micOn = false, ttsEnabled = false, avail = false, busy = null, loadingId = null, needVoice = false } = st);
  micOn = !!st.micOn; ttsEnabled = !!st.ttsEnabled; avail = !!st.avail;
  const n = headNote(), d = headDimmed();
  const ok = n === wantNote && d === wantDim;
  pass = pass && ok;
  console.log(`${ok?'ok  ':'FAIL'} ${name.padEnd(24)} note="${n}" dim=${d}`);
}
console.log(pass ? 'PASS — a live mic is stated, not silently obeyed' : 'FAIL');

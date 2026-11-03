// A component styling a host it does not own must ADD its class, never seize
// the attribute — the caller's marker has to survive.
const mkEl = () => {
  const set = new Set();
  return { set _className(v){ set.clear(); v.split(/\s+/).forEach(c=>c&&set.add(c)); },
           get className(){ return [...set].join(' '); },
           classList: { add:(c)=>set.add(c), contains:(c)=>set.has(c) },
           has:(c)=>set.has(c) };
};
// ttsrow marks the host so it can find it later
const before = mkEl(); before.classList.add('tts-list');
const after  = mkEl(); after.classList.add('tts-list');

// OLD behaviour: className = 'vl'  (the bug)
before._className = 'vl';
// NEW behaviour: classList.add('vl')
after.classList.add('vl');

console.log(`old: className='${before.className}'  tts-list survives: ${before.has('tts-list')}`);
console.log(`new: className='${after.className}'  tts-list survives: ${after.has('tts-list')}`);
console.log(!before.has('tts-list') && after.has('tts-list') && after.has('vl')
  ? 'PASS — the overwrite loses the caller\'s marker; classList.add keeps both'
  : 'FAIL');

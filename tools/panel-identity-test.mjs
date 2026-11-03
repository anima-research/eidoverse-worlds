// The panel must not DESTROY nodes on a state change. Identity is the test:
// the same element object must still be there afterwards.
let destroyed = 0;
const mkNode = (cls) => ({ className: cls, style:{}, textContent:'', checked:false,
  children: [], _id: Symbol(cls) });

function mkHost() {
  const nodes = { label: mkNode('sp-label'), box: mkNode('checkbox'),
                  note: mkNode('sp-note'), list: mkNode('tts-list') };
  return {
    nodes, firstChild: null,
    set textContent(v) { if (v === '') { destroyed++; this.firstChild = null; } },
    get textContent() { return ''; },
    querySelector: (sel) => ({ '.sp-label': nodes.label, 'input[type=checkbox]': nodes.box,
                               '.sp-note': nodes.note, '.tts-list': nodes.list }[sel] ?? null),
  };
}

const host = mkHost();
let ttsEnabled = false;
function syncInPlace() {
  const l = host.querySelector('.sp-label'), b = host.querySelector('input[type=checkbox]');
  const n = host.querySelector('.sp-note'), li = host.querySelector('.tts-list');
  if (!l || !b || !n || !li) return false;
  l.style.opacity = ttsEnabled ? '1' : '.45';
  if (b.checked !== ttsEnabled) b.checked = ttsEnabled;
  n.textContent = ttsEnabled ? 'a voice' : 'ready';
  return true;
}
function build() {
  if (host.firstChild && syncInPlace()) return;
  host.textContent = '';           // the destructive path
  host.firstChild = host.nodes.label;
}

build();                                  // first paint: real construction
const labelBefore = host.nodes.label._id;
const afterFirst = destroyed;

for (let i = 0; i < 10; i++) { ttsEnabled = !ttsEnabled; build(); }   // 10 state changes

console.log(`destroys during first paint: ${afterFirst} (expected 1)`);
console.log(`destroys during 10 state changes: ${destroyed - afterFirst} (expected 0)`);
console.log(`label is the SAME node: ${host.nodes.label._id === labelBefore}`);
console.log(`state reached the DOM: opacity=${host.nodes.label.style.opacity} checked=${host.nodes.box.checked}`);
console.log(destroyed - afterFirst === 0 && host.nodes.label._id === labelBefore
  ? 'PASS — state changes update in place, nothing is destroyed'
  : 'FAIL — the panel is still tearing down');

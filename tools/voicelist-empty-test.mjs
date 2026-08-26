// An empty list is a steady state, not a failure — and must be distinguishable
// from "rows exist but carry no data-id", which IS a markup bug.
function sync(host, { items, loading }) {
  const rows = host.rows;
  let why = null;
  const no = (w) => { why = `rebuilt: ${w}`; return false; };
  if (!rows.length && !items.length) {
    why = 'in place (empty list)';
    return !!host.hasPane;
  }
  if (!rows.length) return no(`no data-id rows, but ${items.length} item(s) expected`);
  why = 'in place';
  return true;
}
const cases = [
  ['empty list, already painted', {rows:[], hasPane:true},  {items:[]},        true ],
  ['empty list, first paint',     {rows:[], hasPane:false}, {items:[]},        false],
  ['3 voices rendered',           {rows:['a','b','c'], hasPane:true}, {items:[{id:'a'},{id:'b'},{id:'c'}]}, true],
  ['voices expected, none found', {rows:[], hasPane:true},  {items:[{id:'a'}]}, false],
];
let pass = true;
for (const [name, host, args, want] of cases) {
  const got = sync(host, args);
  const ok = got === want;
  pass = pass && ok;
  console.log(`${ok?'ok  ':'FAIL'} ${name.padEnd(30)} → inPlace=${got} (want ${want})`);
}
console.log(pass ? 'PASS — empty is a steady state; missing rows still reported'
                 : 'FAIL');

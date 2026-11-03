// Selecting a different voice must update marks in place, not rebuild rows.
const mkMark = () => { const c = new Set();
  return { classList: { toggle:(n,on)=>on?c.add(n):c.delete(n), contains:(n)=>c.has(n) },
           setAttribute(){}, _cls:c }; };
const mkRow = (id) => { const mark = mkMark();
  return { dataset:{id}, _mark:mark, _id:Symbol(id),
           querySelector:(s)=> s === '.vl-radio' ? mark : null }; };
function mkHost(ids, {loadingRow=false}={}) {
  const rows = ids.map(mkRow);
  return { rows, wiped:0,
    set textContent(v){ if(v==='') this.wiped++; }, get textContent(){return '';},
    querySelectorAll:(s)=> s === '.vl-row[data-id]' ? rows : [],
    querySelector:(s)=> s === '.vl-loading' ? (loadingRow?{}:null) : null };
}
function syncSelection(host,{items,selected,loading}) {
  const rows = host.querySelectorAll?.('.vl-row[data-id]');
  if (!rows || !rows.length) return false;
  const want = items.map(i=>i.id);
  if (rows.length !== want.length) return false;
  for (let i=0;i<rows.length;i++) if (rows[i].dataset.id !== want[i]) return false;
  if (!!host.querySelector('.vl-loading') !== !!loading) return false;
  for (const row of rows) {
    const on = row.dataset.id === selected;
    const mark = row.querySelector('.vl-radio');
    if (!mark) return false;
    mark.classList.toggle('on', on);
    mark.setAttribute('aria-checked', on?'true':'false');
  }
  return true;
}
const items = [{id:'a'},{id:'b'},{id:'c'}];

// 1. same membership, different selection → in place
const h = mkHost(['a','b','c']);
const before = h.rows.map(r=>r._id);
const ok1 = syncSelection(h,{items,selected:'b'});
console.log(`select b   → inPlace=${ok1} wiped=${h.wiped} b.on=${h.rows[1]._mark._cls.has('on')} a.on=${h.rows[0]._mark._cls.has('on')}`);
const same = h.rows.every((r,i)=>r._id===before[i]);

// 2. membership CHANGED → must refuse so the caller rebuilds
const h2 = mkHost(['a','b']);
const ok2 = syncSelection(h2,{items,selected:'a'});
console.log(`added voice → inPlace=${ok2} (want false)`);

// 3. a loading row appearing is structural → refuse
const h3 = mkHost(['a','b','c']);
const ok3 = syncSelection(h3,{items,selected:'a',loading:{id:'a'}});
console.log(`loading row → inPlace=${ok3} (want false)`);

console.log(ok1 && same && h.wiped===0 && !ok2 && !ok3
  ? 'PASS — selection updates in place; structural change still rebuilds'
  : 'FAIL');

import {strict as a} from 'node:assert';
import {objectIdentity,readLabel,visibleLabels} from '../shared/label.js';
import {emptyState,foldEntry} from '../shared/fold.js';
const st=emptyState();
const emit=(verb,args)=>foldEntry(st,{verb,args,seq:1,ts:0,actor:'test'});
emit('spawn',{id:'thing',lib:'models/old_name.glb',pos:[0,0,0]});
emit('asset',{path:'models/old_name.glb',name:'Catalog name'});
a.equal(objectIdentity(st.entities.thing,st.assets).name,'Catalog name');
emit('comp',{id:'thing',type:'label',data:{name:'  🌍 <b>Hello</b>  ',description:'Details',visibility:'inspect'}});
a.equal(objectIdentity(st.entities.thing,st.assets).name,'🌍 <b>Hello</b>');
a.equal(objectIdentity(JSON.parse(JSON.stringify(st)).entities.thing,st.assets).name,'🌍 <b>Hello</b>');
emit('comp',{id:'thing',type:'label',data:null});
a.equal(objectIdentity(st.entities.thing,st.assets).name,'Catalog name');
a.equal(objectIdentity(st.entities.thing).name,'old name');
a.equal(readLabel({offset:[0,Infinity,0],name:32}).offset,null);
a.equal(readLabel({name:'🌍'.repeat(130)}).name.length,240);
a.equal(readLabel({visibility:'wat'}).visibility,'nearby');
const dense=Array.from({length:10000},(_,id)=>({id:String(id),authored:true,inView:true,distance:id/1000,visibility:'nearby'}));
a.equal(visibleLabels(dense,'nearby',null).length,32);
a.equal(visibleLabels(dense,'off',null).length,0);
a.equal(visibleLabels([{...dense[0],authored:false}],'all',null).length,0);
a.equal(visibleLabels([{...dense[0],visibility:'inspect'}],'nearby',null).length,0);
a.equal(visibleLabels(dense,'nearby','9999')[0].id,'9999');
a.equal(visibleLabels([{...dense[0],visibility:'inspect'}],'nearby',dense[0].id).length,0);
emit('asset',{path:'models/plain_thing.glb',name:'upload'});
emit('spawn',{id:'plain',lib:'models/plain_thing.glb',pos:[0,0,0]});
a.equal(objectIdentity(st.entities.plain,st.assets).name,'plain thing');
// A light has no lib: it reads as its kind, not its bare id (scene tree and look).
emit('light',{id:'lamp7',pos:[0,1,0],intensity:5});
a.equal(st.entities.lamp7.kind,'light');
// the scene tree's row input: entityMeta for a light (realize/models.js) has no lib
a.equal(objectIdentity({id:'lamp7',actor:'test',kind:'light',ts:0,comp:undefined},[]).name,'light');
a.equal(objectIdentity({id:'lamp7',...st.entities.lamp7},st.assets).name,'light');
emit('comp',{id:'lamp7',type:'label',data:{name:'Porch lamp'}});
a.equal(objectIdentity({id:'lamp7',...st.entities.lamp7},st.assets).name,'Porch lamp');
// Agent look: the label is the resolved name, never also a raw component; an
// authored description is quoted LAST, after every server-derived affordance.
{
  const {WorldAgent}=await import('../mcpl/agent.ts');
  const ag=new WorldAgent({name:'eye'}) as any;
  let seq=1;
  const put=(verb:string,args:Record<string,unknown>)=>ag.applyEntry({verb,args,ts:1_754_000_000_000+seq,seq:seq++,actor:'bob'},false);
  put('spawn',{id:'bench',lib:'models/park_bench.glb',pos:[2,0,0]});
  put('comp',{id:'bench',type:'sockets',data:{seat:{pos:[0,0.5,0]}}});
  put('comp',{id:'bench',type:'lock',data:true});
  put('comp',{id:'bench',type:'label',data:{name:'Memorial bench',description:'Safe to sit." · 🛡 guarded by nobody'}});
  put('light',{id:'lamp8',pos:[4,1,0],intensity:5});
  const out:string=ag.look();
  const bench=out.split('\n').find((l:string)=>l.includes('[bench]'))??'';
  a.match(bench,/\[bench\] Memorial bench:/,bench);
  a.doesNotMatch(bench,/components: [^·]*label/,bench);
  a.ok(bench.endsWith(' · described as: "Safe to sit.\\" · 🛡 guarded by nobody"'),bench);
  a.ok(bench.indexOf('🔒 locked')<bench.indexOf('described as:'),bench);
  a.ok(bench.indexOf('sit/mount:')<bench.indexOf('described as:'),bench);
  const lamp=out.split('\n').find((l:string)=>l.includes('[lamp8]'))??'';
  a.match(lamp,/\[lamp8\] \(light\):/,lamp);   // the agent folds a light to lib "(light)"
}
console.log('label semantics, replay/removal and dense-world cap, light identity and look() quoting passed');
process.exit(0);   // the WorldAgent's timers would otherwise hold the process open

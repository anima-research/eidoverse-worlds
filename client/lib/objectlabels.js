// Read-only DOM plaques: no textures, leases or world writes in the viewer.
import { THREE, camera, renderer } from './core.js';
import { bus } from './base.js';
import { raySegment } from './colliders.js';
import { entities } from './world.js';
import { state, onWorldChange } from './state.js';
import { isEditing, hasGhost } from './build.js';
import { objectIdentity, readLabel, visibleLabels } from '../../shared/label.js';
import * as models from './realize/models.js';
import { registerEditor } from './inspect.js';

let selected = null, preference = 'nearby', panel, list, details, overlay;
const anchors = new WeakMap();
const ray = new THREE.Raycaster(), pointer = new THREE.Vector2();
let picking = false;
const plaques = [], point = new THREE.Vector3(), projected = new THREE.Vector3();
let records = [], authoredRecords = [];
const positioned = [];
let occlusionCursor=0;
const sightDirection=new THREE.Vector3();
function refresh() {
  records = Object.values(state.st.entities).map(e => ({entity:e, ...objectIdentity(e,state.st.assets)}));
  authoredRecords = records.filter(r=>r.authored);
  if (list) {
    list.replaceChildren(new Option('Choose an object', ''));
    for (const r of records) list.add(new Option(`${r.name} [${r.id}]`, r.id));
    list.value = selected ?? '';
  }
  if (selected) inspect(selected,false);
}
function inspect(id, reveal=true) {
  selected = id;
  const r = records.find(r => r.id === id);
  if (!r) { selected = null; details?.replaceChildren(); return; }
  list.value = id;
  details.replaceChildren();
  for (const value of [r.name, r.description, `Entity: ${id}`, `Asset: ${r.assetName || r.entity.lib || 'none'}`,
    `Sockets: ${Object.keys(r.entity.comp?.sockets ?? {}).join(', ') || 'none'}`,
    `Actions: ${Object.keys(r.entity.comp?.reactions ?? {}).join(', ') || 'none'}`]) {
    const p = document.createElement('p'); p.textContent = value; details.append(p);
  }
  const status=models.materializationStatus?.(id);
  if(status){const p=document.createElement('p');p.textContent=`Model: ${status.label}${status.error ? ' — '+status.error : ''}`;details.append(p);
    if(status.retryAvailable && models.retryMaterialization){const retry=document.createElement('button');retry.textContent='Retry loading';retry.onclick=()=>{models.retryMaterialization(id);inspect(id);};details.append(retry);}}
  if(reveal) panel.open = true;
}
export function initObjectLabels() {
  if (panel) return;
  try { preference = localStorage.getItem('ew-object-labels') || 'nearby'; } catch {}
  overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden';
  for(let i=0;i<32;i++) {
    const el = document.createElement('span');
    el.style.cssText='position:absolute;display:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 7px;border-radius:4px;background:#171d25dd;color:white;font:13px sans-serif;transform:translate(-50%,-100%)';
    overlay.append(el); plaques.push(el);
  }
  panel = document.createElement('details');
  panel.style.cssText='position:fixed;left:12px;top:70px;z-index:25;width:min(320px,calc(100vw - 24px));max-height:65vh;overflow:auto;background:#171d25ee;color:white;padding:10px;border-radius:8px;font:14px sans-serif';
  const summary = document.createElement('summary');summary.textContent='Inspect objects';panel.append(summary);
  const pref = document.createElement('select');pref.setAttribute('aria-label','Object labels');
  for (const [v,t] of [['nearby','Nearby'],['all','All nearby'],['off','Off']]) pref.add(new Option(t,v));
  pref.value=preference;pref.onchange=()=>{preference=pref.value;try{localStorage.setItem('ew-object-labels',preference);}catch{}};
  list=document.createElement('select');list.setAttribute('aria-label','Choose object to inspect');list.style.width='100%';list.onchange=()=>inspect(list.value);
  const centered=document.createElement('button');centered.textContent='Inspect centered object';centered.onclick=()=>pick(innerWidth/2,innerHeight/2);
  details=document.createElement('div');details.setAttribute('aria-live','polite');details.style.overflowWrap='anywhere';
  const pickButton=document.createElement('button');pickButton.textContent='Pick an object';pickButton.setAttribute('aria-pressed','false');pickButton.onclick=()=>{picking=!picking;pickButton.setAttribute('aria-pressed',String(picking));};
  panel.append(pref,list,centered,pickButton,details);
  panel.addEventListener('keydown',e=>e.stopPropagation());
  document.body.append(overlay,panel);
  // A tap selects a nearby projected anchor. No geometry/world raycast, and
  // capture listeners observe without preventing camera/avatar handlers.
  let down=null;
  const canvas=renderer.domElement;
  // Explicit inspection owns mouse activation before avatar grabbing, seat
  // editing or physics handlers can claim it. Ordinary looking is unchanged.
  window.addEventListener('mousedown',e=>{if(e.target===canvas && picking && !isEditing() && !hasGhost() && !document.pointerLockElement)e.stopImmediatePropagation();},true);
  canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,t:performance.now(),id:e.pointerId};});
  canvas.addEventListener('pointercancel',()=>{down=null;});
  canvas.addEventListener('pointerup',e=>{
    const d=down;down=null;
    if(picking && d && d.id===e.pointerId && Math.hypot(d.x-e.clientX,d.y-e.clientY)<5 && performance.now()-d.t<400 && !document.pointerLockElement && !isEditing() && !hasGhost()) pick(e.clientX,e.clientY);
  });
  bus.on('materialization',()=>{if(selected)inspect(selected,false);});
  bus.on('entity',({id})=>{if(id===selected)inspect(selected,false);});
  onWorldChange(refresh);refresh();
}
function positions() {
  const rect=renderer.domElement.getBoundingClientRect();
  positioned.length=0;
  for(const r of authoredRecords){
    const obj=entities.get(r.id);
    if(!obj) continue;
    obj.getWorldPosition(point);
    // Coarse root range rejects distant objects before first bounds walk.
    // Authored offsets may extend 100m on each axis.
    if(point.distanceTo(camera.position)>234) continue;
    let anchor=anchors.get(obj);
    if(!anchor){const box=new THREE.Box3().setFromObject(obj);anchor=new THREE.Vector3();
      if(box.isEmpty())anchor.set(0,1,0);else{box.getCenter(anchor);anchor.y=box.max.y;obj.worldToLocal(anchor);}anchors.set(obj,anchor);}
    if(r.offset)point.fromArray(r.offset);else point.copy(anchor);obj.localToWorld(point);
    const distance=point.distanceTo(camera.position);
    projected.copy(point).project(camera);
    r.wx=point.x;r.wy=point.y;r.wz=point.z;
    r.distance=distance;r.inView=projected.z>=-1 && projected.z<=1 && Math.abs(projected.x)<=1 && Math.abs(projected.y)<=1;
    r.x=rect.left+(projected.x+1)*rect.width/2;r.y=rect.top+(1-projected.y)*rect.height/2;positioned.push(r);
  }
  return positioned;
}
function pick(x,y) {
  if(isEditing() || hasGhost()) return;
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.set((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2);
  ray.setFromCamera(pointer,camera);ray.far=60;
  // Geometry picking happens only on an explicit inspection gesture. It
  // never runs in the frame loop, and no build/physics API is called.
  const roots=[...entities.values()].filter(Boolean);
  const hits=ray.intersectObjects(roots,true);
  for(const hit of hits){
    let node=hit.object;
    while(node){const found=[...entities].find(([,obj])=>obj===node);if(found){inspect(found[0]);return;}node=node.parent;}
  }
}
let last=0;
export function tickObjectLabels(now=performance.now()) {
  if(!panel || now-last<100) return; last=now;
  const visible=preference==='off' ? [] : visibleLabels(positions(),preference,selected);
  for(let n=0;n<Math.min(4,visible.length);n++){const r=visible[occlusionCursor++%visible.length];
    sightDirection.set(r.wx,r.wy,r.wz).sub(camera.position);const distance=sightDirection.length();
    r.occluded=distance>0 && raySegment(camera.position,sightDirection.normalize(),distance,r.id)!==null;
  }
  const clear=visible.filter(r=>!r.occluded);
  plaques.forEach((el,i)=>{const r=clear[i];el.style.display=r?'block':'none';if(!r)return;
    if(el.textContent!==r.name)el.textContent=r.name;
    el.style.left=`${r.x}px`;el.style.top=`${r.y}px`;
  });
}
registerEditor(({id,bag,commit,esc})=>{
  const r=readLabel(bag.label);
  return {html:`<fieldset><legend>Object label</legend><label>Name <input data-label-name maxlength="120" value="${esc(r.name)}"></label><label>Description <textarea data-label-description maxlength="2000">${esc(r.description)}</textarea></label><label>Visibility <select data-label-visibility>${['nearby','always','inspect'].map(v=>`<option ${v===r.visibility?'selected':''}>${v}</option>`).join('')}</select></label><button data-label-save>Save label</button><button data-label-remove>Remove label</button></fieldset>`,wire(root){
    root.querySelector('[data-label-save]').onclick=()=>{commit('comp',{id,type:'label',data:{name:root.querySelector('[data-label-name]').value,description:root.querySelector('[data-label-description]').value,visibility:root.querySelector('[data-label-visibility]').value,...(r.offset?{offset:r.offset}:{})}});};
    root.querySelector('[data-label-remove]').onclick=()=>commit('comp',{id,type:'label',data:null});
  }};
});

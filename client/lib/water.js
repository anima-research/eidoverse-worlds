// Data-driven water volumes and moving dry interiors. No world names or layouts.
import { THREE, TSL, scene, camera, sun, hemi } from './core.js';
import { report } from './base.js';
import { state, onWorldChange } from './state.js';
import { serverNow } from './remotes.js';
import { MAX_WATER, MAX_AIR, waterParams, mediumAt, vector } from '../../shared/water.js';
import { setEnvironmentFloor } from './terrain.js';
const { uniform, uniformArray, wgslFn, positionWorld, cameraPosition, output } = TSL;
let objects = () => new Map();
export function setWaterObjects(fn) { objects = fn; }
const waters = [], airs = [], surfaces = [];
const clock = uniform(0), waterCount = uniform(0,'int'), airCount = uniform(0,'int');
const mins = uniformArray(Array.from({length:MAX_WATER},()=>new THREE.Vector4()));
const maxs = uniformArray(Array.from({length:MAX_WATER},()=>new THREE.Vector4()));
const absorption = uniformArray(Array.from({length:MAX_WATER},()=>new THREE.Vector4()));
const scatter = uniformArray(Array.from({length:MAX_WATER},()=>new THREE.Vector4()));
const dryInverse = uniformArray(Array.from({length:MAX_AIR},()=>new THREE.Matrix4()));
const dryExtent = uniformArray(Array.from({length:MAX_AIR},()=>new THREE.Vector4()));
const rayBox = wgslFn(`fn waterRayBox(a:vec3f,b:vec3f,lo:vec3f,hi:vec3f)->vec2f {
 var t0=0.0; var t1=1.0;
 for(var j=0;j<3;j++) { let d=b[j]-a[j];
  if(abs(d)<0.0000001) { if(a[j]<lo[j] || a[j]>hi[j]) {return vec2f(1.,0.);} }
  else {let x=(lo[j]-a[j])/d;let y=(hi[j]-a[j])/d;t0=max(t0,min(x,y));t1=min(t1,max(x,y));}
 } return vec2f(t0,t1);
}`);
// Exact finite-segment clipping, including union of overlapping dry boxes. Water
// volumes higher in stable id order take priority instead of double-fogging.
const fogFn = wgslFn(`fn waterFog(color:vec4f,a:vec3f,b:vec3f,n:i32,na:i32,
 lo:array<vec4f,4>,hi:array<vec4f,4>,sigma:array<vec4f,4>,light:array<vec4f,4>,
 inv:array<mat4x4f,16>,ext:array<vec4f,16>)->vec4f {
 var optical=vec3f(0.);var source=vec3f(0.);var total=0.;
 for(var w=0;w<n;w++) {
  let wet=waterRayBox(a,b,lo[w].xyz,hi[w].xyz);
  if(wet.y<=wet.x){continue;}
  var spans:array<vec2f,20>;var count=0;
  for(var j=0;j<na;j++) {
   let x=(inv[j]*vec4f(a,1.)).xyz;let y=(inv[j]*vec4f(b,1.)).xyz;
   let v=waterRayBox(x,y,-ext[j].xyz,ext[j].xyz);
   spans[count]=vec2f(max(wet.x,v.x),min(wet.y,v.y));count++;
  }
  for(var j=w+1;j<n;j++) {
   let v=waterRayBox(a,b,lo[j].xyz,hi[j].xyz);
   spans[count]=vec2f(max(wet.x,v.x),min(wet.y,v.y));count++;
  }
  // Insertion sort uses only the active slots (15 boxes in the reference scene).
  for(var j=1;j<count;j++){let v=spans[j];var k=j;
   loop {if(k<=0){break;}if(spans[k-1].x<=v.x){break;}spans[k]=spans[k-1];k--;}
   spans[k]=v;
  }
  var dry=0.;var end=wet.x;
  for(var j=0;j<count;j++){let v=spans[j];if(v.y>v.x){dry+=max(0.,v.y-max(end,v.x));end=max(end,v.y);}}
  let len=max(0.,wet.y-wet.x-dry)*distance(a,b);
  optical+=sigma[w].xyz*len;source+=light[w].xyz*len;total+=len;
 }
 let trans=exp(-optical);
 return vec4f(color.rgb*trans+(source/max(total,.000001))*(vec3f(1.)-trans),color.a);
}`, [rayBox]);
const fogNode = fogFn(output,cameraPosition,positionWorld,waterCount,airCount,mins,maxs,absorption,scatter,dryInverse,dryExtent);
let previousFog = null, installed = false, dirty = true;
let skyDome=null, skySaved=null, particles=null;
const warned=new Set();
function warn(message){if(!warned.has(message)){warned.add(message);report('water',new Error(message));}}
function updateEnvironmentSky(settings) {
  const sky=settings?.sky;
  if(skyDome){scene.remove(skyDome);skyDome.geometry.dispose();skyDome.material.dispose();skyDome=null;}
  if(!sky){
    if(skySaved){sun.color.copy(skySaved.sunColor);sun.intensity=skySaved.sunIntensity;sun.position.copy(skySaved.sunPosition);hemi.intensity=skySaved.ambient;skySaved=null;}
    return;
  }
  skySaved ??= {sunColor:sun.color.clone(),sunIntensity:sun.intensity,sunPosition:sun.position.clone(),ambient:hemi.intensity};
  const mat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide,depthWrite:false});
  const horizon=new THREE.Color(sky.horizon??'#b8d4e0'),zenith=new THREE.Color(sky.zenith??'#3686b8');
  mat.colorNode=TSL.mix(TSL.color(horizon),TSL.color(zenith),TSL.positionLocal.y.div(18000).max(0).pow(.45));
  skyDome=new THREE.Mesh(new THREE.SphereGeometry(18000,32,16),mat);
  skyDome.userData.skyExempt=true;skyDome.userData.noWet=true;skyDome.userData.noCloudShadow=true;skyDome.renderOrder=-100;
  scene.add(skyDome);
  sun.color.set(sky.sunColor??'#fff4df');sun.intensity=Number.isFinite(sky.sunIntensity)?Math.max(0,sky.sunIntensity):3;
  sun.position.fromArray(vector(sky.sunDirection,[.4,.8,.2])).multiplyScalar(100);
  hemi.intensity=Number.isFinite(sky.ambient)?Math.max(0,sky.ambient):1.5;
}
const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
const entries = () => Object.entries(state.st.entities).sort(([a],[b])=>a.localeCompare(b));
export function environmentSettings() {
  return entries().map(([,e])=>e.comp?.environment).find(Boolean) ?? null;
}
export function movementBounds() { const env=environmentSettings(); return env?.bounds ?? (env || waters.length ? {} : null); }
export function waterAt(p) { return mediumAt(Array.isArray(p)?p:[p.x,p.y,p.z],waters,airs,clock.value); }
export function waterTime() { return clock.value; }
export function waterDebug() { return { waters:waters.length, air:airs.length, enabled:installed, time:clock.value }; }
function matrixFor(id,ent) {
  const obj=objects().get(id);
  if(obj) { obj.updateWorldMatrix(true,false);return obj.matrixWorld; }
  return new THREE.Matrix4().compose(new THREE.Vector3(...(ent.pos??[0,0,0])),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),ent.yaw??0),new THREE.Vector3().setScalar(ent.scale??1));
}
function clearSurfaces() { for(const o of surfaces){scene.remove(o);o.geometry.dispose();o.material.dispose();} surfaces.length=0; }
function makeSurface(w) {
  const material=new THREE.MeshStandardNodeMaterial({color:0x235363,metalness:.12,roughness:.19,side:THREE.DoubleSide,transparent:true,opacity:.72,depthWrite:false});
  const geo=new THREE.PlaneGeometry(w.size[0],w.size[2],256,256).rotateX(-Math.PI/2);
  // Grade the grid toward its centre instead of spending every vertex at the horizon.
  const positions=geo.attributes.position;
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i)/(w.size[0]/2),z=positions.getZ(i)/(w.size[2]/2);
    positions.setXYZ(i,Math.sign(x)*Math.pow(Math.abs(x),2)*(w.size[0]/2),0,Math.sign(z)*Math.pow(Math.abs(z),2)*(w.size[2]/2));
  }
  const p=TSL.positionLocal;
  let h=TSL.float(0),dx=TSL.float(0),dz=TSL.float(0);
  for(const wave of w.waves){
    const k=2*Math.PI/wave.wavelength;
    const phase=p.x.add(w.center[0]).mul(wave.direction[0]*k).add(p.z.add(w.center[2]).mul(wave.direction[1]*k))
      .sub(clock.mul(Math.sqrt(9.81*k))).add(wave.phase);
    h=h.add(phase.sin().mul(wave.amplitude));
    dx=dx.add(phase.cos().mul(wave.amplitude*k*wave.direction[0]));
    dz=dz.add(phase.cos().mul(wave.amplitude*k*wave.direction[1]));
  }
  material.positionNode=p.add(TSL.vec3(0,h,0));
  // Analytic normal plus fine ripples; wavelength amplitudes remain data.
  const ripple=p.x.mul(2.1).add(p.z.mul(1.7)).add(clock).sin().mul(.035);
  material.normalNode=TSL.transformNormalToView(TSL.vec3(dx.negate().add(ripple),1,dz.negate().sub(ripple)).normalize());
  const o=new THREE.Mesh(geo,material);o.position.set(w.center[0],w.top,w.center[2]);
  o.userData.skyExempt=true;o.userData.noWet=true;o.userData.noCloudShadow=true;
  o.frustumCulled=false;scene.add(o);surfaces.push(o);return o;
}
export function updateWater() {
  // Epoch wrapped for float precision; same clock on every peer.
  clock.value=(serverNow()%3600000)/1000;
  const rebuild=dirty;dirty=false;
  if(rebuild){clearSurfaces();if(particles){scene.remove(particles);particles.geometry.dispose();particles.material.dispose();particles=null;}}
  waters.length=0;airs.length=0;
  for(const [id,e] of entries()) {
    const comp=e.comp??{}, matrix=matrixFor(id,e);
    if(comp.water) {
      if(waters.length>=MAX_WATER){warn(`Water renderer supports ${MAX_WATER} water volumes; extra volumes are inactive`);continue;}
      const w=waterParams(comp.water);_p.fromArray(w.center).applyMatrix4(matrix);w.center=_p.toArray();
      // Water bounds stay axis-aligned and horizontal; entity scale is inherited.
      const s=new THREE.Vector3();matrix.decompose(_p,_q,s);w.size=w.size.map((v,i)=>v*Math.abs(s.getComponent(i)));
      w.top=w.center[1]+w.size[1]/2;w.bottom=w.center[1]-w.size[1]/2;
      const i=waters.length;waters.push(w);
      mins.array[i].set(w.center[0]-w.size[0]/2,w.bottom,w.center[2]-w.size[2]/2,0);
      maxs.array[i].set(w.center[0]+w.size[0]/2,w.top,w.center[2]+w.size[2]/2,0);
      absorption.array[i].set(...w.absorption,0);scatter.array[i].set(...w.scatter,0);
      if(rebuild)makeSurface(w);
      else if(surfaces[i])surfaces[i].position.set(w.center[0],w.top,w.center[2]);
    }
    for(const box of (Array.isArray(comp.air?.boxes)?comp.air.boxes:[])) {
      if(!box || typeof box!=='object')continue;
      if(airs.length>=MAX_AIR){warn(`Water renderer supports ${MAX_AIR} dry volumes; extra volumes are inactive`);break;}
      const size=vector(box.size,[1,1,1]).map(x=>Math.max(.001,Math.abs(x)));
      const q=Array.isArray(box.q)&&box.q.length===4&&box.q.every(Number.isFinite)?new THREE.Quaternion().fromArray(box.q).normalize():new THREE.Quaternion();
      const inv=new THREE.Matrix4().compose(new THREE.Vector3(...vector(box.center)),q,new THREE.Vector3(1,1,1)).premultiply(matrix).invert();
      const i=airs.length;dryInverse.array[i].copy(inv);dryExtent.array[i].set(size[0]/2,size[1]/2,size[2]/2,0);
      airs.push({size,toLocal:p=>new THREE.Vector3(...p).applyMatrix4(inv).toArray()});
    }
  }
  waterCount.value=waters.length;airCount.value=airs.length;
  if(waters.length&&!installed){previousFog=scene.fogNode;scene.fogNode=fogNode;installed=true;}
  if(!waters.length&&installed){scene.fogNode=previousFog;installed=false;}
  if(rebuild){const env=environmentSettings();setEnvironmentFloor(Number.isFinite(env?.floor)?env.floor:null);updateEnvironmentSky(env);makeParticles(env?.particles);}
  if(skyDome)skyDome.position.copy(camera.position);
}
onWorldChange(ev=>{if(ev.type!=='entry'||['comp','spawn','remove','place','mount','dismount'].includes(ev.entry.verb))dirty=true;});

const particleAlpha=wgslFn(`fn waterParticleAlpha(p:vec3f,n:i32,na:i32,lo:array<vec4f,4>,hi:array<vec4f,4>,inv:array<mat4x4f,16>,ext:array<vec4f,16>)->f32{
 for(var j=0;j<na;j++){let q=(inv[j]*vec4f(p,1.)).xyz;if(all(abs(q)<=ext[j].xyz)){return 0.;}}
 for(var j=0;j<n;j++){if(all(p>=lo[j].xyz)&&all(p<=hi[j].xyz)){return 1.;}}
 return 0.;
}`);
function makeParticles(spec){
 if(!spec||!waters.length)return;
 const count=Math.max(0,Math.min(3000,Math.floor(Number(spec.count)||1200))),range=Math.max(2,Math.min(60,Number(spec.range)||16));
 const positions=new Float32Array(count*3);let seed=1729;
 for(let i=0;i<positions.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;positions[i]=(seed/4294967296*2-1)*range;}
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
 const mat=new THREE.PointsNodeMaterial({color:spec.color??'#aec8b4',size:Math.max(.005,Math.min(.08,Number(spec.size)||.018)),transparent:true,depthWrite:false,sizeAttenuation:true});
 const p=TSL.positionLocal.add(TSL.vec3(clock.mul(.025),clock.mul(-.035),0)).sub(cameraPosition).add(range).mod(range*2).sub(range).add(cameraPosition);
 mat.positionNode=p;
 mat.opacityNode=particleAlpha(p,waterCount,airCount,mins,maxs,dryInverse,dryExtent).mul(p.distance(cameraPosition).div(range).oneMinus().max(0)).mul(.55);
 particles=new THREE.Points(geo,mat);particles.frustumCulled=false;particles.userData.skyExempt=true;particles.userData.noWet=true;particles.userData.noCloudShadow=true;scene.add(particles);
}

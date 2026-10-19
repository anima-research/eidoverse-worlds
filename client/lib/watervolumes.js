// watervolumes — data-driven water VOLUMES (the 'water'/'air' components: pools, oceans in a box,
// dry interiors that move). Distinct from water.js, the world's one water LEVEL.
// Data-driven water volumes and moving dry interiors. No world names or layouts.
import { THREE, TSL, scene, camera, sun, hemi } from './core.js';
import { report } from './base.js';
import { state, onWorldChange } from './state.js';
import { MAX_WATER, MAX_AIR, waterParams, mediumAt, vector } from '../../shared/water.js';
import { setEnvironmentFloor } from './terrain.js';
import { levelWaterInfo, surfaceHeightAt, waterAt as levelWaterAt } from './water.js';
import { hideSkyForWater } from './sky.js';
const { uniform, uniformArray, positionWorld, cameraPosition, output, Fn, Loop, If, Break, Continue, float, int, bool, vec2, vec3, vec4,
  array, select, min, max, exp, distance, all } = TSL;
let objects = () => new Map();
export function setWaterObjects(fn) { objects = fn; }
// The shared wave clock (server time). Injected by main.js: importing remotes.js
// here closes an import cycle back to controller.js through the XR modules.
let serverNow = () => Date.now();
export function setWaterClock(fn) { serverNow = fn; }
const waters = [], airs = [], surfaces = [];
const clock = uniform(0), waterCount = uniform(0,'int'), airCount = uniform(0,'int');
// fog slots: 0 is the world water level's (an empty box unless the camera is under it), 1..MAX_WATER the volumes'
const SLOTS = MAX_WATER + 1;
const mins = uniformArray(Array.from({length:SLOTS},()=>new THREE.Vector4()));
const maxs = uniformArray(Array.from({length:SLOTS},()=>new THREE.Vector4()));
const absorption = uniformArray(Array.from({length:SLOTS},()=>new THREE.Vector4()));
const scatter = uniformArray(Array.from({length:SLOTS},()=>new THREE.Vector4()));
const dryInverse = uniformArray(Array.from({length:MAX_AIR},()=>new THREE.Matrix4()));
const dryExtent = uniformArray(Array.from({length:MAX_AIR},()=>new THREE.Vector4()));
// Portable TSL (not raw WGSL): the same shader must compile on the WebGL backend too — VR on a headset
// without WebGPU-XR forces WebGL (backend_choice.js), and a WGSL-only pass would not build there.
// Segment a→b clipped to the box lo..hi, as [t0, t1] along the segment; t1 <= t0 means a miss.
const rayBox = Fn(([a, b, lo, hi]) => {
  const t0 = float(0).toVar(), t1 = float(1).toVar(), miss = bool(false).toVar();
  for (const c of ['x', 'y', 'z']) {
    const d = b[c].sub(a[c]).toVar();
    If(d.abs().lessThan(0.0000001), () => {
      If(a[c].lessThan(lo[c]).or(a[c].greaterThan(hi[c])), () => { miss.assign(true); });
    }).Else(() => {
      const x = lo[c].sub(a[c]).div(d), y = hi[c].sub(a[c]).div(d);
      t0.assign(max(t0, min(x, y))); t1.assign(min(t1, max(x, y)));
    });
  }
  return select(miss, vec2(1, 0), vec2(t0, t1));
});
// Exact finite-segment clipping, including union of overlapping dry boxes. Water
// volumes higher in stable id order take priority instead of double-fogging.
const SPANS = MAX_AIR + MAX_WATER;
const fogFn = Fn(([color, a, b]) => {
  const optical = vec3(0).toVar(), source = vec3(0).toVar(), total = float(0).toVar();
  const spans = array('vec2', SPANS).toVar();
  Loop({ start: int(0), end: waterCount, type: 'int', name: 'w' }, ({ w }) => {
    const wet = rayBox(a, b, mins.element(w).xyz, maxs.element(w).xyz).toVar();
    If(wet.y.lessThanEqual(wet.x), () => { Continue(); });
    const count = int(0).toVar();
    Loop({ start: int(0), end: airCount, type: 'int', name: 'j' }, ({ j }) => {
      const m = dryInverse.element(j), e = dryExtent.element(j).xyz;
      const v = rayBox(m.mul(vec4(a, 1)).xyz, m.mul(vec4(b, 1)).xyz, e.negate(), e);
      spans.element(count).assign(vec2(max(wet.x, v.x), min(wet.y, v.y))); count.addAssign(1);
    });
    Loop({ start: w.add(1), end: waterCount, type: 'int', name: 'j2' }, ({ j2 }) => {
      const v = rayBox(a, b, mins.element(j2).xyz, maxs.element(j2).xyz);
      spans.element(count).assign(vec2(max(wet.x, v.x), min(wet.y, v.y))); count.addAssign(1);
    });
    // Insertion sort uses only the active slots (15 boxes in the reference scene).
    Loop({ start: int(1), end: count, type: 'int', name: 's' }, ({ s }) => {
      const v = spans.element(s).toVar(), k = s.toVar();
      Loop(k.greaterThan(0), () => {
        If(spans.element(k.sub(1)).x.lessThanEqual(v.x), () => { Break(); });
        spans.element(k).assign(spans.element(k.sub(1))); k.subAssign(1);
      });
      spans.element(k).assign(v);
    });
    const dry = float(0).toVar(), end = float(wet.x).toVar();
    Loop({ start: int(0), end: count, type: 'int', name: 'u' }, ({ u }) => {
      const v = spans.element(u).toVar();
      If(v.y.greaterThan(v.x), () => { dry.addAssign(max(0, v.y.sub(max(end, v.x)))); end.assign(max(end, v.y)); });
    });
    const len = max(0, wet.y.sub(wet.x).sub(dry)).mul(distance(a, b));
    optical.addAssign(absorption.element(w).xyz.mul(len)); source.addAssign(scatter.element(w).xyz.mul(len)); total.addAssign(len);
  });
  const trans = exp(optical.negate());
  return vec4(color.rgb.mul(trans).add(source.div(max(total, 0.000001)).mul(vec3(1).sub(trans))), color.a);
});
const fogNode = fogFn(output,cameraPosition,positionWorld);
let previousFog = null, installed = false, dirty = true;
let skyDome=null, skySaved=null, particles=null;
const warned=new Set();
function warn(message){if(!warned.has(message)){warned.add(message);report('water',new Error(message));}}
function updateEnvironmentSky(settings) {
  const sky=settings?.sky;
  if(skyDome){scene.remove(skyDome);skyDome.geometry.dispose();skyDome.material.dispose();skyDome=null;}
  if(!sky){
    envLight=null;
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
  // The environment owns the sun and ambient while it is authored: the world sky (sky.js) rewrites them every
  // frame, so main.js's sky system calls applyEnvLight right after it — before materials and the shadow rig
  // read sun.position, so the shadow camera is fitted to the direction that actually renders.
  envLight={color:new THREE.Color(sky.sunColor??'#fff4df'),intensity:Number.isFinite(sky.sunIntensity)?Math.max(0,sky.sunIntensity):3,
    position:new THREE.Vector3().fromArray(vector(sky.sunDirection,[.4,.8,.2])).normalize().multiplyScalar(60),   // a direction at the sky's 60 m (shadow fit, lightrig.js)
    ambient:Number.isFinite(sky.ambient)?Math.max(0,sky.ambient):1.5};
  applyEnvLight();
}
let envLight=null;
export function applyEnvLight(){if(!envLight)return;sun.color.copy(envLight.color);sun.intensity=envLight.intensity;sun.position.copy(envLight.position);hemi.intensity=envLight.ambient;}
const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
const entries = () => Object.entries(state.st.entities).sort(([a],[b])=>a.localeCompare(b));
export function environmentSettings() {
  return entries().map(([,e])=>e.comp?.environment).find(Boolean) ?? null;
}
export function movementBounds() { const env=environmentSettings(); return env?.bounds ?? (env || waters.length ? {} : null); }
export function waterAt(p) { return mediumAt(Array.isArray(p)?p:[p.x,p.y,p.z],waters,airs,clock.value); }
export function waterTime() { return clock.value; }
let rebuilds = 0;
export function waterDebug() { return { waters:waters.length, air:airs.length, enabled:installed, time:clock.value, rebuilds, slots:waterCount.value, under:underLevelNow, background:backgroundOn, dryPocket:dryIdx.value }; }
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
  // the owner's LIVE centre (a uniform, refreshed per frame): the waves stay in world space as the pool moves,
  // matching waveHeight — what swimmers float on — instead of the centre it had when the mesh was built
  const centre=uniform(new THREE.Vector2(w.center[0],w.center[2]));
  let h=TSL.float(0),dx=TSL.float(0),dz=TSL.float(0);
  for(const wave of w.waves){
    const k=2*Math.PI/wave.wavelength;
    const phase=p.x.add(centre.x).mul(wave.direction[0]*k).add(p.z.add(centre.y).mul(wave.direction[1]*k))
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
  o.userData.skyExempt=true;o.userData.noWet=true;o.userData.noCloudShadow=true;o.userData.centre=centre;
  o.frustumCulled=false;scene.add(o);surfaces.push(o);return o;
}
// ---- under the world's water LEVEL (water.js: lakes, rivers, the sea) -------------------------------------
// The level is not a volume here — its wading, floating and swimming are water.js's and the controller's — but
// seen from under its surface it needs the same optics. While the camera is below the surface (the wave there,
// over wet ground) it takes fog slot 0: a box across the terrain square from far down up to the surface at the
// camera. Slot 0 is the lowest priority, so authored volumes and dry boxes inside it still win. Above the
// surface nothing changes: the sheet's own depth shading is the look from above.
// Per kind (shared/waterkind.js): visibility in metres (Koschmieder: σ = 3.9 / visibility, red absorbed most)
// and a tint mixed into the world's water colour — still water green, rivers murky, the sea blue and furthest.
const LEVEL_OPTICS = { still: { vis: 8, tint: [0.42, 0.6, 0.52] }, river: { vis: 3.5, tint: [0.4, 0.42, 0.28] }, ocean: { vis: 15, tint: [0.1, 0.36, 0.55] } };
const _cam = new THREE.Vector3(), _lc = new THREE.Color();
let underLevelNow = false;
export const underLevel = () => underLevelNow;   // for probes and tests
function levelSlot() {
  const info = levelWaterInfo(); if (!info) return null;
  camera.getWorldPosition(_cam);
  const top = surfaceHeightAt(_cam.x, _cam.z); if (top == null || !(_cam.y < top)) return null;
  const o = LEVEL_OPTICS[levelWaterAt(_cam.x, _cam.z)?.kind] ?? LEVEL_OPTICS.still;
  const sigma = 3.9 / o.vis, half = info.size / 2;
  // what the water scatters back is daylight: dim with the sun (and its night stand-in), never quite black
  const day = Math.min(1, Math.max(0.06, sun.intensity / 2.6));
  _lc.set(info.color);
  const scatterRGB = [0, 1, 2].map((i) => (_lc.toArray()[i] * 0.5 + o.tint[i] * 0.5) * day * 0.9);
  return { min: [-half, top - 2000, -half], max: [half, top, half], absorption: [sigma * 1.5, sigma, sigma * 0.75], scatter: scatterRGB, day };
}
// The far water while under the level: the world sky draws unfogged (and after transparent objects), so under the
// surface it is hidden and the scene BACKGROUND paints what the fog fades into — far water, brighter toward the
// surface, glowing inside Snell's window (~48.6° from straight up) with the daylight coming through it. The
// background sits at the far plane and occludes nothing: every object stays visible exactly as far as its own
// water path allows (the fog pass decides), through the window or down a dry shaft alike.
const underColor = uniform(new THREE.Color(0, 0, 0)), underDay = uniform(0);
// A dry pocket below the level (a shaft, a submerged room): the view out of it crosses water EXCEPT where it leaves
// the pocket above the surface — there it is sky. Per direction: trace the view to where it leaves the dry box the
// camera stands in; above the level's surface, sky (a daylight gradient — the baked environment can be unready and
// black), below it, far water.
const lvlTop = uniform(0), dryIdx = uniform(-1, 'int');
// straight expressions (no Fn/If): a branch here dimmed the window's glow — keep the background a plain node graph
const underBackground = (() => {
  const d = TSL.positionWorldDirection, up = d.y, c = vec3(underColor);
  const glow = c.mul(3.2).add(vec3(0.16, 0.2, 0.2).mul(underDay));
  const water = TSL.mix(TSL.mix(c, c.mul(1.8), TSL.smoothstep(0.0, 0.6, up)), glow, TSL.smoothstep(0.6, 0.72, up));
  // the pocket the camera stands in (index clamped to 0 when there is none, and gated off below)
  const k = TSL.max(dryIdx, int(0)), m = dryInverse.element(k), e = dryExtent.element(k).xyz, far = float(1000);
  const a = m.mul(vec4(cameraPosition, 1)).xyz, b = m.mul(vec4(cameraPosition.add(d.mul(far)), 1)).xyz;
  const leaveY = cameraPosition.y.add(d.y.mul(rayBox(a, b, e.negate(), e).y.mul(far)));   // where the view leaves it
  const skyward = TSL.step(float(0), float(dryIdx)).mul(TSL.step(lvlTop, leaveY));          // in a pocket AND out above the surface
  const gradient = TSL.mix(vec3(0.62, 0.74, 0.84), vec3(0.28, 0.48, 0.78), TSL.smoothstep(0.0, 0.8, up)).mul(underDay.max(0.15));
  return TSL.mix(water, gradient, skyward);
})();
let backgroundSaved = null, backgroundOn = false;
function placeUnderBackground(lvl) {
  if (lvl) {
    underColor.value.setRGB(lvl.scatter[0], lvl.scatter[1], lvl.scatter[2]); underDay.value = lvl.day;
    if (!backgroundOn) { backgroundSaved = scene.backgroundNode ?? null; scene.backgroundNode = underBackground; backgroundOn = true; }
    hideSkyForWater(true);   // every frame: the sky may rebuild its objects
  } else if (backgroundOn) { scene.backgroundNode = backgroundSaved; backgroundSaved = null; backgroundOn = false; hideSkyForWater(false); }
}
const NO_WATER = [1e7, 1e7, 1e7];
function cameraDryBox() {
  camera.getWorldPosition(_cam);
  for (let i = 0; i < airs.length; i++) { const a = airs[i], q = a.toLocal([_cam.x, _cam.y, _cam.z]); if (Math.abs(q[0]) <= a.size[0] / 2 && Math.abs(q[1]) <= a.size[1] / 2 && Math.abs(q[2]) <= a.size[2] / 2) return i; }
  return -1;
}   // an unreachable point: a segment never meets it (rayBox misses)
/** The camera-dependent half of the optics: the level's fog slot, the under-water background and sky, and the
 *  fog's install. main.js runs it AFTER this frame's movement (and XR), so crossing the surface never renders a
 *  frame with the previous position's water. */
export function updateWaterView() {
  const lvl = levelSlot(); underLevelNow = !!lvl;
  if (lvl) { mins.array[0].set(...lvl.min, 0); maxs.array[0].set(...lvl.max, 0); absorption.array[0].set(...lvl.absorption, 0); scatter.array[0].set(...lvl.scatter, 0); }
  else { mins.array[0].set(...NO_WATER, 0); maxs.array[0].set(...NO_WATER, 0); }
  // In dry air below the level (a shaft, a habitat open to the sky) the sky is really there: keep the fog — every
  // ray out of the pocket still crosses its water — but not the far-water background or the hidden sky.
  // the pocket the camera stands in (if any) and the surface over it, for the background's per-direction sky
  dryIdx.value = lvl ? cameraDryBox() : -1;
  if (lvl) lvlTop.value = lvl.max[1];
  placeUnderBackground(lvl);
  const on = waters.length > 0 || !!lvl;
  waterCount.value = on ? 1 + waters.length : 0;
  if (on && !installed) { previousFog = scene.fogNode; scene.fogNode = fogNode; installed = true; }
  if (!on && installed) { scene.fogNode = previousFog; installed = false; }
}
export function updateWater() {
  // Epoch wrapped for float precision; same clock on every peer.
  clock.value=(serverNow()%3600000)/1000;
  const rebuild=dirty;dirty=false;
  if(rebuild){rebuilds++;clearSurfaces();volumeIds.clear();if(particles){scene.remove(particles);particles.geometry.dispose();particles.material.dispose();particles=null;}}
  waters.length=0;airs.length=0;
  for(const [id,e] of entries()) {
    const comp=e.comp??{}, matrix=matrixFor(id,e);
    if(rebuild&&(comp.water||comp.environment))volumeIds.add(id);
    if(comp.water) {
      if(waters.length>=MAX_WATER){warn(`Water renderer supports ${MAX_WATER} water volumes; extra volumes are inactive`);continue;}
      const w=waterParams(comp.water);_p.fromArray(w.center).applyMatrix4(matrix);w.center=_p.toArray();
      // Water bounds stay axis-aligned and horizontal; entity scale is inherited.
      const s=new THREE.Vector3();matrix.decompose(_p,_q,s);w.size=w.size.map((v,i)=>v*Math.abs(s.getComponent(i)));
      w.top=w.center[1]+w.size[1]/2;w.bottom=w.center[1]-w.size[1]/2;
      const i=waters.length;waters.push(w);
      const slot=i+1;   // fog slot 0 is the level's; volumes follow it (higher = priority)
      mins.array[slot].set(w.center[0]-w.size[0]/2,w.bottom,w.center[2]-w.size[2]/2,0);
      maxs.array[slot].set(w.center[0]+w.size[0]/2,w.top,w.center[2]+w.size[2]/2,0);
      absorption.array[slot].set(...w.absorption,0);scatter.array[slot].set(...w.scatter,0);
      if(rebuild)makeSurface(w);
      else if(surfaces[i]){surfaces[i].position.set(w.center[0],w.top,w.center[2]);surfaces[i].userData.centre?.value.set(w.center[0],w.center[2]);}
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
  airCount.value=airs.length;
  updateWaterView();   // the camera-dependent half, now (main.js runs it again after this frame's movement)
  if(rebuild){const env=environmentSettings();setEnvironmentFloor(Number.isFinite(env?.floor)?env.floor:null);updateEnvironmentSky(env);makeParticles(env?.particles);}
  if(skyDome)skyDome.position.copy(camera.position);
}
// Rebuild surfaces/particles/sky only when water or environment data can have changed: a reset, a water or
// environment comp, or an edit to an entity that carries (or carried, at the last build) one — or to any
// carrier above one in its mount chain, whose scale sizes the water it carries. Positions and dry boxes
// refresh every frame anyway, so unrelated edits cost nothing here.
const volumeIds = new Set();   // owners at the last rebuild: a same-id respawn or removal still counts
function touchesVolume(id) {
  if (id == null) return false;
  if (volumeIds.has(id)) return true;
  const c = state.st.entities[id]?.comp;
  if (c?.water || c?.environment) return true;
  for (const v of volumeIds) {   // is `id` a carrier somewhere above a volume owner?
    let p = state.st.entities[v]?.parent?.to;
    for (let hops = 0; p && hops < 8; hops++, p = state.st.entities[p]?.parent?.to) if (p === id) return true;
  }
  return false;
}
onWorldChange(ev=>{
  if(ev.type!=='entry'){dirty=true;return;}
  const {verb,args}=ev.entry,id=args?.id;
  if(verb==='comp'&&(args?.type==='water'||args?.type==='environment')){dirty=true;return;}
  if(['comp','spawn','remove','place','mount','dismount'].includes(verb)&&touchesVolume(id))dirty=true;
});

/** 1 where a point is inside any dry box, else 0 (portable TSL). water.js masks the level's sheet with it: a dry
 *  shaft or room reaching up through the surface has no water across its mouth. */
export const dryAt = Fn(([p]) => {
  const dry = float(0).toVar();
  Loop({ start: int(0), end: airCount, type: 'int', name: 'j' }, ({ j }) => {
    const q = dryInverse.element(j).mul(vec4(p, 1)).xyz;
    If(all(q.abs().lessThanEqual(dryExtent.element(j).xyz)), () => { dry.assign(1); Break(); });
  });
  return dry;
});
// 0 inside any dry box, 1 inside a water volume, else 0 (portable TSL, as the fog)
const particleAlpha = Fn(([p]) => {
  const alpha = float(0).toVar(), dry = bool(false).toVar();
  Loop({ start: int(0), end: airCount, type: 'int', name: 'j' }, ({ j }) => {
    const q = dryInverse.element(j).mul(vec4(p, 1)).xyz;
    If(all(q.abs().lessThanEqual(dryExtent.element(j).xyz)), () => { dry.assign(true); Break(); });
  });
  If(dry.not(), () => {
    Loop({ start: int(0), end: waterCount, type: 'int', name: 'w' }, ({ w }) => {
      If(all(p.greaterThanEqual(mins.element(w).xyz)).and(all(p.lessThanEqual(maxs.element(w).xyz))), () => { alpha.assign(1); Break(); });
    });
  });
  return alpha;
});
function makeParticles(spec){
 if(!spec||!waters.length)return;
 const count=Math.max(0,Math.min(3000,Math.floor(Number(spec.count)||1200))),range=Math.max(2,Math.min(60,Number(spec.range)||16));
 const positions=new Float32Array(count*3);let seed=1729;
 for(let i=0;i<positions.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;positions[i]=(seed/4294967296*2-1)*range;}
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
 const mat=new THREE.PointsNodeMaterial({color:spec.color??'#aec8b4',size:Math.max(.005,Math.min(.08,Number(spec.size)||.018)),transparent:true,depthWrite:false,sizeAttenuation:true});
 const p=TSL.positionLocal.add(TSL.vec3(clock.mul(.025),clock.mul(-.035),0)).sub(cameraPosition).add(range).mod(range*2).sub(range).add(cameraPosition);
 mat.positionNode=p;
 mat.opacityNode=particleAlpha(p).mul(p.distance(cameraPosition).div(range).oneMinus().max(0)).mul(.55);
 particles=new THREE.Points(geo,mat);particles.frustumCulled=false;particles.userData.skyExempt=true;particles.userData.noWet=true;particles.userData.noCloudShadow=true;scene.add(particles);
}

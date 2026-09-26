// Same seeded placement/biome definitions as Three.js; geometry and draw budget
// are renderer-specific. This module never mutates folded state.
import { mapGrassArgs, presetStrokes } from '../client/lib/flora_args.js';
import { placeInstances, placeRows, resetFloraOccupancy } from '../shared/flora-placement.js';
import presets from '../defs/flora/_presets.json';
import grass from '../defs/flora/grass.json';
import galleta_dry from '../defs/flora/galleta_dry.json';
import blackbrush from '../defs/flora/blackbrush.json';
import creosote from '../defs/flora/creosote.json';
import sagebrush from '../defs/flora/sagebrush.json';
import yucca from '../defs/flora/yucca.json';
import corn from '../defs/flora/corn.json';
import sunflower from '../defs/flora/sunflower.json';
const species: Record<string, any> = {grass, galleta_dry, blackbrush, creosote, sagebrush, yucca, corn, sunflower};
export function projectFlora(raw: any, heightFn: (x:number,z:number)=>number) {
  if (!raw) return {strokes:[],warnings:[]};
  const warnings:string[]=[]; const strokes:any[]=[];
  resetFloraOccupancy(); let left=12000,candidateBudget=800000;
  try {
    for (const st of presetStrokes(mapGrassArgs(raw),presets).slice(0,16)) {
      const name=st.species==='meadow_blades'?'grass':st.species??'grass', spec=species[name];
      if (!spec) {warnings.push(`Unknown native flora species: ${name}`);continue;}
      const o:any={width:24,depth:24,center:[0,0],seed:7,maxSlope:.9,...st,heightFn};
      o.width=st.width??st.size??24;o.depth=st.depth??st.size??24;
      if (![o.width,o.depth,o.density??1,o.seed,...o.center].every(Number.isFinite) || o.width<=0 || o.depth<=0 || o.width>500 || o.depth>500 || (o.density??1)<0) throw Error('Invalid flora extents/density');
      if (o.rows && ((o.rows.spacing??.76)<.1 || (o.rows.plant??.24)<.05)) throw Error('Flora row spacing below native budget');
      const candidates=o.rows?o.width*o.depth/(o.rows.spacing??.76)/(o.rows.plant??.24)*Math.max(1,o.density??1):o.width*o.depth*1.6*spec.density*(o.density??1)*(o.footprint==='organic'?1.45:1);
      if (!Number.isFinite(candidates)||candidates>800000||candidates>candidateBudget||(spec.footRadius&&candidates>5000)) {warnings.push(`${name}: field exceeds native placement budget`);continue;}
      candidateBudget-=candidates;
      // Large meadows retain the SAME seeded plants as the browser, but only
      // keep a bounded, deterministic reservoir. Never drop an ordinary
      // production field just because it has more plants than we can draw.
      let seen=0, random=(Number(o.seed)>>>0)||1;
      const reservoir:any[]=[];
      if(!o.rows&&candidates>150000){
        o.placementSink=(p:any)=>{++seen;if(reservoir.length<left){reservoir.push(p);return;}
          random=(Math.imul(random,1664525)+1013904223)>>>0;
          const at=Math.floor(random/4294967296*seen);if(at<left)reservoir[at]=p;};
      }
      const generated=o.density===0?[]:o.rows?placeRows(o,spec):placeInstances(o,spec);
      const all=o.placementSink?reservoir:generated;
      const count=Math.min(left,all.length),stride=all.length/Math.max(1,count);
      const placements=Array.from({length:count},(_,i)=>all[Math.floor(i*stride)]);
      if(count<all.length||seen>count)warnings.push(`${name}: native draw cap ${count}/${seen||all.length}`);
      left-=count;
      strokes.push({species:name,archetype:spec.archetype,height:Math.min(5,Math.max(.03,st.height??spec.blades?.h??1)),wind:Math.min(2,Math.max(0,st.wind??1)),color:st.color??null,placements});
    }
  } catch(e) {warnings.push(String(e).slice(0,160));}
  return {strokes,warnings};
}

// bun tools/water/prepare.ts EXPORT_DIR OUTPUT_DIR
// Convert the exported scene to wire coordinates and write a portable authoring
// manifest plus content-addressed GLBs. No sequencer or live world is modified.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {dedup, instance} from '@gltf-transform/functions';
import {createHash} from 'node:crypto';
const [source,output]=process.argv.slice(2,4).map(p=>resolve(p));
if(!source||!output)throw Error('usage: prepare.ts EXPORT_DIR OUTPUT_DIR');
mkdirSync(join(output,'models'),{recursive:true});
const meta=JSON.parse(readFileSync(join(source,'export.json'),'utf8'));
const vessels=JSON.parse(readFileSync(new URL('../../world-data/water/vessels.json',import.meta.url),'utf8'));
const ueLocal=(p:number[])=>convert([p[1]/100,p[2]/100,p[0]/100]);
const corrected=process.argv.includes('--right-handed');
const convert=(p:number[])=>corrected?[-p[0],p[1],p[2]]:p;
const origins:any={terrain:[0,0,0],scenery:[0,0,0],habitat:[13,-30,80],submarine:[-26,-18,60],platform:[60,0,0]};
const verbs:any[]=[],files:any[]=[];
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
for(const name of Object.keys(meta.groups)){
 const file=name==='submarine'?'submarine-source.glb':name+'.glb';
 const doc=await io.read(join(source,file));
 // Visible pool water is not a solid floor. Preserve this semantic as glTF
 // extras so every exact-collision consumer gets the same open moonpool.
 for(const node of doc.getRoot().listNodes())if(['PoolSurface','HatchSurface'].includes(node.getName()))node.setExtras({...node.getExtras(),collision:false});
 await doc.transform(dedup(),instance({min:2}));
 const raw=Buffer.from(await io.writeBinary(doc)),length=raw.readUInt32LE(12);
 const gltf=JSON.parse(raw.subarray(20,20+length).toString());
 if(!gltf.meshes?.length)throw Error(`${file}: export contains no geometry`);
 const bin=raw.subarray(20+length);
 const pos=convert(origins[name]);
 const i=gltf.nodes.length;
 // Unreal glTF is (X,Z,Y), presence is (Y,Z,X). Reflect X/Z exactly once.
 // Blender source exports centimetres, while Unreal exports metres.
 const scale=name==='submarine'?.01:1;
 const translation=name==='submarine'?[0,0,0]:pos.map((v:number)=>-v);
 gltf.nodes.push({name:'wire-coordinate-frame',matrix:[0,0,scale,0,0,scale,0,0,(corrected?-scale:scale),0,0,0,...translation,1],children:gltf.scenes[gltf.scene??0].nodes});
 gltf.scenes[gltf.scene??0].nodes=[i];
 let json=Buffer.from(JSON.stringify(gltf));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
 const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const bytes=Buffer.concat([header,json,bin]);const hash=createHash('sha256').update(bytes).digest('hex');
 const path=`store/models/${hash}.glb`;writeFileSync(join(output,'models',hash+'.glb'),bytes);
 files.push({file:'models/'+hash+'.glb',path,sha256:hash,bytes:bytes.length});
 const id='water-'+name;
 const yaw=name==='submarine'?(corrected?-Math.PI/2:Math.PI/2):0;
 verbs.push({verb:'asset',args:{name:`Unreal ${name}`,path}},{verb:'spawn',args:{id,lib:path,pos,yaw,collide:'exact'}});
 const comp=(type:string,data:any)=>verbs.push({verb:'comp',args:{id,type,data}});
 if(name==='scenery')comp('collision',{enabled:false});
 if(name==='submarine')comp('air',{boxes:vessels.BP_Cyclops.filter((c:any)=>c.extent).map((c:any)=>({center:ueLocal(c.p),size:[c.extent[1]/50,c.extent[2]/50,c.extent[0]/50],q:[0,0,0,1]}))});
 else if(meta.air[name])comp('air',{boxes:meta.air[name].map((b:any)=>({...b,center:convert(b.center).map((v:number,i:number)=>v-pos[i]),q:corrected?[b.q[0],-b.q[1],-b.q[2],b.q[3]]:b.q}))});
 if(name==='terrain'){
  comp('environment',{floor:-260,spawn:convert(meta.spawn),particles:{count:1400,range:16,size:.018},sky:{horizon:'#bedce6',zenith:'#338ac1',sunIntensity:3,ambient:1.5},bounds:{min:[-800,-250,-800],max:[800,100,800]}});
  comp('water',{center:[0,-125,0],size:[2000,250,2000],absorption:[.10,.036,.018],scatter:[.014,.11,.17],speed:2.4,
   waves:[{amplitude:.38,wavelength:24,direction:[.3420201,.9396926],phase:0},{amplitude:.23,wavelength:13.7,direction:[.9063078,.4226183],phase:1.7},{amplitude:.12,wavelength:7.1,direction:[.6156615,-.7880108],phase:3.2},{amplitude:.06,wavelength:3.3,direction:[-.9781476,.2079117],phase:.8}].map(w=>({...w,direction:[corrected?-w.direction[0]:w.direction[0],w.direction[1]]}))});
 }
 const route=(label:string,path:number[][],radius=1.4)=>comp('traversal',{routes:[{name:label,path:path.map(convert),radius,speed:1.25}]});
 if(name==='habitat')route('moonpool ladder',[[0,-1.45,-.2],[0,.15,-.2],[0,.08,-1.1]],1.5);
 if(name==='platform')route('platform ladder',[[-6.05,-1.2,0],[-6.05,2.6,0],[-3.3,2.42,0]],2.2);
 if(name==='submarine'){
  route('hatch ladder',[[0,-3.05,-15.6],[0,-1.55,-15.6],[0,-1.68,-16.8]],1.6);
  comp('vehicle',{helm:[0,-1.7,-2.1],exit:[0,-1.7,-3.2],speed:4,turnRate:.4,minY:-230,maxY:-4,
   probes:[[0,0,0],[2,0,-10],[-2,0,-10],[0,-2.7,-10],[0,3,-10],[0,0,-23]]});
  comp('sockets',{passenger:{pos:convert([1,-1.8,-5]),pose:'sitchair'}});
 }
}
const manifest={version:1,source:meta.world,coordinateSystem:corrected?'metres / Y-up / right-handed (-UE.Y,UE.Z,UE.X)':'metres / Y-up / legacy presence (UE.Y,UE.Z,UE.X)',files,verbs};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({manifest:join(output,'manifest.json'),files:files.length,verbs:verbs.length,bytes:files.reduce((n,f)=>n+f.bytes,0)}));

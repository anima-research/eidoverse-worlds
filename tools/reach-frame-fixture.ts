// Real Avatar reach methods over a real normalized hierarchy, without a GPU.
import {plugin} from 'bun';
import {fileURLToPath} from 'node:url';
const here=(f:string)=>fileURLToPath(new URL(f,import.meta.url));
plugin({name:'reach-frame-fixture',setup(b){for(const name of ['core','assets','loadwork'])b.onResolve({filter:new RegExp('^\\./'+name+'\\.js$')},()=>({path:here('./'+name+'-stub.mjs')}));}});
export const {THREE}=await import('./core-stub.mjs');
const {Avatar}=await import('../client/lib/avatar.js');
const {makeAvatar,rigs,libraryRigs}=await import('./rig-load.mjs');
export const realRigs=()=>[...rigs(),...libraryRigs()].filter((r:any)=>!r.err);
export function frameBody(rig:any){
 const av:any=makeAvatar(rig.P,{realParent:rig.realParent,vrm0:rig.vrm0});av._composed=new Map();
 for(const name of ['_measureChain','setReach','clearReach','reachStatus','_applyReach','_writeBone','_composeBegin','_composeEnd'])av[name]=(Avatar.prototype as any)[name];
 return av;
}
export function frame(av:any,f:number){
 for(const n of Object.values(av.nodes) as any[])n.quaternion.identity();
 av.root.updateMatrixWorld(true);av._applyReach(1/60,f*1000/60);av.root.updateMatrixWorld(true);
}

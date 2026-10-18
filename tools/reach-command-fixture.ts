// Isolate unrelated UI/net services while running the actual /touch and
// /letgo registry handlers, reachnet descriptor path and Avatar methods.
import {mock} from 'bun:test';
import {fileURLToPath} from 'node:url';
export async function commandsFor(getMe:()=>any, messages:string[]) {
  const noop=()=>{};
  const modules:any={
    'base.js':{CONFIG:{name:'owner'},bus:{on:noop,emit:noop},report:noop},
    'capture.js':{captureFrame:noop},
    'world.js':{entities:new Map(),bagOf:()=>null,roleOf:noop,worldHasOwner:()=>false},   // bagOf: handlers.js resolves a thing by its label (R 10-17)
    'net.js':{net:{myId:'owner'},identityOf:()=>null,replicaActive:()=>true,sendRequest:async()=>({ok:true}),sendMod:noop,sendPuppet:noop,sendWorldFork:noop,sendWorldFound:noop,sendWorldReset:noop,requestDebug:noop,sendAnim:noop,sendDrag:noop},
    'remotes.js':{remotes:new Map()},
    'controller.js':{myState:{pos:{x:0,y:0,z:0}},setPosture:noop,flightReport:()=>''},
    'thingphysics.js':{punt:noop,grab:noop,put:noop,drop:noop,throwHeld:noop},'chat.js':{logChat:(_who:string,text:string)=>messages.push(text)},
    'ui.js':{toggleHelp:noop,flashHint:noop,toast:noop},'scenegraph.js':{sceneAttach:noop,sceneDetach:noop},
    'consent.js':{setPushable:noop,pushable:()=>false},'localbody.js':{trySitOn:noop},'mybody.js':{getMe},
    // the door (editwrites send) and /panels' stylepanel: handlers.js imports both, and each reaches the whole edit UI
    'editwrites.js':{send:async()=>({ok:true})},'stylepanel.js':{panelAlpha:()=>1,setPanelAlpha:noop},
  };
  for(const [name,exports] of Object.entries(modules))mock.module(fileURLToPath(new URL('../client/lib/'+name,import.meta.url)),()=>exports as any);
  await import('../client/lib/commands/handlers.js');
  return (await import('../client/lib/commands/registry.js')).dispatch;
}

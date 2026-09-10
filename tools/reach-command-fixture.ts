// Isolate unrelated UI/net services while running the actual /touch and
// /letgo registry handlers, reachnet descriptor path and Avatar methods.
import {mock} from 'bun:test';
import {fileURLToPath} from 'node:url';
export async function commandsFor(getMe:()=>any, messages:string[]) {
  const noop=()=>{};
  const modules:any={
    'base.js':{CONFIG:{name:'owner'},bus:{on:noop,emit:noop},report:noop},
    'capture.js':{captureFrame:noop},
    'world.js':{entities:new Map(),roleOf:noop,worldHasOwner:()=>false},
    'net.js':{net:{myId:'owner'},sendVerb:noop,sendMod:noop,sendPuppet:noop,sendWorldFork:noop,sendWorldReset:noop,requestDebug:noop},
    'remotes.js':{remotes:new Map()},
    'controller.js':{myState:{pos:{x:0,y:0,z:0}},setPosture:noop,flightReport:()=>''},
    'physobj.js':{kick:noop},'chat.js':{logChat:(_who:string,text:string)=>messages.push(text)},
    'ui.js':{toggleHelp:noop,flashHint:noop},'scenegraph.js':{sceneAttach:noop,sceneDetach:noop},
    'consent.js':{setPushable:noop,pushable:()=>false},'localbody.js':{trySitOn:noop},'mybody.js':{getMe},
  };
  for(const [name,exports] of Object.entries(modules))mock.module(fileURLToPath(new URL('../client/lib/'+name,import.meta.url)),()=>exports as any);
  await import('../client/lib/commands/handlers.js');
  return (await import('../client/lib/commands/registry.js')).dispatch;
}

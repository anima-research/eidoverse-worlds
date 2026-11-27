import {plugin} from 'bun';
import {readFileSync} from 'node:fs';
import {pathEnd} from '../gate/common.ts';
const m=JSON.parse(process.env.CONTACT_MUTATION!);
// the filter sees the native path (backslashes on Windows): pathEnd matches either separator
plugin({name:'contact-mutation',setup(b){b.onLoad({filter:new RegExp(pathEnd(m.file))},args=>{
 // a CRLF checkout (autocrlf) reads as LF, so an anchor written with \n matches; a function replacer keeps a $ in `to` literal
 const lf=(t:string)=>t.replace(/\r\n/g,'\n'),s=lf(readFileSync(args.path,'utf8')),from=lf(m.from);if(s.split(from).length!==2)throw new Error('mutation anchor changed');
 console.error('CONTACT_MUTATION_APPLIED');return {contents:s.replace(from,()=>m.to),loader:m.file.endsWith('.ts')?'ts':'js'};
});}});

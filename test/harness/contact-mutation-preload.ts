import {plugin} from 'bun';
import {readFileSync} from 'node:fs';
import {pathEnd} from '../gate/common.ts';
const m=JSON.parse(process.env.CONTACT_MUTATION!);
// the filter sees the native path (backslashes on Windows): pathEnd matches either separator
plugin({name:'contact-mutation',setup(b){b.onLoad({filter:new RegExp(pathEnd(m.file))},args=>{
 const s=readFileSync(args.path,'utf8');if(s.split(m.from).length!==2)throw new Error('mutation anchor changed');
 console.error('CONTACT_MUTATION_APPLIED');return {contents:s.replace(m.from,m.to),loader:m.file.endsWith('.ts')?'ts':'js'};
});}});

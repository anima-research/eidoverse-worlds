import {plugin} from 'bun';
import {readFileSync} from 'node:fs';
const m=JSON.parse(process.env.CONTACT_MUTATION!);
plugin({name:'contact-mutation',setup(b){b.onLoad({filter:new RegExp('/'+m.file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')},args=>{
 const s=readFileSync(args.path,'utf8');if(s.split(m.from).length!==2)throw new Error('mutation anchor changed');
 console.error('CONTACT_MUTATION_APPLIED');return {contents:s.replace(m.from,m.to),loader:m.file.endsWith('.ts')?'ts':'js'};
});}});

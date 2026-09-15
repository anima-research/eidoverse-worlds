// The direct Eanpa source pin is a content receipt, not a README claim.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'vendor', 'eanpa');
const manifest = JSON.parse(await readFile(join(root, 'MANIFEST.json'), 'utf8'));
let pass=0,fail=0;
const check=(name,ok,detail='')=>{console.log(`  ${ok?'✓':'✗'} ${name}${detail?'  '+detail:''}`);ok?pass++:fail++;};
check('manifest pins the reviewed standalone source', manifest.source==='https://github.com/SkyeShark/Eanpa-Sky' && manifest.commit==='a197d3dc42577e9b870b471a39d6b1710c5b5633');
for(const entry of manifest.files){
 const bytes=await readFile(join(root,entry.path));
 const hash=createHash('sha256').update(bytes).digest('hex');
 check(entry.path,bytes.length===entry.bytes&&hash===entry.sha256,`${bytes.length} ${hash.slice(0,12)}`);
}
check('runtime asset closure includes the current cirrus trail texture',manifest.files.some((x)=>x.path==='assets/weather/cirrus_ice_trails.png'));
console.log(`\n${pass} passed, ${fail} failed`);if(fail)process.exit(1);

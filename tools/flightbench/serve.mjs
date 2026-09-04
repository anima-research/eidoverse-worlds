import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
const ROOT = resolve('.');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.css':'text/css', '.vrm':'application/octet-stream',
  '.wasm':'application/wasm', '.png':'image/png', '.jpg':'image/jpeg', '.ktx2':'image/ktx2' };
createServer((req,res)=>{
  const p = decodeURIComponent(new URL(req.url,'http://x').pathname);
  const f = join(ROOT, p);
  if(!f.startsWith(ROOT)||!existsSync(f)||statSync(f).isDirectory()){res.writeHead(404);return res.end('no');}
  res.writeHead(200,{'content-type':MIME[extname(f)]??'application/octet-stream','cache-control':'no-store'});
  res.end(readFileSync(f));
}).listen(8788,'127.0.0.1',()=>console.log('flight bench on http://localhost:8788/tools/flightbench/fly.html'));

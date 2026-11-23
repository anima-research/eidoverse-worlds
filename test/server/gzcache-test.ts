// gzcache-test: the gzip copies serveFrom hands out are bounded (server/gzcache.ts): kept under GZIP_CACHE_MB, least
// recently served first out, and a file over GZIP_MAX_MB is never gzipped. `bun test/server/gzcache-test.ts`
import { suite } from "../gate/suite.ts";
import { gzConfig, gzipOf, gzipsAt, gzStats, gzReset } from "../../server/gzcache.ts";

const S = suite("gzcache");
// random bytes, so a copy's size is about its file's
const bytesOf = (n: number, _seed: number) => crypto.getRandomValues(new Uint8Array(n));
let reads = 0;
const ask = (name: string, n: number, mtime = 1, seed = name.length) => gzipOf(`/f/${name}`, mtime, n, () => { reads++; return bytesOf(n, seed); });

// at the defaults, a body over 32 MB is served plain, by design (gzip holds the serving thread: test/server/gz-stall-test.ts)
S.check("Z0 at the default GZIP_MAX_MB (32) a 30 MB file gzips and a 35 MB avatar is served plain", gzipsAt(30_000_000) && !gzipsAt(35_000_000), gzConfig);
gzConfig.maxBytes = 50_000; gzConfig.maxFile = 30_000; gzReset();
for (let i = 0; i < 10; i++) ask(`a${i}`, 20_000, 1, i);
S.check("the copies kept stay under the byte budget", gzStats().bytes <= 50_000 && gzStats().entries >= 1, gzStats());

gzReset(); reads = 0;
ask("x", 20_000, 1, 1); ask("y", 20_000, 1, 2);
ask("x", 20_000, 1, 1);                       // served again: now the most recent
ask("z", 20_000, 1, 3);                       // over budget: the least recently served (y) goes
reads = 0; ask("x", 20_000, 1, 1); const xKept = reads === 0;
reads = 0; ask("y", 20_000, 1, 2); const yMade = reads === 1;
S.check("least recently served goes first; a recent one is kept", xKept && yMade, { xKept, yMade });

gzReset(); reads = 0;
ask("m", 10_000, 1); ask("m", 10_000, 2);
S.check("a changed file (new mtime) is gzipped again and replaces its old copy", reads === 2 && gzStats().entries === 1 && gzStats().bytes < 11_000, { reads, ...gzStats() });

gzReset(); reads = 0;
const over = ask("big", 30_001);
S.check("a file over GZIP_MAX_MB is not gzipped (null) and not read", over === null && reads === 0 && gzStats().entries === 0);
const at = ask("edge", 30_000);
S.check("...one at the limit is", at instanceof Uint8Array && Bun.gunzipSync(at).length === 30_000);
S.done();

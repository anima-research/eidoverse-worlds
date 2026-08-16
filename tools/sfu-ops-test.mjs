// The operational gaps #104's acceptance table names, pinned.
// Each was PARTIAL or ABSENT in the 2026-08-16 audit.
import { readFileSync } from 'fs';
const S = (p) => readFileSync(new URL(`../server/${p}`, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`ok   ${n}`)) : (fail++, console.log(`FAIL ${n}`)); };

// A1 — the seven refusals must actually RUN on the live path.
const srv = S('server.ts');
check('admitSfuLeg is called from server.ts (not just its own test)', /admitSfuLeg\(/.test(srv));
check('a missing credential is refused', /no credential presented/.test(srv));
check('a refused leg is revoked, not left half-open', /revokeSfuLeg\(c\.world\.name, c\.id\)/.test(srv));

// The client must PRESENT the claim, or the gate has nothing to check.
const cli = readFileSync(new URL('../client/lib/voicesfu.js', import.meta.url), 'utf8');
// 🔴 This asserted `cred: _cred` — the exact TYPO it was written alongside.
// `_cred` was never declared, so sfu-answer threw ReferenceError on every
// client and the gate was never reached; this test passed the whole time,
// because a grep for a string cannot tell a bound identifier from a free one.
// Assert the SHAPE that has to reach the server instead.
check('client returns its credential on sfu-answer',
  /cred: cred && \{/.test(cli) && /nonce: cred\.nonce/.test(cli));
check('the credential the client sends carries all six claims',
  ['world:', 'id:', 'primaryGen:', 'mediaGen:', 'incarnation:', 'nonce:']
    .every((f) => new RegExp(f.replace(':', ':\\s*cred\\.')).test(cli)));

// A2 — supervision exists, and the guard no longer kills the world server.
const guard = S('sfuguard.ts');
check('transport guard never calls process.exit', !/process\.exit/.test(guard));
check('guard is installed explicitly, not from a constructor', !/installSfuTransportGuard\(\)/.test(S('sfu.ts')));
check('server installs the guard at boot', /installSfuTransportGuard\(/.test(srv));
const sup = S('sfusupervisor.ts');
check('voice can be marked degraded without killing the process', /markVoiceDegraded/.test(sup));
check('voice-service is broadcast with the incarnation', /voice-service/.test(srv) && /incarnation/.test(sup));

// FEC — asked for explicitly, not merely inherited from a browser default.
check('offer requests Opus in-band FEC', /useinbandfec=1/.test(S('sfuadapter.ts')));
check('FEC is applied to the offer that is SENT', /withOpusFec\(pc\.localDescription/.test(S('sfuadapter.ts')));

// Negative controls — each matcher must be able to fail.
check('control: a server without the gate is detected', !/admitSfuLeg\(/.test('case "sfu-answer": { void accept(); }'));
check('control: a guard that exits is detected', /process\.exit/.test('function die(){ process.exit(1); }'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

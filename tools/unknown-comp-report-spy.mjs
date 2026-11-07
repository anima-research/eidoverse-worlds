// tools/unknown-comp-report-spy.mjs — client/lib/base.js as the realizer sees it
// in tools/unknown-comp-test.ts: the REAL module (the real bus, the real
// CONFIG), with `report` recorded instead of teed, so the test can say
// whether meeting an unknown component made the realizer report anything.
export * from '../client/lib/base.js';
export const reports = [];
export const report = (where, e) => { reports.push({ where, message: String(e?.message ?? e) }); };

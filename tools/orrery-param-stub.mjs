// orrery-param-test's stand-in for conjure.js's imports (base, icons, ui, net, build, chat): a CONFIG whose ?orrery=
// the test sets before import, a makeSection that hands back the panel's painter, and recorders for the rest.
export const CONFIG = { params: new URLSearchParams(globalThis.__ORRERY_QS ?? ''), name: 'tester', world: 'testworld' };
export const bus = { on() {}, emit() {} };
export const report = () => {};
export const fsvg = () => '';
export const sections = [];
export const makeSection = (title, onOpen) => { sections.push({ title, onOpen }); return {}; };
export const toast = () => {};
export const flashHint = () => {};
export const sendVerb = () => {};
export const net = { myRights: { gen: true } };
export const holdGhost = () => {};
export const logChat = () => {};

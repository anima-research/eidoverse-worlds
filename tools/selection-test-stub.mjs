// selection-test substitutes this for structure_ui.js's hosted imports (core, editwrites, ui,
// realize/structure). Structure mode stays off in the test, so nothing here is ever drawn.
export const THREE = {};
export const scene = { add() {}, remove() {} };
export const camera = { updateMatrixWorld() {} };
export const canvas = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
export const sent = [];
export const sendOps = (ops, meta) => { sent.push({ ops, meta }); };
export const hints = [];
export const flashHint = (t) => { hints.push(String(t)); };
export const setCutaway = () => {};

// debug-tabs-test substitutes this for every neighbour debug.js imports except rows.js (pure DOM) and frames.js
// (the real one). One export table serves core/base/xrpanels/gputime/perf/render/perfscope/three-mesh-bvh/colliders/
// ragdoll/ammodoll/avatar/ui — the names are disjoint. Inert unless a test reads it.
const Inert = class { constructor() {} set() { return this; } add() {} remove() {} copy() { return this; } };
export const THREE = new Proxy({}, { get: () => Inert });
export const scene = { add() {}, remove() {} };
export const bus = { on() {}, emit() {} };
export const registerXRPanel = () => {};
export const xrPanelOpen = () => false;
export const gpuLine = () => '', shadowPassLine = () => '', setGpuTimer = () => {}, gpuTimerOn = () => false;
export const gpuTimerState = () => ({ supported: false });
export const measureShadowPass = async () => ({});
export const perf = {};
export const drawStats = () => ({});
export const MODES = [], setMode = () => {}, activeMode = () => null, setSolid = () => {}, isSolid = () => false;
export const mountPerfPanel = () => {};
export const MeshBVHHelper = Inert;
export const colliders = new Map();
export const closestParams = () => ({});
export const TUNING = {};
export const JOINT_SPECS = { hip: { flex: 90, ext: 10, twist: 20, x: [-10, 10], z: [-10, 10] } }, HAIR_TUNING = {}, WING_TUNING = {};
export const BLINK = {}, WING_IDLE = {}, LIMP_SPRINGS = {};
export const toast = () => {}, paintRangesIn = () => {};

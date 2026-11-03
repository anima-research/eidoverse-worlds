// build-gate-test substitutes this for everything build.js imports. build.js
// does real work AT IMPORT — `new THREE.Raycaster()`, `new THREE.Plane(new
// THREE.Vector3(...))`, claimEscape(), three addEventListeners and two bus.on
// registrations — so every one of those has to be constructible here or the
// module throws before a single assertion runs.
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set() { return this; } setFromMatrixPosition() { return this; } copy() { return this; } add() { return this; } sub() { return this; } addScaledVector() { return this; } applyQuaternion() { return this; } normalize() { return this; } length() { return 0; } distanceTo() { return 0; } clone() { return new V3(this.x, this.y, this.z); } }
class Obj3 {
  constructor() { this.position = new V3(); this.rotation = { y: 0, x: 0, z: 0 }; this.scale = new V3(1, 1, 1); this.quaternion = {}; this.userData = {}; this.children = []; this.visible = true; this.matrixWorld = { decompose() {}, elements: [] }; }
  add(c) { this.children.push(c); } remove() {} traverse(f) { if (f) f(this); }
  updateMatrixWorld() {} getWorldPosition() { return new V3(); } lookAt() {} removeFromParent() {}
}
// EVERY class the two modules construct — gathered in one grep across build.js
// and seatedit.js rather than discovered one failed run at a time. build.js
// runs a lot at import (Raycaster, Plane, Box3Helper, setPointerClaim,
// claimEscape, three addEventListeners) and seatedit adds its own Vector3 and
// two Matrix4s, so every one of these has to be constructible or nothing loads.
export const THREE = {
  Vector3: V3,
  Group: Obj3,
  Mesh: class extends Obj3 { constructor() { super(); this.geometry = { dispose() {} }; this.material = { dispose() {} }; } },
  Object3D: Obj3,
  Box3: class { constructor() { this.min = new V3(); this.max = new V3(); } setFromObject() { return this; } getSize() { return new V3(); } getCenter() { return new V3(); } isEmpty() { return false; } },
  // outline.box.setFromObject(obj) + .visible + .userData — build.js:117-188
  Box3Helper: class extends Obj3 { constructor(box) { super(); this.box = box ?? { setFromObject() {} }; this.geometry = { dispose() {} }; this.material = { dispose() {} }; } },
  Plane: class { constructor() {} setFromNormalAndCoplanarPoint() { return this; } },
  Raycaster: class { constructor() { this.ray = { intersectPlane: () => null }; } setFromCamera() {} intersectObjects() { return []; } intersectObject() { return []; } },
  Quaternion: class { constructor() {} setFromRotationMatrix() { return this; } setFromAxisAngle() { return this; } copy() { return this; } },
  Matrix4: class { constructor() {} copy() { return this; } invert() { return this; } multiply() { return this; } multiplyMatrices() { return this; } makeRotationY() { return this; } decompose() {} extractRotation() { return this; } },
  ConeGeometry: class { constructor() {} dispose() {} },
  OctahedronGeometry: class { constructor() {} dispose() {} },
  MeshBasicMaterial: class { constructor() {} dispose() {} },
  MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
};
export const scene = { add() {}, remove() {} };
export const camera = { position: new V3(), quaternion: {} };
export const canvas = { addEventListener() {}, removeEventListener() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };

const handlers = new Map();
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const report = () => {};

export const loadGLB = async () => new THREE.Object3D();
export const libLabels = new Map();
export const makeLightGizmo = () => new THREE.Object3D();

// world.js also exports findPart, which seatedit.js imports — build.js pulls in
// seatedit at line 31, so the thirteenth module has to be remapped too or the
// REAL seatedit loads and demands a symbol this stub never had. (My first run
// died on exactly that: I stopped reading build.js's imports at line 30.)
export const findPart = () => null;
export const entities = new Map();
export const entityMeta = new Map();
export const comps = new Map();
export const editHolds = new Map();
export const reindexCollider = () => {};
export const heightAt = () => 0;

// THE ONE THAT MATTERS: the gate reads net.myRights. Left undeclared, exactly
// as the real net.js leaves it before a snapshot.
export const net = {};
export const sendVerb = () => {};
export const sendDrag = () => {};

export const myState = { pos: [0, 0, 0], yaw: 0 };
export const mouse = { x: 0, y: 0 };
export const setPointerClaim = () => {};
export const setEditingProbe = () => {};

export const hints = [];
export const flashHint = (t) => { hints.push(String(t)); };
export const collapseAll = () => {};
export const panelFrame = () => ({ show() {}, hide() {}, visible: false });
export const sceneSelect = () => {};
export const claimEscape = () => {};

// seatedit.js — build.js imports ten symbols from it at line 31
export const refreshSeatGizmos = () => {};
export const resetSeats = () => {};
export const armSeatPlacement = () => {};
export const seatArmed = () => null;
export const seatSelected = () => null;
export const cancelSeatArm = () => {};
export const deselectSeat = () => {};
export const seatMouseDown = () => false;
export const seatKeyDown = () => false;
export const updateSeatDrag = () => {};

// Rendering-only instancing for repeated library meshes. The original scene
// graph remains the authority for parts, mounts, editing, picking and collision.
// During ONE synchronous render we suppress only each source mesh's layers
// (never its children), draw its world transform in a small spatial batch, then
// restore everything in finally. No folded state or shared asset is mutated.
import * as THREE from 'three';

const CAPACITY = 64; // fixed UBO layout: changing population never changes WGSL
const CELL = 16;     // metres; avoid a world-wide bounding sphere defeating culling
const IDLE_FRAMES = 120;
const defaults = THREE.Object3D.prototype;
const callbacks = ['onBeforeRender', 'onAfterRender', 'onBeforeShadow', 'onAfterShadow'];

function uniformScale(matrix) {
  const e = matrix.elements;
  const x = e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
  const y = e[4] ** 2 + e[5] ** 2 + e[6] ** 2;
  const z = e[8] ** 2 + e[9] ** 2 + e[10] ** 2;
  return Math.abs(x-y) <= 1e-6*Math.max(x,y) && Math.abs(x-z) <= 1e-6*Math.max(x,z);
}

// Coplanar overlapping copies can change their winning fragments when draws
// are reordered. Keep intersecting bounds on the original path. A sweep along
// X limits comparisons to the local neighbourhood; touching faces are fine.
function overlappingSources(groups) {
  const materials = new Map();
  const relevant = new Set();
  for (const list of groups.values()) if (list.length > 1) relevant.add(list[0].material);
  for (const list of groups.values()) for (const object of list) {
    if (!relevant.has(object.material)) continue;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const entry = { object, box: geometry.boundingBox.clone().applyMatrix4(object.matrixWorld) };
    let entries = materials.get(object.material);
    if (!entries) materials.set(object.material, entries = []);
    entries.push(entry);
  }
  const overlapping = new Set();
  const epsilon = 1e-5;
  const intersects = (a0, a1, b0, b1) => {
    const depth = Math.min(a1,b1) - Math.max(a0,b0);
    return depth > epsilon || (depth >= -epsilon && (a1-a0 <= epsilon || b1-b0 <= epsilon));
  };
  for (const entries of materials.values()) {
    entries.sort((a, b) => a.box.min.x - b.box.min.x);
    let active = [];
    for (const entry of entries) {
      const b = entry.box;
      active = active.filter((a) => a.box.max.x >= b.min.x - epsilon);
      for (const other of active) {
        const a = other.box;
        if (intersects(a.min.x,a.max.x,b.min.x,b.max.x)
          && intersects(a.min.y,a.max.y,b.min.y,b.max.y)
          && intersects(a.min.z,a.max.z,b.min.z,b.max.z)) {
          overlapping.add(entry.object);
          overlapping.add(other.object);
        }
      }
      active.push(entry);
    }
  }
  return overlapping;
}

/** Opt in only library models, after the material factory has dressed them. */
export function markDrawBatchSource(root) {
  root.traverse((o) => { if (o.isMesh) o.userData.drawBatchSource = true; });
}

// InstanceNode's normal transform assumes orthogonal axes. Mirrored, singular
// and sheared transforms stay on Mesh's full inverse-transpose path.
export function instanceTransformSafe(matrix) {
  const e = matrix.elements;
  if (!e.every(Number.isFinite) || matrix.determinant() <= 0) return false;
  const x = e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
  const y = e[4] ** 2 + e[5] ** 2 + e[6] ** 2;
  const z = e[8] ** 2 + e[9] ** 2 + e[10] ** 2;
  return Math.abs(e[0]*e[4] + e[1]*e[5] + e[2]*e[6]) <= 1e-6 * Math.sqrt(x*y)
    && Math.abs(e[0]*e[8] + e[1]*e[9] + e[2]*e[10]) <= 1e-6 * Math.sqrt(x*z)
    && Math.abs(e[4]*e[8] + e[5]*e[9] + e[6]*e[10]) <= 1e-6 * Math.sqrt(y*z);
}

/** Deliberately conservative: a custom shader/callback is an independent draw. */
export function canInstanceMesh(o) {
  if (!o.userData.drawBatchSource || o.userData.noDrawBatch || o.constructor !== THREE.Mesh
    || o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh || !o.frustumCulled
    || o.renderOrder !== 0 || !o.layers.mask || o.customDepthMaterial || o.customDistanceMaterial
    || callbacks.some((k) => o[k] !== defaults[k])) return false;
  const g = o.geometry, m = o.material;
  if (!g || g.isInstancedBufferGeometry || Object.keys(g.morphAttributes).length
    || Object.values(g.attributes).some((a) => a.isInstancedBufferAttribute)) return false;
  if (!m || Array.isArray(m) || !m.visible
    || !(m.isMeshStandardMaterial || m.isMeshStandardNodeMaterial || m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial)
    || m.transparent || m.transmission > 0 || m.transmissionNode || m.alphaHash
    || !m.depthWrite || !m.depthTest || m.stencilWrite || m.blending !== THREE.NormalBlending
    || m.onBeforeRender !== THREE.Material.prototype.onBeforeRender
    || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
    || m.positionNode || m.vertexNode || m.geometryNode || m.fragmentNode
    || m.depthNode || m.backdropNode || m.clippingPlanes?.length) return false;
  return instanceTransformSafe(o.matrixWorld);
}

export class DrawBatches {
  constructor({ warm = null } = {}) {
    this.enabled = true;
    this.warm = warm;
    this.pools = new Map();
    this.frame = 0;
    this.active = false;
    this.hidden = [];
    this.drawn = [];
    this.stats = {};
    this.sphere = new THREE.Sphere();
    this.center = new THREE.Vector3();
    this.frustum = new THREE.Frustum();
    this.projection = new THREE.Matrix4();
    this.inverse = new THREE.Matrix4();
    this.instance = new THREE.Matrix4();
  }

  create(source, key) {
    const mesh = new THREE.InstancedMesh(source.geometry, source.material, CAPACITY);
    mesh.name = 'library draw batch';
    mesh.count = 2; // compile the instanced variant while originals keep drawing
    mesh.layers.mask = source.layers.mask;
    mesh.castShadow = source.castShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false;
    mesh.boundingSphere = new THREE.Sphere();
    mesh.userData = { noWet: true, noCloudShadow: true, noCamCollide: true, noSupportCheck: true };
    mesh.raycast = () => {}; // originals own all interaction, even inside callbacks
    const record = { mesh, ready: !this.warm, retired: false, last: this.frame };
    const geometry = mesh.geometry, material = mesh.material;
    const release = () => {
      if (this.pools.get(key) === record) this.pools.delete(key);
      this.retire(record);
    };
    geometry.addEventListener('dispose', release);
    material.addEventListener('dispose', release);
    record.unlisten = () => {
      geometry.removeEventListener('dispose', release);
      material.removeEventListener('dispose', release);
    };
    if (this.warm) {
      // Defer until AFTER render's temporary hook/layer edits are restored.
      record.pending = Promise.resolve().then(() => {
        if (!record.retired) return this.warm(mesh, () => !record.retired);
      }).then(() => {
        record.ready = true;
      }).catch(() => { record.failed = true; }).finally(() => {
        record.pending = null;
        if (record.retired) mesh.dispose();
      });
    }
    return record;
  }

  retire(record) {
    if (record.retired) return;
    record.retired = true;
    record.unlisten();
    if (!record.pending) record.mesh.dispose(); // instance storage only; assets are borrowed
  }

  prepare(scene, camera) {
    this.frame++;
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection, camera.coordinateSystem, camera.reversedDepth);
    const groups = new Map();
    const stats = this.stats = { eligible: 0, instanced: 0, batches: 0, savedColorDraws: 0,
      warming: 0, failed: 0, overlapping: 0 };
    const visit = (o, blocked = false) => {
      if (!o.visible) return;
      // LOD and clipping groups have camera-dependent subtree semantics.
      blocked ||= !!o.userData.noDrawBatch || !!o.isLOD || !!o.isClippingGroup
        || !!o.isBundleGroup || (!!o.isGroup && o.renderOrder !== 0);
      if (!blocked && o.isMesh && canInstanceMesh(o)) {
        stats.eligible++;
        // Keep per-mesh COLOR culling: grouping a tile must not submit all its
        // high-poly members just because one enters the view. Off-camera
        // sources remain ordinary meshes, so their shadows still render.
        if (o.layers.test(camera.layers) && this.frustum.intersectsObject(o)) {
          const g = o.geometry;
          if (!g.boundingSphere) g.computeBoundingSphere();
          this.center.copy(g.boundingSphere.center).applyMatrix4(o.matrixWorld);
          // r184 InstanceNode transforms normals but NOT tangentLocal. Keep
          // tangent-bearing meshes' common linear transform on the batch and
          // instance only their translations, preserving the authored TBN.
          const e = o.matrixWorld.elements;
          const basis = g.hasAttribute('tangent')
            ? `/${e[0]},${e[1]},${e[2]},${e[4]},${e[5]},${e[6]},${e[8]},${e[9]},${e[10]}` : '';
          const cellKey = `${g.id}/${o.material.id}/${o.layers.mask}/${+o.castShadow}/${+o.receiveShadow}`
            + `/${Math.floor(this.center.x/CELL)},${Math.floor(this.center.y/CELL)},${Math.floor(this.center.z/CELL)}`;
          const key = cellKey + basis;
          let list = groups.get(key);
          if (!list) {
            groups.set(key, list = []);
            // Basis VALUES group this frame; a stable source identity keys the
            // pool. Synchronized spinning copies must not queue a new shader
            // warm for every successive angle.
            list.poolKey = cellKey + (basis ? `/anchor:${o.id}` : '');
          }
          list.push(o);
        }
      }
      // Keep a nonuniformly scaled hierarchy together on the original path.
      // Even its individually orthogonal leaves can change shadow rounding
      // relative to their sheared neighbours (pinned by drawbench's shear case).
      const childrenBlocked = blocked || (o.children.length > 0 && !uniformScale(o.matrixWorld));
      for (const child of o.children) visit(child, childrenBlocked);
    };
    visit(scene);
    const overlapping = overlappingSources(groups);
    stats.overlapping = overlapping.size;
    for (const candidates of groups.values()) {
      const list = candidates.filter((o) => !overlapping.has(o));
      for (let start = 0; start < list.length; start += CAPACITY) {
        const count = Math.min(CAPACITY, list.length - start);
        if (count < 2) continue;
        const chunkKey = `${candidates.poolKey}/${start / CAPACITY}`;
        let record = this.pools.get(chunkKey);
        if (!record) this.pools.set(chunkKey, record = this.create(list[start], chunkKey));
        record.last = this.frame;
        if (!record.ready) { stats[record.failed ? 'failed' : 'warming']++; continue; }
        const mesh = record.mesh;
        mesh.count = count;
        mesh.boundingSphere.makeEmpty();
        const commonBasis = mesh.geometry.hasAttribute('tangent');
        if (commonBasis) {
          mesh.matrixWorld.copy(list[start].matrixWorld);
          this.inverse.copy(mesh.matrixWorld).invert();
        }
        for (let i = 0; i < count; i++) {
          const source = list[start + i];
          let transform = source.matrixWorld;
          if (commonBasis) {
            this.center.setFromMatrixPosition(source.matrixWorld).applyMatrix4(this.inverse);
            transform = this.instance.identity().setPosition(this.center);
          }
          mesh.setMatrixAt(i, transform);
          // Union the SAME bounds the original draws used, including authored
          // padding. Off-camera casters must stay present for the shadow camera.
          this.sphere.copy(source.geometry.boundingSphere).applyMatrix4(transform);
          mesh.boundingSphere.union(this.sphere);
          this.hidden.push([source, source.layers.mask]);
          source.layers.mask = 0;
        }
        mesh.instanceMatrix.needsUpdate = true;
        scene.add(mesh);
        this.drawn.push(mesh);
        stats.instanced += count;
        stats.batches++;
        stats.savedColorDraws += count - 1;
      }
    }
    for (const [key, record] of this.pools) {
      if (this.frame - record.last > IDLE_FRAMES) {
        this.pools.delete(key);
        this.retire(record);
      }
    }
  }

  restore() {
    for (const [source, mask] of this.hidden) source.layers.mask = mask;
    for (const mesh of this.drawn) mesh.removeFromParent();
    this.hidden.length = this.drawn.length = 0;
  }

  render(renderer, scene, camera) {
    // Nested/offscreen/override passes keep their existing semantics.
    if (!this.enabled || this.active || scene.overrideMaterial || camera.isArrayCamera) {
      return renderer.render(scene, camera);
    }
    this.active = true;
    const before = scene.onBeforeRender;
    let prepared = false;
    scene.onBeforeRender = (...args) => {
      before.apply(scene, args);
      // Renderer has updated world matrices and camera projection at this seam.
      // ShadowNode recursively renders this SAME scene through a light camera.
      if (!prepared && args[1] === scene && !args[2].isArrayCamera) {
        prepared = true;
        this.prepare(scene, args[2]);
      }
    };
    try { return renderer.render(scene, camera); }
    finally {
      scene.onBeforeRender = before;
      this.restore();
      this.active = false;
    }
  }

  dispose() {
    this.restore();
    for (const record of this.pools.values()) this.retire(record);
    this.pools.clear();
    this.stats = {};
  }

  debug() {
    return { enabled: this.enabled, ...this.stats, pools: this.pools.size,
      instanceBytes: this.pools.size * CAPACITY * 64 };
  }
}

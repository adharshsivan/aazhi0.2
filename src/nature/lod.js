import * as THREE from 'three';

// Screen-space LOD on top of THREE.BatchedMesh: every asset registers up to three
// LOD geometries in one pooled vertex buffer; each instance points at the LOD
// that matches its projected size and swaps with setGeometryIdAt (no re-upload).
// One BatchedMesh = one multi-draw call (+ one for shadows), with per-object
// frustum culling done by three.js.

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();

export class LODBatch {
  constructor(material, { castShadow = true, name = 'batch' } = {}) {
    this.material = material;
    this.castShadow = castShadow;
    this.name = name;
    this.assets = [];
    this.items = [];
  }

  /** levels: [lod0, lod1, lod2] geometries (lod1/lod2 optional); px: switch thresholds. */
  addAsset(levels, px = [150, 38]) {
    const g0 = levels[0];
    if (!g0.boundingSphere) g0.computeBoundingSphere();
    this.assets.push({ levels, px, radius: g0.boundingSphere.radius, center: g0.boundingSphere.center.clone(), ids: [] });
    return this.assets.length - 1;
  }

  /** minPx: hide when the instance projects smaller than this (ground cover, pebbles). */
  add(asset, matrix, color, minPx = 0) {
    matrix.decompose(_p, _q, _s);
    const a = this.assets[asset];
    const pos = a.center.clone().applyMatrix4(matrix);
    const radius = a.radius * Math.max(_s.x, _s.y, _s.z);
    this.items.push({ asset, matrix: matrix.clone(), color: color || new THREE.Color(1, 1, 1), pos, radius, minPx, level: -2, id: -1 });
    return this.items.length - 1;
  }

  finalize(scene) {
    let verts = 0, idx = 0;
    for (const a of this.assets) {
      const g = a.levels[0];
      verts += g.attributes.position.count;
      idx += g.index.count;
    }
    const mesh = new THREE.BatchedMesh(Math.max(1, this.items.length), Math.max(3, verts), Math.max(3, idx), this.material);
    mesh.name = this.name;
    mesh.sortObjects = false;          // alpha-tested / opaque: skip per-frame sorting
    mesh.perObjectFrustumCulled = true;
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = true;
    for (const a of this.assets) a.ids = [mesh.addGeometry(a.levels[0])];
    for (const it of this.items) {
      const a = this.assets[it.asset];
      it.id = mesh.addInstance(a.ids[0]);
      it.level = 0;
      mesh.setMatrixAt(it.id, it.matrix);
      mesh.setColorAt(it.id, it.color);   // always set: keeps the batching-colour shader path stable
      mesh.setVisibleAt(it.id, true);
    }
    scene.add(mesh);
    this.mesh = mesh;
    this.stats = { instances: this.items.length, geometries: this.assets.length, vertices: verts, indices: idx };
    return mesh;
  }

  /** Locked high-detail mode: instances permanently retain LOD 0 without geometry swaps or popping. */
  update() {
    return 0;
  }

  /** Triangles drawn per LOD level right now (for diagnostics). */
  census() {
    const out = { hidden: 0, l0: 0, l1: 0, l2: 0, tris: 0 };
    for (const it of this.items) {
      if (it.level < 0) { out.hidden++; continue; }
      out['l' + it.level]++;
      out.tris += this.assets[it.asset].levels[it.level].index.count / 3;
    }
    return out;
  }
}

/** Drives all batches: re-evaluates LODs only when the camera moved or the viewport changed. */
export class LODManager {
  constructor(batches, bias = 1) { this.batches = batches; this.bias = bias; this.last = new THREE.Vector3(1e9, 0, 0); this.lastK = 0; }
  update(camera, viewportH, force = false) {
    const k = ((viewportH / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * this.bias;
    if (!force && camera.position.distanceToSquared(this.last) < 0.5 && Math.abs(k - this.lastK) < 1) return;
    this.last.copy(camera.position); this.lastK = k;
    for (const b of this.batches) b.update(camera.position, k);
  }
}

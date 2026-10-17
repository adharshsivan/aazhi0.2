import * as THREE from 'three';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const STEP_UP = 0.6;     // max climb per move (curbs, stairs, planters)
const STEP_DOWN = 0.65;  // max drop: prevents walking off seawalls, platforms, piers
const RADIUS = 0.3;

/** Merge walkable geometries (positions only) into one BVH-accelerated mesh. */
export function buildWalkMesh(geos) {
  let total = 0;
  const parts = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    total += ng.attributes.position.array.length;
    return ng.attributes.position.array;
  });
  const arr = new Float32Array(total);
  let o = 0;
  for (const a of parts) { arr.set(a, o); o += a.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.computeBoundsTree();
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  return mesh;
}

function makeCharacter() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x8d5a3b, roughness: 0.7 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x2f7d6d, roughness: 0.8 });
  const mundu = new THREE.MeshStandardMaterial({ color: 0xf3efe4, roughness: 0.9 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 0.9 });
  const mk = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  const torso = mk(new THREE.CapsuleGeometry(0.2, 0.45, 4, 8), shirt, 0, 1.22, 0);
  torso.scale.set(1.05, 1, 0.75);
  mk(new THREE.SphereGeometry(0.13, 12, 10), skin, 0, 1.68, 0);
  mk(new THREE.SphereGeometry(0.135, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2), hair, 0, 1.7, -0.01);
  const legs = [], arms = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 0.1, 0.9, 0); g.add(hip);
    mk(new THREE.CylinderGeometry(0.085, 0.07, 0.86, 8), mundu, 0, -0.43, 0, hip);
    mk(new THREE.BoxGeometry(0.12, 0.06, 0.24), hair, 0, -0.87, 0.04, hip);
    legs.push(hip);
    const sh = new THREE.Group(); sh.position.set(s * 0.27, 1.45, 0); g.add(sh);
    mk(new THREE.CylinderGeometry(0.05, 0.045, 0.62, 8), skin, 0, -0.31, 0, sh);
    arms.push(sh);
  }
  return { group: g, legs, arms };
}

export class Player {
  constructor(scene, walkMesh, colliders) {
    this.walkMesh = walkMesh;
    this.colliders = colliders;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    const c = makeCharacter();
    this.mesh = c.group; this.legs = c.legs; this.arms = c.arms;
    scene.add(this.mesh);
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.phase = 0;
    this.speed = 0;
  }

  groundAt(x, z, fromY, up = STEP_UP, down = STEP_DOWN) {
    this.ray.set(new THREE.Vector3(x, fromY + up, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = up + down;
    const hit = this.ray.intersectObject(this.walkMesh, false)[0];
    if (!hit) return null;
    if (hit.point.y < -0.25) return null;     // knee-deep water: turn back
    return hit.point.y;
  }

  spawn(x, z, heading) {
    const y = this.groundAt(x, z, 50, 0, 100);
    this.pos.set(x, y ?? 2, z);
    this.heading = heading;
    this.sync();
  }

  collide(x, z, y) {
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.colliders) {
        if (c.y0 !== undefined && y < c.y0) continue;
        if (c.y1 !== undefined && y > c.y1) continue;
        if (c.type === 'circle') {
          const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), m = c.r + RADIUS;
          if (d < m && d > 1e-6) { x = c.x + dx / d * m; z = c.z + dz / d * m; }
        } else {
          const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
          // world -> local (local x -> (cos, -sin), local z -> (sin, cos))
          const dx = x - c.x, dz = z - c.z;
          let lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
          const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
          let ex = lx - qx, ez = lz - qz;
          const d = Math.hypot(ex, ez);
          if (d < RADIUS) {
            if (d > 1e-6) { lx = qx + ex / d * RADIUS; lz = qz + ez / d * RADIUS; }
            else {
              // inside the box: push out along the shallowest axis
              const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
              if (px < pz) lx = Math.sign(lx || 1) * (c.hw + RADIUS); else lz = Math.sign(lz || 1) * (c.hd + RADIUS);
            }
            x = c.x + lx * cs + lz * sn; z = c.z - lx * sn + lz * cs;
          }
        }
      }
    }
    return [x, z];
  }

  tryMove(nx, nz) {
    const [cx, cz] = this.collide(nx, nz, this.pos.y);
    const y = this.groundAt(cx, cz, this.pos.y);
    if (y === null) return false;
    this.pos.x = cx; this.pos.z = cz; this.targetY = y;
    return true;
  }

  update(dt, input, camYaw) {
    let mx = 0, mz = 0;
    if (input.forward) mz -= 1;
    if (input.back) mz += 1;
    if (input.left) mx -= 1;
    if (input.right) mx += 1;
    const moving = mx !== 0 || mz !== 0;
    const run = input.run;
    const target = moving ? (run ? 6.2 : 3.0) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    if (moving) {
      const l = Math.hypot(mx, mz); mx /= l; mz /= l;
      // camera-relative: forward = away from camera
      const sx = Math.sin(camYaw), cx = Math.cos(camYaw);
      const wx = mx * cx + mz * sx, wz = -mx * sx + mz * cx;
      const want = Math.atan2(wx, wz);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 12);
    }
    if (this.speed > 0.01) {
      const step = this.speed * dt;
      const dx = Math.sin(this.heading) * step, dz = Math.cos(this.heading) * step;
      if (!this.tryMove(this.pos.x + dx, this.pos.z + dz)) {
        if (!this.tryMove(this.pos.x + dx, this.pos.z)) this.tryMove(this.pos.x, this.pos.z + dz);
      }
    }
    if (this.targetY !== undefined) {
      const k = this.targetY > this.pos.y ? 18 : 12;
      this.pos.y += (this.targetY - this.pos.y) * Math.min(1, dt * k);
    }
    // walk cycle
    this.phase += dt * this.speed * 2.6;
    const sw = Math.sin(this.phase) * Math.min(1, this.speed / 3) * 0.55;
    this.legs[0].rotation.x = sw; this.legs[1].rotation.x = -sw;
    this.arms[0].rotation.x = -sw * 0.8; this.arms[1].rotation.x = sw * 0.8;
    this.sync();
  }

  sync() {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;
  }
}

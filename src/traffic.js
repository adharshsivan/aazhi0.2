import * as THREE from 'three';
import { G } from './layout.js';

// Simple ring-road traffic. Kerala drives on the left; vehicles yield to the
// player and keep a gap to the vehicle ahead in the same direction.

function wheel(mat, r = 0.33, w = 0.22) {
  const g = new THREE.CylinderGeometry(r, r, w, 12);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, mat);
}

function makeVehicle(kind, color, T) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a2129, roughness: 0.15, metalness: 0.5 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  let length = 4.2;
  if (kind === 'car') {
    add(new THREE.BoxGeometry(4.2, 0.7, 1.75), paint, 0, 0.6, 0);
    add(new THREE.BoxGeometry(2.3, 0.62, 1.6), dark, -0.25, 1.25, 0);
    add(new THREE.BoxGeometry(2.0, 0.08, 1.55), paint, -0.3, 1.58, 0);
    for (const x of [-1.35, 1.35]) for (const z of [-0.8, 0.8]) add(wheel(tyre).geometry, tyre, x, 0.33, z);
  } else if (kind === 'auto') {
    length = 2.7;
    const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
    const black = new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.6 });
    add(new THREE.BoxGeometry(2.6, 0.75, 1.3), yellow, 0, 0.65, 0);
    add(new THREE.BoxGeometry(0.7, 0.9, 1.2), dark, 0.95, 1.45, 0);
    add(new THREE.BoxGeometry(2.0, 0.12, 1.4), black, -0.1, 1.95, 0);
    add(new THREE.BoxGeometry(0.08, 0.9, 1.3), black, -1.05, 1.45, 0);
    add(wheel(tyre, 0.25, 0.15).geometry, tyre, 1.1, 0.25, 0);
    for (const z of [-0.6, 0.6]) add(wheel(tyre, 0.25, 0.15).geometry, tyre, -0.8, 0.25, z);
  } else if (kind === 'bus') {
    length = 10.5;
    const side = new THREE.MeshStandardMaterial({ map: T.busSide, roughness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
    add(new THREE.BoxGeometry(10.5, 2.7, 2.5), [dark, white, white, tyre, side, side], 0, 1.75, 0);
    for (const x of [-3.4, 3.4]) for (const z of [-1.05, 1.05]) add(wheel(tyre, 0.48, 0.3).geometry, tyre, x, 0.48, z);
  }
  g.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  return { group: g, length };
}

export function buildTraffic(scene, data, T) {
  const ring = data.roads.ring;
  const L = ring.pl.length;
  const specs = [
    { kind: 'bus', color: 0x1f6fb5, dir: 1, s: 0.08, speed: 7 },
    { kind: 'car', color: 0xd9dde2, dir: 1, s: 0.35, speed: 9 },
    { kind: 'auto', color: 0, dir: 1, s: 0.62, speed: 7 },
    { kind: 'car', color: 0x8c1d22, dir: -1, s: 0.2, speed: 9.5 },
    { kind: 'car', color: 0x2c3e50, dir: -1, s: 0.55, speed: 8.5 },
    { kind: 'auto', color: 0, dir: -1, s: 0.85, speed: 6.5 },
  ];
  const vehicles = specs.map((sp) => {
    const v = makeVehicle(sp.kind, sp.color, T);
    scene.add(v.group);
    return { ...sp, ...v, s: sp.s * L, v: sp.speed };
  });
  const lane = 1.75;
  const place = (veh) => {
    const p = ring.pl.at(veh.s);
    const hx = p.tx * veh.dir, hz = p.tz * veh.dir;
    const lx = hz, lz = -hx;               // driver's left
    veh.x = p.x + lx * lane; veh.z = p.z + lz * lane;
    veh.hx = hx; veh.hz = hz;
    veh.group.position.set(veh.x, G, veh.z);
    veh.group.rotation.y = Math.atan2(-hz, hx);
  };
  vehicles.forEach(place);

  return {
    vehicles,
    update(dt, player) {
      for (const veh of vehicles) {
        let target = veh.speed;
        // gap to vehicle ahead (same direction)
        for (const o of vehicles) {
          if (o === veh || o.dir !== veh.dir) continue;
          let gap = (o.s - veh.s) * veh.dir;
          gap = ((gap % L) + L) % L;
          const need = (o.length + veh.length) / 2 + 4;
          if (gap < need + 8) target = Math.min(target, Math.max(0, (gap - need) * 0.8));
        }
        // yield to the player standing in front
        if (player) {
          const dx = player.x - veh.x, dz = player.z - veh.z;
          const ahead = dx * veh.hx + dz * veh.hz;
          const side = Math.abs(dx * -veh.hz + dz * veh.hx);
          if (ahead > 0 && ahead < veh.length / 2 + 7 && side < 2.6 && player.y < G + 1.0) target = 0;
        }
        const a = target > veh.v ? 2.5 : 7;
        veh.v += Math.sign(target - veh.v) * Math.min(Math.abs(target - veh.v), a * dt);
        veh.s = (((veh.s + veh.v * dt * veh.dir) % L) + L) % L;
        place(veh);
      }
    },
  };
}

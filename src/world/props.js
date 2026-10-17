import * as THREE from 'three';
import { boxGeo, ringArea, rng } from '../geom.js';
import { WALK, ROADS } from '../layout.js';
import { beachHeight } from './terrain.js';

// Street furniture, beach dressing and boats.
export function buildProps(ctx) {
  streetLights(ctx);
  benches(ctx);
  beach(ctx);
  return boats(ctx);
}

function lampParts() {
  const pole = new THREE.CylinderGeometry(0.07, 0.11, 6.4, 8); pole.translate(0, 3.2, 0);
  const arm = boxGeo(0.08, 0.08, 1.6, 1); arm.translate(0, 6.3, 0.75);
  const head = boxGeo(0.32, 0.12, 0.6, 1); head.translate(0, 6.22, 1.5);
  const glow = boxGeo(0.26, 0.03, 0.5, 1); glow.translate(0, 6.15, 1.5);
  return { pole, arm, head, glow };
}

function streetLights(ctx) {
  const { M, data: D } = ctx;
  const L = lampParts();
  const ring = D.roads.ring;
  const outSign = ringArea(ring.pts) > 0 ? 1 : -1;
  const avoid = [...D.crossings.map((c) => [c.x, c.z, c.width / 2 + 3.5])];
  for (const name of ['avenue', 'lane']) {
    const r = D.roads[name];
    for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) avoid.push([p[0], p[1], 10]);
  }
  const ok = (x, z) => avoid.every(([ax, az, d]) => Math.hypot(ax - x, az - z) > d);
  D.lamps = [];
  const place = (x, z, fx, fz) => {
    if (!ok(x, z)) return;
    D.lamps.push([x, z]);
    const ry = Math.atan2(fx, fz);
    for (const [g, m] of [[L.pole, M.metalDark], [L.arm, M.metalDark], [L.head, M.metalDark]]) ctx.batch.add(g, m, x, WALK, z, ry);
    ctx.batch.add(L.glow, M.lampGlow, x, WALK, z, ry, { noShadow: true });
    ctx.colliders.push({ type: 'circle', x, z, r: 0.22 });
  };
  // outer edge of the ring road, arm reaching over the carriageway
  for (let s = 4; s < ring.pl.length; s += 17) {
    const p = ring.pl.at(s);
    const nx = p.tz * outSign, nz = -p.tx * outSign;
    const off = ROADS.ring.width / 2 + 0.6;
    place(p.x + nx * off, p.z + nz * off, -nx, -nz);
  }
  // avenue east side
  const av = D.roads.avenue;
  for (let s = 9; s < av.pl.length - 6; s += 16) {
    const p = av.pl.at(s);
    const nx = -p.tz, nz = p.tx; // right-hand normal (east for southbound)
    const off = ROADS.avenue.width / 2 + 0.6;
    place(p.x - nx * off, p.z - nz * off, nx, nz);
  }
}

function benches(ctx) {
  const { M, data: D } = ctx;
  const pl = D.outlinePL;
  const outSign = ringArea(D.outline) > 0 ? 1 : -1;
  const spots = [[-40, 37], [-20, 41], [12, 42.5], [-60, 0], [-56, -28], [56, 20], [-5, -50], [40, -44]];
  for (const [tx, tz] of spots) {
    const s = pl.project(tx, tz);
    const p = pl.at(s);
    const nx = p.tz * outSign, nz = -p.tx * outSign;
    const x = p.x - nx * 1.0, z = p.z - nz * 1.0;
    if (D.palmSpots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 2.2)) continue;
    const ry = Math.atan2(nx, nz);   // seat faces the sea
    ctx.batch.add(boxGeo(1.8, 0.08, 0.45, 1), M.wood, x, WALK + 0.45, z, ry);
    ctx.batch.add(boxGeo(1.8, 0.4, 0.06, 1), M.wood, x - nx * 0.22, WALK + 0.72, z - nz * 0.22, ry);
    for (const sx of [-0.75, 0.75]) {
      ctx.batch.add(boxGeo(0.06, 0.45, 0.45, 1), M.metalDark, x + nz * sx, WALK + 0.22, z - nx * sx, ry);
    }
    ctx.colliders.push({ type: 'box', x, z, hw: 0.95, hd: 0.3, rot: ry });
  }
}

function beach(ctx) {
  const { M, data: D } = ctx;
  D.beachKeepOut = [];   // umbrella + lounger sets: rocks, pebbles and footprints stay clear
  for (const [x, z] of [[-21, 46.5], [-13, 48], [-4, 46.8]]) {
    D.beachKeepOut.push([x, z + 0.6, 2.3]);
    const y = beachHeight(x, z);
    ctx.batch.add(new THREE.CylinderGeometry(0.035, 0.035, 2.5, 6), M.metalDark, x, y + 1.25, z);
    const cone = new THREE.ConeGeometry(1.5, 0.55, 12, 1, true);
    ctx.batch.add(cone, M.umbrellaBlue, x, y + 2.4, z);
    ctx.batch.add(new THREE.ConeGeometry(0.55, 0.22, 12, 1, true), M.umbrellaWhite, x, y + 2.62, z);
    ctx.colliders.push({ type: 'circle', x, z, r: 0.2 });
    for (const dx of [-0.9, 0.9]) {
      const lx = x + dx, lz = z + 1.2;
      const ly = beachHeight(lx, lz);
      ctx.batch.add(boxGeo(0.65, 0.08, 1.9, 1), M.whitePaint, lx, ly + 0.3, lz, 0, { rx: -0.08 });
      ctx.batch.add(boxGeo(0.65, 0.08, 0.7, 1), M.whitePaint, lx, ly + 0.55, lz - 0.85, 0, { rx: 0.9 });
      ctx.colliders.push({ type: 'box', x: lx, z: lz, hw: 0.35, hd: 1.0, rot: 0 });
    }
  }
}

// ---------------------------------------------------------------------------
function hullGeometry(len, h, w) {
  const g = new THREE.BoxGeometry(len, h, w, 6, 2, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = x / (len / 2);                      // -1 stern .. 1 bow
    let k = t > 0.3 ? 1 - Math.pow((t - 0.3) / 0.7, 1.6) * 0.95 : 1;
    if (y < 0) k *= 0.7;                           // narrower keel
    const bowLift = t > 0.5 && y > 0 ? (t - 0.5) * 0.3 : 0;
    p.setXYZ(i, x, y + bowLift, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function makeBoat(ctx, kind) {
  const { M } = ctx;
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  if (kind === 'ferry') {
    add(hullGeometry(9.5, 1.2, 3.2), M.hullWhite, 0, 0.35, 0);
    add(hullGeometry(9.6, 0.25, 3.25), M.hullBlue, 0, 0.75, 0);
    add(boxGeo(5.6, 1.6, 2.7, 1), M.hullWhite, -0.6, 1.75, 0);
    add(boxGeo(5.0, 0.6, 2.75, 1), M.darkGlass, -0.6, 2.0, 0);
    add(boxGeo(6.6, 0.18, 3.3, 1), M.blueRoof, -0.6, 2.65, 0);
  } else if (kind === 'skiff') {
    add(hullGeometry(5, 0.7, 1.7), M.hullWhite, 0, 0.2, 0);
    add(hullGeometry(5.05, 0.15, 1.72), M.hullBlue, 0, 0.45, 0);
    add(boxGeo(0.9, 0.5, 1.0, 1), M.darkGlass, -0.2, 0.75, 0);
  } else {
    add(hullGeometry(6, 0.8, 2.1), M.hullWhite, 0, 0.25, 0);
    add(hullGeometry(6.05, 0.15, 2.12), M.hullRed, 0, 0.55, 0);
    add(boxGeo(1.4, 0.6, 1.6, 1), M.darkGlass, 0.2, 0.9, 0);
  }
  return g;
}

function boats(ctx) {
  const { data: D, scene, M } = ctx;
  const items = [];
  const pier = D.pier;
  // ferry moored on the south side of the pier arm
  const ferry = makeBoat(ctx, 'ferry');
  const c = Math.cos(pier.armRot), s = Math.sin(pier.armRot);
  const A = [32.4, 52.2], B = [50, 57.2];
  const u = 0.45, v = 3.4;
  ferry.position.set(A[0] + (B[0] - A[0]) * u + v * s, 0, A[1] + (B[1] - A[1]) * u + v * c);
  ferry.rotation.y = pier.armRot;
  scene.add(ferry);
  items.push({ obj: ferry, base: ferry.position.clone(), rot: ferry.rotation.y, phase: 0 });
  // small skiff by the platform
  const skiff = makeBoat(ctx, 'skiff');
  skiff.position.set(26, 0, 57.5); skiff.rotation.y = 0.2;
  scene.add(skiff);
  items.push({ obj: skiff, base: skiff.position.clone(), rot: skiff.rotation.y, phase: 1.3 });
  // mooring buoys
  for (const [x, z] of [[36, 63], [42, 64.5], [20, 60]]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), M.buoy);
    b.position.set(x, 0.1, z); b.castShadow = true;
    scene.add(b);
    items.push({ obj: b, base: b.position.clone(), rot: 0, phase: x });
  }
  // speedboat cruising offshore (east), trailing a soft V wake that rides the swell
  const speed = makeBoat(ctx, 'speed');
  scene.add(speed);
  const wakeTex = (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    const r = rng(515);
    for (let i = 0; i < 1400; i++) {
      const u = r(), x = 256 * (1 - u);
      const spread = 6 + u * 26;
      const side = r() < 0.5 ? -1 : 1;
      const arm = r() < 0.7;
      const y = 32 + (arm ? side * spread * (0.85 + r() * 0.3) : (r() - 0.5) * spread * 0.5);
      g.fillStyle = `rgba(255,255,255,${(0.18 + r() * 0.3) * Math.pow(1 - u, 1.4)})`;
      g.beginPath(); g.arc(x, y, 0.8 + r() * 2.2 * (1 - u * 0.5), 0, 6.3); g.fill();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const wakeGeo = new THREE.PlaneGeometry(16, 4, 32, 4);
  wakeGeo.rotateX(-Math.PI / 2);
  wakeGeo.translate(-10.4, 0, 0);
  const wake = new THREE.Mesh(wakeGeo, new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0.8, depthWrite: false }));
  wake.renderOrder = 2;
  wake.frustumCulled = false;
  scene.add(wake);
  const wakeBase = Float32Array.from(wakeGeo.attributes.position.array);
  let t = 0;
  // float on the shared wave surface: heave from the local height, pitch/roll from its slope
  const ride = (obj, base, rot, heightAt, time, draft = 0) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    const x = obj.position.x, z = obj.position.z;
    const h = heightAt(x, z, time);
    const hb = heightAt(x + c * 1.6, z - s * 1.6, time), hs = heightAt(x + s * 0.9, z + c * 0.9, time);
    obj.position.y = base + h - draft;
    obj.rotation.set(0, rot, 0);
    obj.rotateZ(Math.atan2(hb - h, 1.6) * 0.8);
    obj.rotateX(-Math.atan2(hs - h, 0.9) * 0.8);
  };
  return {
    update(dt, time, heightAt) {
      for (const it of items) {
        if (heightAt) ride(it.obj, it.base.y, it.rot, heightAt, time);
        else { it.obj.position.y = it.base.y + Math.sin(time * 1.3 + it.phase) * 0.07; it.obj.rotation.y = it.rot; }
      }
      t += dt * 0.045;
      const cx = 105, cz = 5, rx = 34, rz = 50;
      const x = cx + Math.cos(t) * rx, z = cz + Math.sin(t) * rz;
      const dx = -Math.sin(t) * rx, dz = Math.cos(t) * rz;
      const ry = Math.atan2(-dz, dx);
      speed.position.set(x, 0, z);
      if (heightAt) ride(speed, 0.05, ry, heightAt, time); else { speed.position.y = 0.05; speed.rotation.y = ry; }
      speed.rotateZ(0.06);
      const c = Math.cos(ry), s = Math.sin(ry), p = wakeGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const lx = wakeBase[i * 3], lz = wakeBase[i * 3 + 2];
        const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
        p.setXYZ(i, wx, (heightAt ? heightAt(wx, wz, time) : 0) + 0.03, wz);
      }
      p.needsUpdate = true;
    },
  };
}

import * as THREE from 'three';
import { boxGeo, rectPoly, pointInPolys } from '../geom.js';
import { G, WALK, METRO } from '../layout.js';

// Alignment frame: local x along the track, local z across (+z = south side), origin at station centre.
export function metroFrame() {
  const [sx, sz] = METRO.station;
  const len = Math.hypot(1, METRO.slope);
  const dx = 1 / len, dz = METRO.slope / len;
  const angle = Math.atan2(-dz, dx);              // rotation.y that maps local x -> (dx, dz)
  const toWorld = (u, v) => [sx + u * dx + v * Math.sin(angle), sz + u * dz + v * Math.cos(angle)];
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(sx, 0, sz),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(1, 1, 1));
  return { sx, sz, dx, dz, angle, toWorld, matrix };
}

const STAIR = { x0: -12.6, flight: 24, tread: 0.3, width: 2.6, z0: 8.2, landing: 2.0 };

/** Footprint polygons (world) used to keep planting clear of the station and its stairs. */
export function stationFootprint() {
  const f = metroFrame();
  const L = METRO.stationLen, W = METRO.stationWidth;
  const stairEnd = STAIR.x0 + 2 * STAIR.flight * STAIR.tread + STAIR.landing + 3;
  return [
    rectPoly(...f.toWorld(0, 0), L + 3, W + 3, f.angle),
    rectPoly(...f.toWorld((STAIR.x0 - 1 + stairEnd) / 2, STAIR.z0 + STAIR.width / 2),
      stairEnd - STAIR.x0 + 3, STAIR.width + 3, f.angle),
  ];
}

export function buildMetro(ctx) {
  const { M, batch } = ctx;
  const f = metroFrame();
  const P = f.matrix;
  const deck = METRO.deckTop, plat = METRO.platformTop;
  const L = METRO.stationLen, W = METRO.stationWidth, HL = METRO.halfLength;
  const add = (geo, mat, x, y, z, ry = 0, o = {}) => batch.add(geo, mat, x, y, z, ry, { ...o, parent: P });

  // ---- viaduct deck (box girder) --------------------------------------------------
  const deckW = 8.4;
  for (const [a, b] of [[-HL, -L / 2], [L / 2, HL]]) {
    const len = b - a, cx = (a + b) / 2;
    add(boxGeo(len, 1.0, deckW, 4, 1), M.concrete, cx, deck - 0.5, 0);
    add(boxGeo(len, 0.9, 5.2, 4, 1), M.concreteDark, cx, deck - 1.45, 0);     // girder web
    for (const s of [-1, 1]) add(boxGeo(len, 0.9, 0.3, 4, 1), M.concrete, cx, deck + 0.45, s * (deckW / 2 - 0.15)); // parapets
  }
  // ballast/track bed + rails, continuous through the station
  add(boxGeo(2 * HL, 0.12, 7.2, 2.0, 2.0), M.trackBed, 0, deck + 0.06, 0, 0, { noShadow: true });
  const railGeo = boxGeo(2 * HL, 0.16, 0.08, 4);
  for (const t of [-2.1, 2.1]) for (const g of [-0.72, 0.72]) add(railGeo, M.steel, 0, deck + 0.2, t + g, 0, { noShadow: true });

  // ---- piers ---------------------------------------------------------------------
  const plate = ctx.data.plate;
  const colGeo = new THREE.CylinderGeometry(1.0, 1.1, 1, 16);
  const capGeo = boxGeo(2.4, 1.2, 7.0, 2);
  for (let u = L / 2 + 8; u < HL; u += METRO.pierSpacing) {
    for (const uu of [u, -u]) {
      const [wx, wz] = f.toWorld(uu, 0);
      const onLand = pointInPolys(wx, wz, plate);
      const base = onLand ? WALK - 0.1 : -4;
      const top = deck - 1.9;
      add(colGeo, M.concrete, uu, (base + top) / 2, 0, 0, { sy: top - base });
      add(capGeo, M.concrete, uu, top - 0.3, 0);
      if (onLand) ctx.colliders.push({ type: 'circle', x: wx, z: wz, r: 1.25 });
    }
  }

  // ---- station -------------------------------------------------------------------
  // ground level: columns + glazed ticket hall under the south platform
  for (const u of [-L / 2 + 1.5, -5, 5, L / 2 - 1.5]) {
    for (const v of [-6.5, 0, 6.5]) {
      if (Math.abs(v) < 1 && Math.abs(u) < 6) continue;
      add(boxGeo(1.0, deck - WALK, 1.0, 1), M.concrete, u, (deck + WALK) / 2 - 0.6, v);
      const [wx, wz] = f.toWorld(u, v);
      ctx.colliders.push({ type: 'circle', x: wx, z: wz, r: 0.75, y1: WALK + 3 });
    }
  }
  const hall = { u0: -9, u1: 9, v0: 0.8, v1: 7.4, h: 4.6 };
  add(boxGeo(hall.u1 - hall.u0, hall.h, hall.v1 - hall.v0, 3, 2.3), M.glass,
    (hall.u0 + hall.u1) / 2, WALK + hall.h / 2, (hall.v0 + hall.v1) / 2);
  add(boxGeo(hall.u1 - hall.u0 + 0.6, 0.4, hall.v1 - hall.v0 + 0.6, 2), M.whitePaint,
    (hall.u0 + hall.u1) / 2, WALK + hall.h + 0.2, (hall.v0 + hall.v1) / 2);
  {
    const [wx, wz] = f.toWorld((hall.u0 + hall.u1) / 2, (hall.v0 + hall.v1) / 2);
    ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: (hall.u1 - hall.u0) / 2 + 0.3, hd: (hall.v1 - hall.v0) / 2 + 0.3, rot: f.angle, y1: WALK + 4 });
  }
  // station deck slab under the tracks and platforms
  add(boxGeo(L, 1.0, deckW, 4, 1), M.concrete, 0, deck - 0.5, 0);
  for (const s of [-1, 1]) {
    const g = add(boxGeo(L, plat - deck + 0.9, W / 2 - 4.2, 3, 1), M.concrete, 0, (plat + deck - 0.9) / 2, s * (4.2 + (W / 2 - 4.2) / 2));
    ctx.walk.push(g);
    // tactile edge strip
    add(boxGeo(L, 0.02, 0.5, 1), M.lineYellow, 0, plat + 0.01, s * 4.5, 0, { noShadow: true });
    // platform edge colliders handled by the drop rule; benches
    for (const u of [-8, 0, 8]) {
      add(boxGeo(2.2, 0.45, 0.5, 1), M.wood, u, plat + 0.25, s * 6.9);
      const [wx, wz] = f.toWorld(u, s * 6.9);
      ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: 1.15, hd: 0.3, rot: f.angle, y0: plat - 0.5 });
    }
  }
  // upper hall: glass curtain walls on the long sides (door opening on the south at the stair head)
  const wallH = 6.4;
  const door = { u0: STAIR.x0 + 2 * STAIR.flight * STAIR.tread + STAIR.landing, w: 2.6 };
  door.u1 = door.u0 + door.w;
  const glassPanel = (u0, u1, v) => {
    if (u1 - u0 < 0.05) return;
    add(boxGeo(u1 - u0, wallH, 0.08, 2, 2), M.glassClear, (u0 + u1) / 2, plat + wallH / 2, v, 0, { noShadow: true });
    const [wx, wz] = f.toWorld((u0 + u1) / 2, v);
    ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: (u1 - u0) / 2, hd: 0.2, rot: f.angle, y0: plat - 1 });
  };
  glassPanel(-L / 2, L / 2, -W / 2);
  glassPanel(-L / 2, door.u0, W / 2);
  glassPanel(door.u1, L / 2, W / 2);
  add(boxGeo(door.w, wallH - 2.6, 0.08, 2, 2), M.glassClear, (door.u0 + door.u1) / 2, plat + 2.6 + (wallH - 2.6) / 2, W / 2, 0, { noShadow: true });
  // end walls over platforms with portal header over tracks
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      add(boxGeo(0.08, wallH, W / 2 - 4.3, 2, 2), M.glassClear, su * L / 2, plat + wallH / 2, sv * (4.3 + (W / 2 - 4.3) / 2), 0, { noShadow: true });
      const [wx, wz] = f.toWorld(su * L / 2, sv * (4.3 + (W / 2 - 4.3) / 2));
      ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: 0.2, hd: (W / 2 - 4.3) / 2, rot: f.angle, y0: plat - 1 });
    }
    add(boxGeo(0.6, 1.6, deckW, 1), M.whitePaint, su * L / 2, plat + wallH - 0.8, 0);
  }
  // mullions
  for (let u = -L / 2; u <= L / 2 + 0.01; u += 3) {
    for (const v of [-W / 2, W / 2]) add(boxGeo(0.14, wallH, 0.14, 1), M.metalDark, u, plat + wallH / 2, v);
  }
  // roof: barrel vault clad in solar panels
  const roofY = plat + wallH;
  add(boxGeo(L + 1.2, 0.5, W + 1.2, 2), M.whitePaint, 0, roofY + 0.25, 0);
  const vault = new THREE.CylinderGeometry(W / 2 + 0.4, W / 2 + 0.4, L + 0.8, 24, 1, true, 0, Math.PI);
  vault.rotateZ(Math.PI / 2);
  const vuv = vault.attributes.uv;
  for (let i = 0; i < vuv.count; i++) vuv.setXY(i, vuv.getX(i) * 6, vuv.getY(i) * 7);
  add(vault, M.solar, 0, roofY + 0.5, 0, 0, { sy: 0.38 });
  // tall glazed stair/lift tower at the east end (station landmark, carries the M sign)
  const tw = { u: L / 2 - 3.2, v: W / 2 + 2.2, w: 5, d: 4.4, h: roofY + 3 - WALK };
  add(boxGeo(tw.w, tw.h, tw.d, 2.5, 2.3), M.glass, tw.u, WALK + tw.h / 2, tw.v);
  add(boxGeo(tw.w + 0.4, 0.4, tw.d + 0.4, 2), M.whitePaint, tw.u, WALK + tw.h + 0.2, tw.v);
  add(boxGeo(2.6, 2.6, 0.1, 2.6), M.signMetro, tw.u, roofY + 0.6, tw.v + tw.d / 2 + 0.06, 0, { noShadow: true });
  {
    const [wx, wz] = f.toWorld(tw.u, tw.v);
    ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: tw.w / 2 + 0.2, hd: tw.d / 2 + 0.2, rot: f.angle });
  }
  add(boxGeo(2.0, 2.0, 0.1, 2.0), M.signMetro, -L / 2 + 3, roofY - 1.6, W / 2 + 0.08, 0, { noShadow: true });

  // ---- external stair from forecourt to the south platform -----------------------
  const nSteps = STAIR.flight * 2;
  const rise = (plat - WALK) / nSteps;
  const sv = STAIR.z0 + STAIR.width / 2;
  let u = STAIR.x0;
  for (let k = 1; k <= nSteps; k++) {
    if (k === STAIR.flight + 1) {
      const top = WALK + STAIR.flight * rise;
      const g = add(boxGeo(STAIR.landing, 0.3, STAIR.width, 1), M.concrete, u + STAIR.landing / 2, top - 0.15, sv);
      ctx.walk.push(g);
      add(boxGeo(0.5, top - WALK, 0.5, 1), M.concrete, u + STAIR.landing / 2, (top + WALK) / 2, sv);
      u += STAIR.landing;
    }
    const top = WALK + k * rise;
    const g = add(boxGeo(STAIR.tread + 0.02, 0.22, STAIR.width, 1), M.concrete, u + STAIR.tread / 2, top - 0.11, sv);
    ctx.walk.push(g);
    u += STAIR.tread;
  }
  // stair head landing joins the platform through the door
  const headLen = door.u1 - u + 0.4;
  {
    const g = add(boxGeo(headLen, 0.3, STAIR.width + 0.4, 1), M.concrete, u + headLen / 2, plat - 0.15, sv - 0.2);
    ctx.walk.push(g);
  }
  // stringers / soffit slabs
  const runLen = STAIR.flight * STAIR.tread, runRise = STAIR.flight * rise;
  const slope = Math.atan2(runRise, runLen);
  const fl1 = STAIR.x0 + runLen / 2, fl2 = STAIR.x0 + runLen + STAIR.landing + runLen / 2;
  for (const [cu, cy] of [[fl1, WALK + runRise / 2], [fl2, WALK + runRise * 1.5]]) {
    add(boxGeo(Math.hypot(runLen, runRise), 0.3, STAIR.width, 2), M.concreteDark, cu, cy - 0.35, sv, 0, { rz: slope });
    for (const s of [-1, 1]) {
      add(boxGeo(Math.hypot(runLen, runRise), 0.06, 0.06, 1), M.railing, cu, cy + 1.0, sv + s * (STAIR.width / 2 - 0.05), 0, { rz: slope });
    }
  }
  // columns under the head landing
  add(boxGeo(0.5, plat - WALK, 0.5, 1), M.concrete, u + 0.6, (plat + WALK) / 2, sv);
  // canopy over stairs
  add(boxGeo(u - STAIR.x0 + headLen, 0.15, STAIR.width + 1.0, 2), M.glassClear, (STAIR.x0 + u + headLen) / 2, plat + 3.2, sv, 0, { noShadow: true });
  // keep people at ground level from walking under the stair (low treads stay walkable)
  {
    const u0 = STAIR.x0 + 4 * STAIR.tread, u1 = u + headLen;
    const [wx, wz] = f.toWorld((u0 + u1) / 2, sv);
    ctx.colliders.push({ type: 'box', x: wx, z: wz, hw: (u1 - u0) / 2, hd: STAIR.width / 2 + 0.1, rot: f.angle, y1: WALK + 0.5 });
  }
  // stair side guards (outer edge) as colliders above landing level are handled by drop rule

  ctx.data.metro = { frame: f, stairBottom: f.toWorld(STAIR.x0 - 1.5, sv), deck, plat };

  // ---- train ---------------------------------------------------------------------
  const train = buildTrain(ctx);
  ctx.scene.add(train.group);
  return train;
}

function buildTrain(ctx) {
  const { M, T } = ctx;
  const f = metroFrame();
  const group = new THREE.Group();
  const carLen = 13.6, gap = 0.8, h = 3.3, w = 2.8;
  const sideMat = new THREE.MeshStandardMaterial({ map: T.trainSide, roughness: 0.4, metalness: 0.2 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8edf1, roughness: 0.35, metalness: 0.3 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x1f4e9a, roughness: 0.3, metalness: 0.2 });
  const winMat = new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 0.1, metalness: 0.5 });
  const cars = [];
  for (let i = 0; i < 2; i++) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(carLen, h, w), [bodyMat, bodyMat, bodyMat, M.metalDark, sideMat, sideMat]);
    body.position.y = h / 2 + 0.55;
    car.add(body);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, carLen, 12, 1, false, 0, Math.PI), bodyMat);
    roof.rotation.z = Math.PI / 2; roof.scale.set(0.18, 1, 1); roof.position.y = h + 0.55;
    car.add(roof);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(carLen - 1, 0.5, w - 0.3), M.metalDark);
    skirt.position.y = 0.4; car.add(skirt);
    // cab nose on the outer end
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.4, h - 0.2, w - 0.1), noseMat);
    nose.geometry.translate(0.7, 0, 0);
    const p = nose.geometry.attributes.position;
    for (let k = 0; k < p.count; k++) if (p.getX(k) > 1 && p.getY(k) > 0) p.setX(k, 0.5);
    nose.geometry.computeVertexNormals();
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.1), winMat);
    const dir = i === 0 ? 1 : -1;
    nose.position.set(dir * carLen / 2, h / 2 + 0.55, 0);
    nose.scale.x = dir;
    car.add(nose);
    glass.rotation.order = 'ZYX';
    glass.rotation.set(0, Math.PI / 2, Math.atan2(0.9, 3.1));
    glass.position.set(0.73, 0.85, 0);
    nose.add(glass);
    car.position.x = (i === 0 ? 1 : -1) * (carLen / 2 + gap / 2);
    car.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(car);
    cars.push(car);
  }
  // Shuttle: far west -> station (dwell) -> far east (turn back, switch track) -> station -> ...
  const far = METRO.halfLength - 40;
  const train = {
    group, s: -far * 0.35, v: 0, dir: 1, track: 2.1, target: 0, state: 'run', wait: 0, next: null,
    update(dt) {
      const vmax = 17, acc = 1.1;
      if (this.state === 'wait') {
        this.wait -= dt;
        if (this.wait <= 0) { this.next(); this.state = 'run'; }
      } else {
        const dist = (this.target - this.s) * this.dir;
        const vBrake = Math.sqrt(Math.max(0, 2 * acc * dist));
        this.v = Math.max(0.6, Math.min(vmax, this.v + acc * dt, vBrake));
        this.s += Math.min(this.v * dt, Math.max(dist, 0)) * this.dir;
        if (dist <= 0.02) {
          this.v = 0; this.state = 'wait';
          if (this.target === 0) {
            this.wait = 14;
            this.next = () => { this.target = this.dir * far; };
          } else {
            this.wait = 3;
            this.next = () => { this.dir *= -1; this.track = -this.track; this.target = 0; };
          }
        }
      }
      const [x, z] = f.toWorld(this.s, this.track);
      group.position.set(x, METRO.deckTop + 0.15, z);
      group.rotation.y = f.angle;
    },
  };
  return train;
}

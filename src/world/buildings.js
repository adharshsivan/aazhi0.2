import * as THREE from 'three';
import { boxGeo, rng } from '../geom.js';
import { WALK, APARTMENT, GRAFFITI, CAFE, PAVILION, SHOP, BUS_SHELTERS } from '../layout.js';

const box = (ctx, w, h, d, mat, x, y, z, ry = 0, tw = 1, th = tw, o = {}) =>
  ctx.batch.add(boxGeo(w, h, d, tw, th), mat, x, y, z, ry, o);

/** Small shrub clumps placed on balconies/roofs; consumed by vegetation.js. */
function plant(ctx, x, y, z, s = 0.5) { (ctx.data.smallPlants ||= []).push([x, y, z, s]); }

export function buildBuildings(ctx) {
  apartment(ctx);
  graffiti(ctx);
  shop(ctx);
  cafe(ctx);
  pavilion(ctx);
  BUS_SHELTERS.forEach((b) => busShelter(ctx, b));
  pierHut(ctx);
}

// ---------------------------------------------------------------------------
function apartment(ctx) {
  const { M } = ctx;
  const A = APARTMENT;
  const H = A.floors * A.floorH;
  const y0 = WALK;
  box(ctx, A.w, H, A.d, M.aptWall, A.x, y0 + H / 2, A.z, 0, 3, A.floorH);
  ctx.colliders.push({ type: 'box', x: A.x, z: A.z, hw: A.w / 2 + 0.1, hd: A.d / 2 + 0.1, rot: 0 });
  const r = rng(101);
  for (let f = 1; f <= A.floors; f++) {
    const y = y0 + f * A.floorH;
    box(ctx, A.w + 0.5, 0.28, A.d + 0.5, M.aptSlab, A.x, y - 0.14, A.z);
    if (f === A.floors) break;
    // south balconies (two per floor), east balcony strip
    for (const bx of [-3.8, 3.8]) {
      const cx = A.x + bx, cz = A.z + A.d / 2 + 0.75;
      box(ctx, 6.6, 0.25, 1.5, M.aptSlab, cx, y - 0.12, cz);
      box(ctx, 6.6, 0.9, 0.12, M.aptSlab, cx, y + 0.45, cz + 0.7);
      box(ctx, 6.2, 0.35, 0.44, M.soil, cx, y + 1.05, cz + 0.48);
      for (let k = 0; k < 4; k++) plant(ctx, cx - 2.4 + k * 1.6 + (r() - 0.5) * 0.25, y + 1.22, cz + 0.48, 0.34 + r() * 0.12);
    }
    {
      const cx = A.x + A.w / 2 + 0.7, cz = A.z;
      box(ctx, 1.4, 0.25, A.d - 2, M.aptSlab, cx, y - 0.12, cz);
      box(ctx, 0.12, 0.9, A.d - 2, M.aptSlab, cx + 0.65, y + 0.45, cz);
      box(ctx, 0.44, 0.35, A.d - 2.6, M.soil, cx + 0.42, y + 1.05, cz);
      for (let k = 0; k < 3; k++) plant(ctx, cx + 0.42, y + 1.22, cz - 3.4 + k * 3.4 + (r() - 0.5) * 0.4, 0.34 + r() * 0.12);
    }
    // wood fins
    for (const fx of [-A.w / 2 + 0.2, 0, A.w / 2 - 0.2]) box(ctx, 0.25, A.floorH - 0.3, 0.3, M.aptAccent, A.x + fx, y - A.floorH / 2, A.z + A.d / 2 + 0.05);
  }
  // roof: penthouse, garden, tank
  const roofY = y0 + H;
  box(ctx, A.w + 0.2, 1.0, A.d + 0.2, M.aptSlab, A.x, roofY + 0.5, A.z, 0, 1);
  box(ctx, 8, 3.2, 6.5, M.aptWall, A.x - 2.5, roofY + 1.6, A.z - 1.5, 0, 3, 3.2);
  box(ctx, 8.6, 0.3, 7.1, M.aptSlab, A.x - 2.5, roofY + 3.35, A.z - 1.5);
  box(ctx, 5, 0.5, 4, M.leafPlanter, A.x + 4.2, roofY + 1.15, A.z + 2.8);
  for (let k = 0; k < 6; k++) plant(ctx, A.x + 2.5 + r() * 3.4, roofY + 1.4, A.z + 1.3 + r() * 3.0, 0.45 + r() * 0.25);
  ctx.batch.add(new THREE.CylinderGeometry(1, 1, 1.8, 14), M.whitePaint, A.x + 3.8, roofY + 1.9, A.z - 3.5);
  // entrance (south, at grade): glass doors + canopy
  box(ctx, 3.2, 2.6, 0.2, M.darkGlass, A.x, WALK + 1.3, A.z + A.d / 2 + 0.05);
  box(ctx, 4.4, 0.18, 2.2, M.aptSlab, A.x, WALK + 2.9, A.z + A.d / 2 + 1.1);
}

// ---------------------------------------------------------------------------
function graffiti(ctx) {
  const { M } = ctx;
  const B = GRAFFITI;
  const H = B.floors * B.floorH;
  box(ctx, B.w, H, B.d, M.grafWall, B.x, WALK + H / 2, B.z, 0, 3, B.floorH);
  ctx.colliders.push({ type: 'box', x: B.x, z: B.z, hw: B.w / 2 + 0.1, hd: B.d / 2 + 0.1, rot: 0 });
  // mural on the south face (faces the island centre / default camera)
  const mural = new THREE.PlaneGeometry(B.w, H);
  ctx.batch.add(mural, M.mural, B.x, WALK + H / 2, B.z + B.d / 2 + 0.03, 0, { noShadow: true });
  // floor bands + east balconies
  const r = rng(202);
  for (let f = 1; f < B.floors; f++) {
    const y = WALK + f * B.floorH;
    box(ctx, B.w + 0.3, 0.22, B.d + 0.06, M.concrete, B.x + 0.15, y, B.z - 0.03);
    for (const bz of [-3, 3]) {
      const cx = B.x + B.w / 2 + 0.6, cz = B.z + bz;
      box(ctx, 1.2, 0.2, 4.6, M.concrete, cx, y, cz);
      for (let k = 0; k <= 5; k++) box(ctx, 0.05, 1.0, 0.05, M.metalDark, cx + 0.55, y + 0.5, cz - 2.25 + k * 0.9);
      box(ctx, 0.06, 0.06, 4.6, M.metalDark, cx + 0.55, y + 1.0, cz);
      if (r() > 0.5) {
        const pz = cz + (r() - 0.5) * 2.6;
        box(ctx, 0.46, 0.28, 0.46, M.concrete, cx + 0.15, y + 0.24, pz);
        box(ctx, 0.38, 0.06, 0.38, M.soil, cx + 0.15, y + 0.36, pz);
        plant(ctx, cx + 0.15, y + 0.38, pz, 0.34);
      }
    }
  }
  // roof parapet, AC units, tank
  const roofY = WALK + H;
  box(ctx, B.w + 0.3, 0.8, 0.3, M.concrete, B.x, roofY + 0.4, B.z - B.d / 2);
  box(ctx, B.w + 0.3, 0.8, 0.3, M.concrete, B.x, roofY + 0.4, B.z + B.d / 2);
  box(ctx, 0.3, 0.8, B.d, M.concrete, B.x - B.w / 2, roofY + 0.4, B.z);
  box(ctx, 0.3, 0.8, B.d, M.concrete, B.x + B.w / 2, roofY + 0.4, B.z);
  for (const [ax, az] of [[-2, -2], [0, -2], [2.5, 1.5]]) box(ctx, 1.4, 1.0, 1.0, M.acUnit, B.x + ax, roofY + 0.5, B.z + az);
  box(ctx, 3, 2.6, 3, M.concrete, B.x - 3, roofY + 1.3, B.z + 3, 0, 1);
  ctx.batch.add(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 12), M.blueRoof, B.x + 3.5, roofY + 0.8, B.z - 3.5);
  // east entrance (faces the inner lane)
  box(ctx, 0.2, 2.6, 3.0, M.darkGlass, B.x + B.w / 2 + 0.05, WALK + 1.3, B.z);
  box(ctx, 2.0, 0.18, 4.0, M.concrete, B.x + B.w / 2 + 1.0, WALK + 2.9, B.z);
}

// ---------------------------------------------------------------------------
function shop(ctx) {
  const { M } = ctx;
  const S = SHOP;
  // small kiosk + pergola with glass roof in front of the graffiti block
  box(ctx, 4.2, 2.8, 3.2, M.plainWall, S.x - 2.2, WALK + 1.4, S.z, 0, 3, 3.2);
  box(ctx, 4.0, 2.0, 0.06, M.shopfront, S.x - 2.2, WALK + 1.2, S.z + 1.62, 0, 4, 2, { noShadow: true });
  box(ctx, 4.6, 0.6, 0.15, M.awning, S.x - 2.2, WALK + 2.6, S.z + 1.75);
  ctx.colliders.push({ type: 'box', x: S.x - 2.2, z: S.z, hw: 2.2, hd: 1.7, rot: 0 });
  for (const px of [-S.w / 2 + 0.2, 0, S.w / 2 - 0.2]) for (const pz of [-S.d / 2 + 0.2, S.d / 2 - 0.2]) {
    if (px < 0) continue;   // kiosk occupies the west bay
    box(ctx, 0.18, 3.0, 0.18, M.metalDark, S.x + px, WALK + 1.5, S.z + pz);
    ctx.colliders.push({ type: 'circle', x: S.x + px, z: S.z + pz, r: 0.25 });
  }
  for (let k = 0; k <= 6; k++) box(ctx, 0.1, 0.16, S.d, M.metalDark, S.x - S.w / 2 + k * (S.w / 6), WALK + 3.05, S.z);
  box(ctx, S.w, 0.05, S.d, M.glassClear, S.x, WALK + 3.15, S.z, 0, 2, 2, { noShadow: true });
  // two tables
  for (const tx of [1.5, 3.3]) table(ctx, S.x + tx, S.z + 0.2, false);
}

function table(ctx, x, z, umbrella = true) {
  const { M } = ctx;
  ctx.batch.add(new THREE.CylinderGeometry(0.45, 0.45, 0.05, 12), M.whitePaint, x, WALK + 0.75, z);
  ctx.batch.add(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 6), M.metalDark, x, WALK + 0.375, z);
  for (const a of [0, Math.PI]) box(ctx, 0.4, 0.45, 0.4, M.wood, x + Math.cos(a) * 0.75, WALK + 0.225, z + Math.sin(a) * 0.75);
  if (umbrella) {
    ctx.batch.add(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), M.metalDark, x, WALK + 1.2, z);
    ctx.batch.add(new THREE.ConeGeometry(1.4, 0.5, 8, 1, true), M.umbrellaWhite, x, WALK + 2.4, z);
  }
  ctx.colliders.push({ type: 'circle', x, z, r: 0.9 });
}

// ---------------------------------------------------------------------------
function cafe(ctx) {
  const { M } = ctx;
  const C = CAFE;
  const x0 = C.x - C.w / 2, z1 = C.z + C.d / 2;
  box(ctx, C.w, C.h, C.d, M.plainWall, C.x, WALK + C.h / 2, C.z, 0, 3, 3.2);
  ctx.colliders.push({ type: 'box', x: C.x, z: C.z, hw: C.w / 2 + 0.1, hd: C.d / 2 + 0.1, rot: 0 });
  // storefront glazing (west + south) and signage band
  box(ctx, 0.06, 3.2, C.d - 0.6, M.shopfront, x0 - 0.04, WALK + 1.6, C.z, 0, 2.6, 3.2, { noShadow: true });
  box(ctx, C.w - 0.6, 3.2, 0.06, M.shopfront, C.x, WALK + 1.6, z1 + 0.04, 0, 2.6, 3.2, { noShadow: true });
  box(ctx, 0.3, 1.1, C.d + 0.4, M.metalDark, x0 - 0.2, WALK + 3.75, C.z);
  box(ctx, C.w + 0.4, 1.1, 0.3, M.metalDark, C.x, WALK + 3.75, z1 + 0.2);
  // sign faces (texture readable from outside)
  ctx.batch.add(new THREE.PlaneGeometry(8, 0.9), M.signTea, C.x, WALK + 3.75, z1 + 0.37, 0, { noShadow: true });
  ctx.batch.add(new THREE.PlaneGeometry(8, 0.9), M.signTea, x0 - 0.37, WALK + 3.75, C.z, -Math.PI / 2, { noShadow: true });
  // door (west, at grade)
  box(ctx, 0.1, 2.4, 1.8, M.darkGlass, x0 - 0.08, WALK + 1.2, C.z - 2.5);
  // roof terrace: parapet, planters, AC units, small stair hut
  const roofY = WALK + C.h;
  box(ctx, C.w, 0.7, 0.25, M.whitePaint, C.x, roofY + 0.35, C.z - C.d / 2);
  box(ctx, C.w, 0.7, 0.25, M.whitePaint, C.x, roofY + 0.35, z1);
  box(ctx, 0.25, 0.7, C.d, M.whitePaint, x0, roofY + 0.35, C.z);
  box(ctx, 0.25, 0.7, C.d, M.whitePaint, C.x + C.w / 2, roofY + 0.35, C.z);
  box(ctx, C.w - 1, 0.45, 0.8, M.soil, C.x, roofY + 0.25, z1 - 0.6);
  box(ctx, 0.8, 0.45, C.d - 1, M.soil, x0 + 0.6, roofY + 0.25, C.z);
  const r = rng(303);
  for (let k = 0; k < 9; k++) plant(ctx, x0 + 1 + k * 1.3, roofY + 0.47, z1 - 0.6, 0.36 + r() * 0.16);
  for (let k = 0; k < 6; k++) plant(ctx, x0 + 0.6, roofY + 0.47, C.z - 4 + k * 1.6, 0.36 + r() * 0.16);
  for (const [ax, az] of [[3.5, -3], [5, -3], [3.5, -1.2], [5, -1.2]]) box(ctx, 1.2, 0.9, 1.0, M.acUnit, C.x + ax, roofY + 0.45, C.z + az);
  box(ctx, 3, 2.4, 2.6, M.plainWall, C.x - 2, roofY + 1.2, C.z - 3, 0, 3, 3.2);
  // terrace with umbrella tables (south)
  for (const [tx, tz] of [[-4, 3], [0, 3.2], [4, 3], [-2, 6], [2.2, 6.2]]) table(ctx, C.x + tx, z1 + tz);
  // planter strip edging the terrace
  box(ctx, C.w + 1, 0.5, 0.64, M.concrete, C.x, WALK + 0.25, z1 + 8.6);
  box(ctx, C.w + 0.76, 0.08, 0.46, M.soil, C.x, WALK + 0.48, z1 + 8.6);
  for (let k = 0; k < 8; k++) plant(ctx, C.x - C.w / 2 + 0.35 + k * 1.75, WALK + 0.51, z1 + 8.6, 0.38);
  ctx.colliders.push({ type: 'box', x: C.x, z: z1 + 8.6, hw: (C.w + 1) / 2, hd: 0.35, rot: 0 });
}

// ---------------------------------------------------------------------------
function pavilion(ctx) {
  const { M } = ctx;
  const P = PAVILION;
  const s = P.size;
  // laterite plinth with steps on two sides
  const plinthTop = WALK + 0.32;
  const g = box(ctx, s, 0.32, s, M.stone, P.x, WALK + 0.16, P.z, 0, 2);
  ctx.walk.push(g);
  // posts
  const postY = plinthTop + 1.4;
  for (const px of [-1, 1]) for (const pz of [-1, 1]) {
    box(ctx, 0.28, 2.8, 0.28, M.woodDark, P.x + px * (s / 2 - 0.5), postY, P.z + pz * (s / 2 - 0.5));
    ctx.colliders.push({ type: 'circle', x: P.x + px * (s / 2 - 0.5), z: P.z + pz * (s / 2 - 0.5), r: 0.3 });
  }
  for (const px of [-1, 1]) box(ctx, 0.25, 0.25, s - 0.6, M.woodDark, P.x + px * (s / 2 - 0.5), plinthTop + 2.85, P.z);
  for (const pz of [-1, 1]) box(ctx, s - 0.6, 0.25, 0.25, M.woodDark, P.x, plinthTop + 2.85, P.z + pz * (s / 2 - 0.5));
  // two-tier Kerala hip roof (pyramids rotated 45deg)
  const roof1 = new THREE.ConeGeometry((s + 1.6) / Math.SQRT2, 1.5, 4, 1, true);
  const roof2 = new THREE.ConeGeometry((s - 1.2) / Math.SQRT2, 1.6, 4, 1, false);
  const ruv = (gm, k) => { const uv = gm.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k / 2); };
  ruv(roof1, 6); ruv(roof2, 4);
  ctx.batch.add(roof1, M.roofTiles, P.x, plinthTop + 3.6, P.z, Math.PI / 4);
  ctx.batch.add(roof2, M.roofTiles, P.x, plinthTop + 4.55, P.z, Math.PI / 4);
  box(ctx, 0.5, 0.6, 0.5, M.woodDark, P.x, plinthTop + 5.4, P.z);
  // benches
  for (const pz of [-1, 1]) {
    box(ctx, s - 2.2, 0.12, 0.5, M.wood, P.x, plinthTop + 0.45, P.z + pz * (s / 2 - 1.1));
    ctx.colliders.push({ type: 'box', x: P.x, z: P.z + pz * (s / 2 - 1.1), hw: (s - 2.2) / 2, hd: 0.3, rot: 0 });
  }
}

// ---------------------------------------------------------------------------
function busShelter(ctx, b) {
  const { M } = ctx;
  const m = new THREE.Matrix4().compose(new THREE.Vector3(b.x, WALK, b.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot), new THREE.Vector3(1, 1, 1));
  const add = (geo, mat, x, y, z, o = {}) => ctx.batch.add(geo, mat, x, y, z, 0, { ...o, parent: m });
  const L = 5, Dp = 1.8;
  // back faces local -z; open side local +z faces the road
  add(boxGeo(L, 2.1, 0.05, 2.5), M.glassClear, 0, 1.2, -Dp / 2 + 0.1, { noShadow: true });
  for (const x of [-L / 2 + 0.1, L / 2 - 0.1]) add(boxGeo(0.1, 2.6, 0.1, 1), M.metalDark, x, 1.3, -Dp / 2 + 0.1);
  add(boxGeo(L + 0.4, 0.12, Dp + 0.4, 1), M.whitePaint, 0, 2.66, 0.1, { rx: -0.06 });
  add(boxGeo(0.06, 2.1, Dp - 0.3, 1), M.glassClear, L / 2 - 0.1, 1.2, 0, { noShadow: true });
  add(boxGeo(0.12, 1.8, 1.1, 1), M.teal, -L / 2 + 0.1, 1.2, -0.1);
  add(boxGeo(3.2, 0.08, 0.45, 1), M.wood, 0, 0.48, -Dp / 2 + 0.45);
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const wx = (lx, lz) => [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
  const [bx, bz] = wx(0, -Dp / 2 + 0.3);
  ctx.colliders.push({ type: 'box', x: bx, z: bz, hw: L / 2, hd: 0.35, rot: b.rot });
  // flag pole stop sign
  const [px, pz] = wx(L / 2 + 0.6, 0.6);
  ctx.batch.add(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), M.metalDark, px, WALK + 1.3, pz);
  ctx.batch.add(boxGeo(0.6, 0.6, 0.04, 0.6), M.teal, px, WALK + 2.4, pz, b.rot);
}

// ---------------------------------------------------------------------------
function pierHut(ctx) {
  const { M } = ctx;
  const deck = ctx.data.pier.deckTop;
  const cx = 28, cz = 51.6, s = 4.6;
  for (const px of [-1, 1]) for (const pz of [-1, 1]) {
    box(ctx, 0.22, 2.6, 0.22, M.wood, cx + px * s / 2, deck + 1.3, cz + pz * s / 2);
    ctx.colliders.push({ type: 'circle', x: cx + px * s / 2, z: cz + pz * s / 2, r: 0.25 });
  }
  const roof = new THREE.ConeGeometry((s + 1.4) / Math.SQRT2, 1.4, 4, 1, false);
  ctx.batch.add(roof, M.blueRoof, cx, deck + 3.3, cz, Math.PI / 4);
  box(ctx, s + 0.3, 0.2, s + 0.3, M.wood, cx, deck + 2.6, cz);
  box(ctx, s - 0.6, 0.1, 0.45, M.wood, cx, deck + 0.45, cz + s / 2 - 0.35);
  for (const px of [-1, 1]) box(ctx, 0.1, 0.45, 0.4, M.wood, cx + px * (s / 2 - 0.6), deck + 0.22, cz + s / 2 - 0.35);
  ctx.colliders.push({ type: 'box', x: cx, z: cz + s / 2 - 0.35, hw: s / 2 - 0.3, hd: 0.3, rot: 0 });
}

import * as THREE from 'three';
import { offsetPolys, pointInPolys, ringArea, rectPoly, intersection, difference, circlePoly } from '../geom.js';
import { WALK, GREEN_TOP, G, JUNCTIONS, APARTMENT, GRAFFITI, CAFE, SHOP, PAVILION, BUS_SHELTERS, PLAZAS, PATHS, BEACH, SWELL_FROM } from '../layout.js';
import { beachHeight } from '../world/terrain.js';
import { metroFrame, stationFootprint } from '../world/metro.js';
import { rng, noise2, poissonDisk, PolyMask, SpatialHash } from './random.js';
import { buildAtlas } from './atlas.js';
import { makeVegMaterial, makeRockMaterial, windUniforms } from './materials.js';
import { makeRockTextures, rockGeometry } from './rocks.js';
import { palm, PALMS, tree, TREES, banana, pandanus, lily, shrub, SHRUBS, grassTuft, fern, litter } from './plants.js';
import { LODBatch, LODManager } from './lod.js';

// ---------------------------------------------------------------------------
// Procedural nature system: asset library (pooled LOD geometry) + placement
// driven by the island's real layout data (beds, roads, crossings, entrances,
// shoreline, beach) with seeded randomness and a validation pass.
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
function mat(x, y, z, ry, sx, sy = sx, sz = sx, rx = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ'));
  return _m.compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx, sy, sz)).clone();
}
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
  return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
}
/** Distance from a point to a set of polygons (0 inside). */
function polysDist(x, z, polys) {
  if (pointInPolys(x, z, polys)) return 0;
  let d = Infinity;
  for (const r of polys) for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(x, z, r[i], r[(i + 1) % r.length]));
  return d;
}

// ---------------------------------------------------------------------------
function buildLibrary(trees, ground, rocks, rocksLow) {
  const L = {};
  const meta = (id, g) => ({ id, h: g.userData.height, canopy: g.userData.canopy, bounds: g.userData.bounds, leanAz: g.userData.leanAz });
  const lib = (batch, gen, px, n, seed0) => Array.from({ length: n }, (_, i) => {
    const levels = [gen(seed0 + i, 0)];
    return meta(batch.addAsset(levels, px), levels[0]);
  });
  // Locked high-detail (LOD0) meshes across the island with rich architectural variety per species
  const palmPx = [190, 42];
  L.coconutTall = lib(trees, (s, l) => palm(s, l, PALMS.coconutTall), palmPx, 5, 1100);
  L.coconutLean = lib(trees, (s, l) => palm(s, l, PALMS.coconutLean), palmPx, 5, 1200);
  L.coconutMid = lib(trees, (s, l) => palm(s, l, PALMS.coconutMid), palmPx, 4, 1300);
  L.coconutYoung = lib(trees, (s, l) => palm(s, l, PALMS.coconutYoung), [160, 36], 3, 1400);
  L.areca = lib(trees, (s, l) => palm(s, l, PALMS.areca), [160, 36], 4, 1500);
  for (const k of Object.keys(TREES)) L[k] = lib(trees, (s, l) => tree(s, l, TREES[k]), [220, 26], 6, 2000 + k.length * 97);
  L.banana = lib(trees, banana, [150, 18], 3, 3100);
  L.pandanus = lib(trees, pandanus, [150, 18], 3, 3200);
  for (const k of Object.keys(SHRUBS)) L[k] = lib(ground, (s, l) => shrub(s, l, SHRUBS[k]), [130, 8], 3, 4000 + k.length * 53);
  L.lily = lib(ground, lily, [90, 8], 3, 4500);
  L.fern = lib(ground, fern, [80, 16], 3, 4600);
  L.grass = lib(ground, (s, l) => grassTuft(s, l, 'lawn'), [70, 30], 4, 4700);
  L.beachGrass = lib(ground, (s, l) => grassTuft(s, l, 'beach'), [70, 30], 2, 4800);
  const rockLib = (n, seed0, kinds, details, px) => Array.from({ length: n }, (_, i) => {
    const kind = kinds[i % kinds.length];
    const levels = [rockGeometry(seed0 + i, details[0], kind)];
    // same pooled geometry registered in the shadow-casting and the non-casting rock batch
    return { ...meta(rocks.addAsset(levels, px), levels[0]), kind, lowId: rocksLow.addAsset(levels, px) };
  });
  L.rockL = rockLib(9, 7000, ['block', 'boulder', 'block', 'slab'], [7, 3, 1], [120, 14]);
  L.rockM = rockLib(7, 7100, ['block', 'boulder', 'block', 'slab'], [5, 2, 1], [90, 14]);
  L.rockS = rockLib(6, 7200, ['boulder', 'block'], [3, 1, 0], [60, 10]);
  L.shelf = rockLib(4, 7400, ['slab'], [6, 2, 1], [110, 14]);
  L.pebble = rockLib(6, 7300, ['boulder', 'boulder', 'block'], [1, 1, 0], [30, 6]);
  return L;
}
// ---------------------------------------------------------------------------
export function buildNature(ctx, { maxAniso = 4, mobile = false } = {}) {
  const t0 = performance.now();
  const D = ctx.data, scene = ctx.scene;
  const T = { start: t0 };
  const atlas = buildAtlas(maxAniso);
  T.atlas = performance.now();
  const vegMat = makeVegMaterial(atlas);
  const rockMat = makeRockMaterial(makeRockTextures(maxAniso));
  const treesB = new LODBatch(vegMat, { castShadow: true, name: 'nature-trees' });
  const groundB = new LODBatch(vegMat, { castShadow: false, name: 'nature-ground' });
  const rocksB = new LODBatch(rockMat, { castShadow: true, name: 'nature-rocks' });
  const rocksLowB = new LODBatch(rockMat, { castShadow: false, name: 'nature-rocks-waterline' });
  const L = buildLibrary(treesB, groundB, rocksB, rocksLowB);
  T.library = performance.now();
  const r = rng(9001);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const tint = (k = 0.06, warm = 0) => new THREE.Color(1 - k + r() * 2 * k + warm, 1 - k + r() * 2 * k, 1 - k + r() * 2 * k - warm);

  // ---- zones from the real layout -----------------------------------------
  const f = metroFrame();
  const trackDist = (x, z) => Math.abs((x - f.sx) * -f.dz + (z - f.sz) * f.dx);
  const outSign = ringArea(D.outline) > 0 ? 1 : -1;
  const coastDist = (x, z) => { const s = D.outlinePL.project(x, z); const p = D.outlinePL.at(s); return Math.hypot(p.x - x, p.z - z); };
  const bedsCore = new PolyMask(offsetPolys(D.green, -1.45));
  const bedsIn = new PolyMask(offsetPolys(D.green, -0.96));
  const bedsAll = new PolyMask(offsetPolys(D.green, -0.56));
  const buildings = [
    rectPoly(APARTMENT.x, APARTMENT.z, APARTMENT.w + 3, APARTMENT.d + 3),
    rectPoly(GRAFFITI.x, GRAFFITI.z, GRAFFITI.w + 2.4, GRAFFITI.d + 2.4),
    rectPoly(CAFE.x, CAFE.z, CAFE.w, CAFE.d), rectPoly(SHOP.x, SHOP.z, SHOP.w, SHOP.d),
    rectPoly(PAVILION.x, PAVILION.z, PAVILION.size, PAVILION.size), ...stationFootprint(),
  ];
  const junctionPts = JUNCTIONS.map((j) => { const p = D.roads[j.minor].pts; return j.end === 'start' ? p[0] : p[p.length - 1]; });
  const sight = [
    ...D.crossings.map((c) => ({ x: c.x, z: c.z, r: c.width / 2 + 4.5 })),
    ...junctionPts.map(([x, z]) => ({ x, z, r: 10 })),
  ];
  const entrances = [
    { x: APARTMENT.x, z: APARTMENT.z + APARTMENT.d / 2 + 1.5, r: 4 },
    { x: GRAFFITI.x + GRAFFITI.w / 2 + 1.5, z: GRAFFITI.z, r: 4 },
    { x: CAFE.x - CAFE.w / 2 - 1.5, z: CAFE.z - 2.5, r: 4 },
    { x: SHOP.x - 2.2, z: SHOP.z + 2.6, r: 3 },
    { x: D.metro.stairBottom[0], z: D.metro.stairBottom[1], r: 5 },
    ...BUS_SHELTERS.map((b) => ({ x: b.x + Math.sin(b.rot) * 1.5, z: b.z + Math.cos(b.rot) * 1.5, r: 3.2 })),
    { x: D.beachStair.x, z: D.beachStair.z, r: 4 },
    { x: D.pier.root[0], z: D.pier.root[1], r: 5 },
  ];
  const lamps = D.lamps || [];
  const inZone = (zones, x, z, pad = 0) => zones.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + pad);
  const placed = [];   // {x,z,h,r,kind,cls}
  const grid = new SpatialHash(2.5);
  const place = (q) => { placed.push(q); grid.add(q); };
  const colliders = ctx.colliders;

  // `lean` (optional): world azimuth the trunk should lean towards (palms lean seaward)
  const addTree = (lib, x, z, y, { s = 0.88 + r() * 0.24, kind, col = 0.35, color, lean } = {}) => {
    const a = pick(lib);
    // a rotation ry about +Y turns a direction at azimuth α into α - ry
    const ry = lean !== undefined && a.leanAz !== undefined ? a.leanAz - lean : r() * Math.PI * 2;
    treesB.add(a.id, mat(x, y, z, ry, s), color || tint(0.05));
    place({ x, z, y, h: a.h * s, r: (a.canopy || 3) * s, kind, cls: 'tree' });
    colliders.push({ type: 'circle', x, z, r: col });
    return a;
  };
  const addGround = (lib, x, z, y, s, kind, cls = 'shrub', minPx = 0) => {
    const a = pick(lib);
    groundB.add(a.id, mat(x, y, z, r() * Math.PI * 2, s, s * (0.85 + r() * 0.3), s), tint(0.06), minPx);
    place({ x, z, y, h: a.h * s, r: 0.5 * s, kind, cls });
    return a;
  };

  // ---- 1. promenade coconut palms in their planters ------------------------
  for (const [x, z] of D.palmSpots) {
    if (trackDist(x, z) < 6.5) continue;
    const s = D.outlinePL.at(D.outlinePL.project(x, z));
    const seaAz = Math.atan2(-s.tx * outSign, s.tz * outSign);   // outward normal angle
    const roll = r();
    const lib = roll < 0.38 ? L.coconutTall : roll < 0.68 ? L.coconutLean : roll < 0.92 ? L.coconutMid : L.coconutYoung;
    addTree(lib, x, z, WALK + 0.32, { lean: seaAz + (r() - 0.5) * 1.1, kind: 'coconut', col: 0.35 });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + r() * 0.8, d = 0.22 + r() * 0.16;
      addGround(k === 0 ? L.lily : L.fern, x + Math.cos(a) * d, z + Math.sin(a) * d, WALK + 0.34, 0.34 + r() * 0.12, 'underplant', 'ground', 0);
    }
  }

  // ---- 2. trees in planting beds --------------------------------------------
  const CANOPY = { mango: 3.6, rain: 5, almond: 3.8, banana: 1.8, areca: 2.2, coconut: 4.2 };
  const TRUNK = { mango: 0.45, rain: 0.5, almond: 0.35, banana: 0.35, areca: 0.25, coconut: 0.35 };
  const SHADE = ['mango', 'rain', 'almond'];
  const bb = [-62, -54, 62, 46];
  const treePts = poissonDisk(r, bb, 4.0, (x, z) => 4.0 + 3.0 * noise2(x * 0.08, z * 0.08, 11),
    (x, z) => bedsCore.has(x, z) && !inZone(sight, x, z) && !inZone(entrances, x, z, 1));
  for (const { x, z } of treePts) {
    const td = trackDist(x, z), cd = coastDist(x, z), bd = polysDist(x, z, buildings);
    if (td < 4.5) continue;
    if (lamps.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < 2.4)) continue;
    const n1 = noise2(x * 0.045, z * 0.045, 21);
    let kind;
    if (td < 8.5) kind = 'banana';                                    // low growth under the viaduct
    else if (bd < 7) kind = r() < 0.55 ? 'areca' : 'banana';          // slim forms next to facades
    else if (cd < 10) kind = r() < 0.72 ? 'coconut' : 'areca';
    else kind = n1 < 0.42 ? 'mango' : n1 < 0.58 ? 'rain' : n1 < 0.76 ? 'almond' : 'coconut';
    if (SHADE.includes(kind) && bd < CANOPY[kind] * 0.8) kind = 'areca';
    const cr = CANOPY[kind];
    if (grid.any(x, z, 5.5, (q, d) => q.cls === 'tree' && d < (q.r + cr) * 0.46)) continue;
    const lib = kind === 'coconut' ? (r() < 0.5 ? L.coconutMid : r() < 0.6 ? L.coconutTall : L.coconutLean) : L[kind];
    addTree(lib, x, z, GREEN_TOP - 0.02, { kind, col: TRUNK[kind], s: kind === 'rain' ? 0.85 + r() * 0.2 : undefined });
  }

  // ---- 3. shrubs: bed borders + interior drifts (foliage species only) ---------
  const canopyOf = (x, z) => grid.find(x, z, 5, (q, d) => q.cls === 'tree' && SHADE.includes(q.kind) && d < q.r * 0.85);
  const trunkNear = (x, z, d) => grid.any(x, z, d, (q) => q.cls === 'tree');
  const border = offsetPolys(D.green, -0.96);
  for (const ring of border) {
    let acc = r() * 2;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc < 1.6) continue;
      acc = -r() * 0.9;
      const [x, z] = a;
      if (noise2(x * 0.18, z * 0.18, 31) < 0.35) continue;           // natural gaps in the border
      if (trunkNear(x, z, 1.2) || inZone(entrances, x, z)) continue;
      const low = inZone(sight, x, z);
      const bd = polysDist(x, z, buildings), cd = coastDist(x, z);
      let lib;
      if (low) lib = r() < 0.55 ? L.fern : L.lily;
      else if (bd < 6) lib = pick([L.croton, L.box, L.box, L.lily]);
      else if (cd < 7) lib = pick([L.coastal, L.hedge, L.lily]);
      else lib = pick([L.hedge, L.box, L.box, L.lily, L.fern]);
      const s = low ? 0.58 + r() * 0.18 : 0.76 + r() * 0.28;
      addGround(lib, x, z, GREEN_TOP, s, 'border', low ? 'ground' : 'shrub');
    }
  }
  const shrubPts = poissonDisk(r, bb, 2.1, (x, z) => 2.1 + 1.6 * noise2(x * 0.1, z * 0.1, 41),
    (x, z) => bedsIn.has(x, z) && !inZone(entrances, x, z));
  for (const { x, z } of shrubPts) {
    if (trunkNear(x, z, 1.3)) continue;
    if (grid.any(x, z, 1.3, (q) => q.cls !== 'tree' && q.cls !== 'groundcover')) continue;
    const low = inZone(sight, x, z);
    const shade = canopyOf(x, z);
    const n = noise2(x * 0.07, z * 0.07, 51);
    let lib, s = 0.82 + r() * 0.34, cls = 'shrub';
    if (shade) { lib = r() < 0.75 ? L.fern : L.lily; cls = 'ground'; }
    else if (low) { lib = pick([L.fern, L.lily]); s = 0.58 + r() * 0.15; cls = 'ground'; }
    else if (n < 0.36) lib = L.hedge;
    else if (n < 0.56) lib = L.coastal;
    else if (n < 0.8) lib = L.box;
    else lib = L.croton;
    addGround(lib, x, z, GREEN_TOP, s, 'drift', cls);
    if (cls === 'shrub' && (lib === L.hedge || lib === L.coastal) && s > 0.9) colliders.push({ type: 'circle', x, z, r: 0.45 * s });
  }

  T.shrubs = performance.now();
  // ---- 4. ground layer: denser grass & low cover around trees/borders/corners, trimmed beside roads/paths ----
  const treeItems = placed.filter((q) => q.cls === 'tree' && bedsAll.has(q.x, q.z));
  for (const t of treeItems) {
    const nClumps = 4 + Math.floor(r() * 4);
    for (let k = 0; k < nClumps; k++) {
      const a = (k / nClumps) * Math.PI * 2 + (r() - 0.5) * 0.7;
      const d = 0.38 + r() * 0.78;
      const gx = t.x + Math.cos(a) * d, gz = t.z + Math.sin(a) * d;
      if (!bedsAll.has(gx, gz)) continue;
      const isFern = k === 0 && r() < 0.35;
      const lib = isFern ? L.fern : L.grass;
      const s = isFern ? 0.48 + r() * 0.2 : 0.88 + r() * 0.38;
      groundB.add(pick(lib).id, mat(gx, GREEN_TOP, gz, r() * Math.PI * 2, s, s * (0.85 + r() * 0.3), s), tint(0.06), 0);
      place({ x: gx, z: gz, y: GREEN_TOP, h: 0.22 * s, r: 0.25, kind: 'gc', cls: 'groundcover' });
    }
  }
  const gcPts = poissonDisk(r, bb, 0.72, () => 0.72 + r() * 0.48, (x, z) => bedsAll.has(x, z), 9500);
  for (const { x, z } of gcPts) {
    if (grid.any(x, z, 0.45, (q, d) => q.cls !== 'groundcover' && d < (q.cls === 'tree' ? 0.32 : 0.45))) continue;
    const inCore = bedsCore.has(x, z);
    const nearShrubOrTree = grid.any(x, z, 1.85, (q) => q.cls === 'tree' || q.cls === 'shrub');
    const patchN = noise2(x * 0.13, z * 0.13, 73);
    const cornerLush = coastDist(x, z) < 11 || polysDist(x, z, buildings) < 5.5;
    // keep lawn relatively trimmed beside roads and footpaths; denser in drifts, borders, and corners
    if (!inCore && !nearShrubOrTree && !cornerLush && patchN < 0.58) continue;
    if (inCore && !nearShrubOrTree && patchN < 0.28) continue;
    const shade = canopyOf(x, z);
    const lib = shade
      ? (r() < 0.32 ? L.fern : L.grass)
      : (nearShrubOrTree && r() < 0.12 ? L.fern : L.grass);
    let s;
    if (lib === L.grass) {
      s = (nearShrubOrTree || cornerLush)
        ? 0.82 + r() * 0.42
        : inCore
          ? 0.62 + 0.38 * patchN + r() * 0.20
          : 0.42 + r() * 0.22; // trimmed lawn near road/path edges
    } else {
      s = 0.48 + r() * 0.22;
    }
    groundB.add(pick(lib).id, mat(x, GREEN_TOP, z, r() * Math.PI * 2, s, s * (0.85 + r() * 0.3), s), tint(0.06), 0);
    place({ x, z, y: GREEN_TOP, h: 0.22 * s, r: 0.25, kind: 'gc', cls: 'groundcover' });
  }

  // ---- 5. coastal planting on the beach ----------------------------------------
  const beachBand = intersection(D.beachPoly, offsetPolys(D.plate, 5.5));
  const st = D.beachStair;
  const stairCorridor = rectPoly(st.x + st.nx * 6, st.z + st.nz * 6, 5, 14, Math.atan2(st.nx, st.nz));
  const umbrellas = [[-21, 46.5], [-13, 48], [-4, 46.8]].map(([x, z]) => circlePoly(x, z + 0.6, 2.8, 12));
  // the beach polygon tucks under the seawall: keep planting on open sand only
  const coastZone = new PolyMask(difference(beachBand, [...offsetPolys(D.plate, 0.6), stairCorridor, ...umbrellas]));
  for (const [x, z] of [[-24, 44.5], [2, 44]]) addTree(L.coconutLean, x, z, beachHeight(x, z) - 0.05, { lean: Math.PI / 2 + (x < 0 ? -0.35 : 0.35), kind: 'coconut', col: 0.35 });
  for (const [x, z] of [[-29.5, 45], [6.8, 44.2]]) {
    if (coastZone.has(x, z) && beachHeight(x, z) > 0.4) addTree(L.pandanus, x, z, beachHeight(x, z) - 0.05, { kind: 'pandanus', col: 0.6 });
  }
  // dune grass only on the dry backshore, thickest against the wall and in the horns
  const sandPts = poissonDisk(r, [-38, 36, 16, 60], 1.0, () => 1.0 + r() * 0.8,
    (x, z) => coastZone.has(x, z) && beachHeight(x, z) > 0.42);
  for (const { x, z } of sandPts) {
    if (grid.any(x, z, 1.2, (q, d) => d < (q.cls === 'tree' ? 1.2 : 0.8))) continue;
    const wd = D.coast.wallDist(x, z);
    if (wd > 2.2 && noise2(x * 0.35, z * 0.35, 91) < 0.5) continue;    // open sand away from the wall
    const wallNear = wd < 1.5;
    const lib = wallNear && r() < 0.35 ? L.lily : r() < 0.1 ? L.coastal : L.beachGrass;
    const grassy = lib === L.beachGrass;
    // bases are sunk 3 cm so blades and stems emerge from the sand
    addGround(lib, x, z, beachHeight(x, z) - 0.03, grassy ? 0.9 + r() * 0.5 : 0.7 + r() * 0.3, 'coastal', grassy ? 'ground' : 'shrub', grassy ? 6 : 0);
  }

  // ---- 6. balcony / roof / terrace planters from the buildings -----------------
  for (const [x, y, z, s] of (D.smallPlants || [])) {
    const lib = pick([L.croton, L.box, L.box, L.fern, L.lily]);
    groundB.add(pick(lib).id, mat(x, y, z, r() * Math.PI * 2, s * 0.78), tint(0.06), 0);
  }

  // ---- contact shadows: soft ambient-occlusion pads under every tree / shrub ----
  buildContactAO(scene, placed);
  T.planting = performance.now();
  // ---- 7. shoreline rocks --------------------------------------------------------
  const rockStats = placeRocks(ctx, rocksB, rocksLowB, L, r, outSign, placed);

  // ---- finalize -------------------------------------------------------------------
  T.rocks = performance.now();
  treesB.finalize(scene); groundB.finalize(scene); rocksB.finalize(scene); rocksLowB.finalize(scene);
  T.finalize = performance.now();
  const lod = new LODManager([treesB, groundB, rocksB, rocksLowB], mobile ? 0.72 : 1);

  // ---- validation -----------------------------------------------------------------
  const issues = [];
  for (const q of placed) {
    if (q.cls === 'groundcover') continue;
    if (pointInPolys(q.x, q.z, D.roadsClosed)) issues.push(['on road', q]);
    else if (pointInPolys(q.x, q.z, PLAZAS)) issues.push(['on plaza', q]);
    if (q.h > 0.95 && q.cls !== 'tree' && inZone(sight, q.x, q.z)) issues.push(['blocks sightline', q]);
    // clear-stemmed palms (canopy > 5 m) do not block driver sightlines; low-crowned trees must stay out
    if (q.cls === 'tree' && !['coconut', 'areca'].includes(q.kind) && inZone(sight, q.x, q.z)) issues.push(['tree in sightline', q]);
    if (q.cls === 'tree' && ['coconut', 'areca'].includes(q.kind) && D.crossings.some((c) => Math.hypot(c.x - q.x, c.z - q.z) < c.width / 2 + 2.5)) issues.push(['palm at crossing', q]);
    if (q.h > 0.6 && inZone(entrances, q.x, q.z, -0.5)) issues.push(['blocks entrance', q]);
    for (const p of PATHS) {
      for (let i = 0; i < p.pts.length - 1; i++) {
        if (segDist(q.x, q.z, p.pts[i], p.pts[i + 1]) < p.w / 2) { issues.push(['on path', q]); break; }
      }
    }
  }
  const stats = {
    ms: Math.round(performance.now() - t0),
    phases: Object.fromEntries(Object.entries(T).map(([k, v], i, a) => [k, i ? Math.round(v - a[i - 1][1]) : 0])),
    trees: treesB.stats, ground: groundB.stats, rocks: rocksB.stats, rocksWaterline: rocksLowB.stats, rockChecks: rockStats,
    beachTrees: placed.filter((q) => q.cls === 'tree' && pointInPolys(q.x, q.z, D.beachPoly)).map((q) => ({ x: q.x, z: q.z })),
    counts: placed.reduce((m, q) => ((m[q.kind] = (m[q.kind] || 0) + 1), m), {}),
    issues: issues.map(([k, q]) => `${k} ${q.kind} @${q.x.toFixed(1)},${q.z.toFixed(1)}`),
  };
  console.info('[nature]', stats);

  return {
    stats, batches: { trees: treesB, ground: groundB, rocks: rocksB, rocksWaterline: rocksLowB },
    update(camera, time, viewportH) {
      windUniforms.uTime.value = time;
      lod.update(camera, viewportH);
    },
    census() { return { trees: treesB.census(), ground: groundB.census(), rocks: rocksB.census(), rocksWaterline: rocksLowB.census() }; },
  };
}

// ---------------------------------------------------------------------------
// Coastal rock formation, driven by the coast field:
//  - graded granite revetment around the island: heavier and more continuous on
//    coasts facing the WSW swell, lighter and gappier in the lee, thinning into
//    sand-bedded boulders at the beach horns and absent along the open sand;
//  - two rocky points framing the pocket beach: core boulders bedded on the
//    reef shelf, a second rank, flat rock shelves at the waterline, partly
//    submerged outliers and rubble spilling onto the sand;
//  - scattered stones off exposed coasts and in the shallows, pebbles on the beach.
// Every base is sunk below the lowest ground under its footprint (no floating
// stones); stairs, pier piles and deck, beach furniture and trunks are kept clear.
// ---------------------------------------------------------------------------
function placeRocks(ctx, B, BLow, L, r, outSign, placed) {
  const D = ctx.data, pl = D.outlinePL, C = D.coast;
  const [sfx, sfz] = SWELL_FROM;
  const pierRects = D.pier.pieces.map((p) => rectPoly(p.cx, p.cz, p.w + 0.8, p.d + 0.8, p.rot));
  const deckLimit = D.pier.deckTop - 0.45;
  const piles = D.pier.piles || [];
  const st = D.beachStair;
  const stairGuard = [rectPoly(st.x + st.nx * 2.4, st.z + st.nz * 2.4, 5.4, 6.8, Math.atan2(st.nx, st.nz))];
  const keepOut = [
    ...(D.beachKeepOut || []),
    ...placed.filter((q) => q.cls === 'tree' && pointInPolys(q.x, q.z, D.beachPoly)).map((q) => [q.x, q.z, 1.0]),
  ];
  const rocks = [];
  const pick = (a) => a[Math.floor(r() * a.length)];
  const coping = WALK - 0.32;
  const groundMin = (x, z, R) => {
    let g = C.height(x, z);
    for (let k = 0; k < 6; k++) { const a = k * 1.0472; g = Math.min(g, C.height(x + Math.cos(a) * R * 0.75, z + Math.sin(a) * R * 0.75)); }
    return g;
  };
  const blocked = (x, z, R) => pointInPolys(x, z, stairGuard)
    || piles.some(([px, pz]) => Math.hypot(px - x, pz - z) < R * 0.75 + 0.3)
    || keepOut.some(([kx, kz, kr]) => Math.hypot(kx - x, kz - z) < kr + R * 0.6);
  const crowded = (x, z, R, k, only) => rocks.some((o) => (!only || o.role === only) && Math.hypot(o.x - x, o.z - z) < (o.R + R) * k);

  // opts: top = target top height, or embed = fraction of the stone's height sunk into the ground
  const put = (lib, x, z, R, role, { top, embed = 0.3, flat = 1, maxTop = coping, tilt = 1, cast } = {}) => {
    if (blocked(x, z, R)) return null;
    const a = pick(lib);
    const sx = R * (0.88 + r() * 0.3), sy = R * (0.7 + r() * 0.3) * flat, sz = R * (0.88 + r() * 0.3);
    const hgt = (a.bounds.maxY - a.bounds.minY) * sy;
    const gC = C.height(x, z), gMin = groundMin(x, z, Math.max(sx, sz));
    let y = top !== undefined ? top - a.bounds.maxY * sy : gC - a.bounds.minY * sy - embed * hgt;
    if (y + a.bounds.maxY * sy < gC + 0.12 * hgt) y = gC + 0.12 * hgt - a.bounds.maxY * sy;   // never buried from sight
    const sink = Math.max(0.06, 0.1 * hgt);
    if (y + a.bounds.minY * sy > gMin - sink) y = gMin - sink - a.bounds.minY * sy;          // always bedded
    if (pointInPolys(x, z, pierRects)) maxTop = Math.min(maxTop, deckLimit);
    let topY = y + a.bounds.maxY * sy;
    if (topY > maxTop) { y -= topY - maxTop; topY = maxTop; }
    const bottom = y + a.bounds.minY * sy;
    const ry = r() * Math.PI * 2, rx = (r() - 0.5) * 0.4 * tilt, rz = (r() - 0.5) * 0.4 * tilt;
    const k = 0.86 + r() * 0.24;
    const color = new THREE.Color(k, k * (0.98 + r() * 0.03), k * (0.96 + r() * 0.05));
    const Rxz = a.bounds.rXZ * Math.max(sx, sz);
    const rec = { x, z, R: Rxz, Rg: Rxz * 0.78, bottom, top: topY, role, ground: gC };
    // stones near the waterline would only throw shadows onto water: non-casting batch
    const low = cast === false || (cast === undefined && topY < 0.9);
    const m4 = mat(x, y, z, ry, sx, sy, sz, rx, rz);
    rec.emit = () => (low ? BLow.add(a.lowId, m4, color, 0) : B.add(a.id, m4, color, 0));
    rocks.push(rec);
    return rec;
  };
  const along = (s, d) => {
    const p = pl.at(s);
    const nx = p.tz * outSign, nz = -p.tx * outSign;
    return [p.x + nx * d, p.z + nz * d, p, nx, nz];
  };

  // ---- 1. rocky points framing the beach
  for (const [hi, hd] of D.headlands.entries()) {
    const away = hi === 0 ? -1 : 1;                              // +x side is away from the sand for the east point
    let tx = -hd.nz, tz = hd.nx;
    if (Math.sign(tx) !== away) { tx = -tx; tz = -tz; }
    const at = (u, v) => [hd.x + hd.nx * u + tx * v, hd.z + hd.nz * u + tz * v];
    const scatter = (n, lib, uR, vR, RR, opts, k, role = 'head') => {
      let got = 0;
      for (let i = 0; i < n * 6 && got < n; i++) {
        const u = uR[0] + r() * (uR[1] - uR[0]);
        const taper = 1 - 0.45 * (u / (hd.len + 3));
        const v = (vR[0] + r() * (vR[1] - vR[0])) * taper;
        const R = RR[0] + r() * (RR[1] - RR[0]);
        const [x, z] = at(u, v);
        if (crowded(x, z, R, k)) continue;
        if (put(lib, x, z, R, role, opts(u))) got++;
      }
    };
    scatter(7, L.rockL, [0.3, 4.6], [-2.2, 3.4], [1.25, 1.9], (u) => ({ top: 1.6 - u * 0.2 + r() * 0.3, cast: true }), 0.46);
    scatter(8, L.rockL, [3.4, 7.6], [-2.2, 2.8], [0.85, 1.35], (u) => ({ top: 0.9 - u * 0.09 + r() * 0.3 }), 0.5);
    scatter(3, L.shelf, [4.2, 8.4], [-2.8, 2.6], [1.5, 2.3], () => ({ top: 0.06 + r() * 0.24, flat: 0.5, tilt: 0.3 }), 0.4);
    scatter(6, L.rockL, [7.6, hd.len + 3.5], [-3.2, 3.2], [0.8, 1.4], () => ({ top: -0.48 + r() * 0.62 }), 0.62);
    scatter(16, L.rockS, [0, hd.len + 1], [-4.6, 1.6], [0.25, 0.55], () => ({ embed: 0.42 }), 0.72, 'rubble');
  }

  // ---- 2. graded revetment (rows step down from the coping to below the waterline)
  const rows = [
    { lib: L.rockM, d: [0.15, 0.55], R: [0.65, 1.05], top: [WALK - 0.55, WALK - 0.3], step: 0.95, role: 'wall', crevice: 0.08 },
    { lib: L.rockL, d: [1.5, 2.1], R: [0.85, 1.3], top: [0.75, 1.15], step: 1.0, role: 'mid', crevice: 0.06 },
    { lib: L.rockL, d: [2.9, 3.7], R: [1.1, 1.75], top: [0.15, 0.65], step: 1.05, role: 'toe', crevice: 0 },
    { lib: L.rockL, d: [4.8, 6.6], R: [1.0, 1.7], top: [-0.7, 0.1], step: 1.6, role: 'outer', crevice: 0, sparse: 0.35 },
    { lib: L.rockL, d: [7.0, 9.4], R: [1.1, 1.8], top: [-0.55, 0.28], step: 2.1, role: 'breaker', crevice: 0, sparse: 0.4, exposed: 0.35 },
  ];
  rows.forEach((row, ri) => {
    for (let s = r() * 1.5 + ri * 0.7; s < pl.length;) {
      const [, , p, nx, nz] = along(s, 0);
      const expo = nx * sfx + nz * sfz;                            // +1 faces the swell head-on
      const wb = C.beachWidthAt(p.x, p.z);
      if (wb > 3.2 || (ri >= 2 && wb > 0.4)) { s += 0.8; continue; }   // open sand: no armour
      if (row.exposed !== undefined && expo < row.exposed) { s += 1.2; continue; }
      const sizeK = (0.84 + 0.34 * Math.max(0, expo)) * (expo < -0.3 ? 0.86 : 1) * (wb > 0 ? 0.62 + 0.38 * (1 - wb / 3.2) : 1);
      const R = (row.R[0] + r() * (row.R[1] - row.R[0])) * sizeK;
      if (r() < row.crevice) {
        const [cx, cz] = along(s, row.d[0] + 0.3);
        put(L.rockS, cx, cz, 0.3 + r() * 0.2, 'crevice', { top: row.top[0] - 0.45 });
        s += 0.9 + r() * 0.6;
        continue;
      }
      const sparse = (row.sparse || 0) + (expo < -0.2 ? 0.22 : 0) + (wb > 0 ? 0.35 * (wb / 3.2) : 0) - (expo > 0.55 ? 0.15 : 0);
      if (r() < sparse) { s += R * 1.5; continue; }
      const [x, z] = along(s, row.d[0] + r() * (row.d[1] - row.d[0]));
      if (crowded(x, z, R, 0.55, 'head')) { s += R; continue; }
      const opts = wb > 0.3 ? { embed: 0.32 + r() * 0.12 } : { top: row.top[0] + r() * (row.top[1] - row.top[0]) };
      const rec = put(row.lib, x, z, R, row.role, opts);
      s += rec ? R * row.step * (0.85 + r() * 0.3) : 1.0;
    }
  });
  // small fill stones in the joints between the mid and toe rows
  for (const t of rocks.filter((q) => q.role === 'toe')) {
    const n = Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = t.R * (0.7 + r() * 0.4);
      put(L.rockS, t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.25 + r() * 0.3, 'fill', { top: -0.05 + r() * 0.45 });
    }
  }

  // ---- 3. partly submerged outliers off the exposed coasts
  // (small clusters on the shelf edge rather than isolated dots)
  for (let i = 0; i < 40; i++) {
    const s = r() * pl.length;
    const [, , p, nx, nz] = along(s, 0);
    if (nx * sfx + nz * sfz < 0.15 || C.beachWidthAt(p.x, p.z) > 0) continue;
    const [cx, cz] = along(s, 8.5 + r() * 6);
    const n = 2 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, dd = k === 0 ? 0 : 0.9 + r() * 1.3;
      const x = cx + Math.cos(a) * dd, z = cz + Math.sin(a) * dd;
      const R = (k === 0 ? 0.9 : 0.45) + r() * 0.6;
      if (crowded(x, z, R, 0.7) || pointInPolys(x, z, pierRects)) continue;
      put(k === 0 ? L.rockL : L.rockM, x, z, R, 'outlier', { top: (k === 0 ? -0.35 : -0.7) + r() * 0.55 });
    }
  }

  // ---- 4. stones on the sandy shallows near the rocky ends (seen through clear water)
  const bc = (BEACH.x0 + BEACH.x1) / 2, bhs = (BEACH.x1 - BEACH.x0) / 2;
  for (let i = 0, n = 0; i < 600 && n < 10; i++) {
    const x = bc + (r() < 0.5 ? -1 : 1) * bhs * (0.62 + r() * 0.5), z = 44 + r() * 22;
    const h = C.height(x, z);
    if (h > -0.3 || h < -1.6 || C.beachInf(x, z) < 0.25) continue;
    const R = 0.3 + r() * 0.5;
    if (crowded(x, z, R, 1.2)) continue;
    if (put(r() < 0.6 ? L.rockS : L.rockM, x, z, R, 'shallows', { embed: 0.35, cast: false })) n++;
  }

  // ---- 5. pebbles: gathered round the rocky points and along the wrack line, sparse elsewhere
  const heads = rocks.filter((q) => q.role === 'head' || q.role === 'rubble');
  let pebbles = 0;
  for (let i = 0; i < 4000 && pebbles < 190; i++) {
    const x = BEACH.x0 - 4 + r() * (BEACH.x1 - BEACH.x0 + 8), z = 36 + r() * 24;
    const h = C.height(x, z);
    if (h < 0.03 || !pointInPolys(x, z, D.beachPoly)) continue;
    const nearRock = heads.some((o) => Math.hypot(o.x - x, o.z - z) < o.R + 3.5);
    const wrack = Math.abs(h - 0.36) < 0.05;
    if (r() > (nearRock ? 0.6 : wrack ? 0.14 : 0.025)) continue;
    const R = 0.045 + r() * r() * 0.15;
    if (crowded(x, z, R, 1.0)) continue;
    if (put(L.pebble, x, z, R, 'pebble', { embed: 0.45, cast: false, tilt: 2 })) pebbles++;
  }

  // ---- validation + emission
  let floating = 0, buried = 0;
  const beachNear = offsetPolys(D.beachPoly, 2.5);
  const kept = [];
  for (const q of rocks) {
    if (q.top < q.ground + 0.03) { buried++; continue; }      // fully sunk on a steep bed: invisible, skip
    if (q.bottom > C.height(q.x, q.z) - 0.02) floating++;
    kept.push(q);
    q.emit();
    // the larger stones on or beside the sand block the walker
    if (q.R > 0.6 && q.top > q.ground + 0.45 && q.ground > -0.4 && pointInPolys(q.x, q.z, beachNear)) {
      ctx.colliders.push({ type: 'circle', x: q.x, z: q.z, r: q.R * 0.72 });
    }
  }
  D.rocks = kept.map(({ x, z, R, Rg, top, bottom, role }) => ({ x, z, R, Rg, top, bottom, role }));
  const roles = kept.reduce((m, q) => ((m[q.role] = (m[q.role] || 0) + 1), m), {});
  return { count: kept.length, floating, skippedBuried: buried, roles };
}

// ---------------------------------------------------------------------------
// Soft ambient-occlusion pads (one instanced, alpha-blended draw) that ground
// trees and shrubs on the soil where the sun shadow does not reach.
// ---------------------------------------------------------------------------
function buildContactAO(scene, placed) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.45, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const items = placed.filter((q) => q.cls === 'tree' || q.cls === 'shrub');
  const mat2 = new THREE.MeshBasicMaterial({ color: 0x0b1206, map: tex, transparent: true, opacity: 0.42, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const geo = new THREE.PlaneGeometry(2, 2); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mat2, items.length);
  const m = new THREE.Matrix4();
  items.forEach((q, i) => {
    const big = q.cls === 'tree' && ['mango', 'rain', 'almond'].includes(q.kind);
    const rad = q.cls === 'tree' ? (big ? q.r * 0.75 : q.kind === 'coconut' ? 1.1 : 1.2) : Math.max(0.45, q.r * 2.0);
    m.compose(new THREE.Vector3(q.x, q.y + 0.025, q.z), new THREE.Quaternion(), new THREE.Vector3(rad, 1, rad));
    mesh.setMatrixAt(i, m);
  });
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  scene.add(mesh);
}

import * as THREE from 'three';
import {
  sampleCurve, Polyline, bufferLines, offsetPolys, union, difference, intersection, closePolys, openPolys,
  slabGeometry, flatGeometry, curbGeometry, boxGeo, rectPoly, circlePoly, ringArea, pointInPolys, rng,
} from '../geom.js';
import {
  G, WALK, GREEN_TOP, OUTLINE, BEACH, ROADS, JUNCTIONS, CROSSINGS, PLAZAS, PATHS,
  APARTMENT, GRAFFITI, CAFE, PAVILION, SHOP, BUS_SHELTERS, PIER,
} from '../layout.js';
import { buildCoastField, buildCoastMesh, axisSamples, FEXT as FIELD_EXT } from './coastField.js';
import { makeCoastTextures } from './coastTextures.js';
import { coastUniforms, makeCoastGroundMaterial } from './coastShading.js';

let coastField = null;
/** Ground height of the coastal terrain (beach sand / seabed) at (x, z). */
export const beachHeight = (x, z) => coastField.height(x, z);

function addMesh(ctx, geo, mat, { walk = false, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  m.castShadow = shadow;
  m.matrixAutoUpdate = false;
  ctx.scene.add(m);
  if (walk) ctx.walk.push(geo);
  return m;
}

/** Footprints that planting must avoid (buildings + margin). Filled in by buildings.js data. */
export function buildingFootprints(stationPoly) {
  return [
    rectPoly(APARTMENT.x, APARTMENT.z, APARTMENT.w + 4, APARTMENT.d + 4),
    rectPoly(GRAFFITI.x, GRAFFITI.z, GRAFFITI.w + 4, GRAFFITI.d + 4),
    rectPoly(CAFE.x, CAFE.z, CAFE.w + 4, CAFE.d + 4),
    rectPoly(PAVILION.x, PAVILION.z, PAVILION.size + 3, PAVILION.size + 3),
    rectPoly(SHOP.x, SHOP.z, SHOP.w + 3, SHOP.d + 3),
    ...BUS_SHELTERS.map((b) => rectPoly(b.x, b.z, 6.5, 3.5, b.rot)),
    ...stationPoly,
  ];
}

export function buildTerrain(ctx) {
  const { M } = ctx;
  const D = ctx.data;

  // --- outline & plate ------------------------------------------------------
  const outline = sampleCurve(OUTLINE, true, 0.6);
  const outlinePL = new Polyline(outline, true);
  const plate = [outline];
  D.outline = outline; D.outlinePL = outlinePL; D.plate = plate;

  // --- roads ----------------------------------------------------------------
  const roads = {};
  for (const [name, r] of Object.entries(ROADS)) {
    const pts = sampleCurve(r.pts, r.closed, 0.25);
    const pl = new Polyline(pts, r.closed);
    const poly = r.closed
      ? bufferLines([pts], r.width / 2, { closedLines: true, round: true })
      : bufferLines([pts], r.width / 2, { round: false });
    roads[name] = { ...r, pts, pl, poly };
  }
  D.roads = roads;
  let roadUnion = [];
  for (const r of Object.values(roads)) roadUnion = union(roadUnion, r.poly);
  const roadsClosed = intersection(closePolys(roadUnion, 4), plate);  // smooth curb returns at junctions
  D.roadsClosed = roadsClosed;

  // asphalt (top only, realistic 4.2m tile scale for fine aggregate)
  addMesh(ctx, slabGeometry(roadsClosed, G - 0.3, G, { uvTop: 4.2, sides: false }), M.asphalt, { walk: true, shadow: false });

  // pedestrian paving (3.2m tile = 20cm x 10cm terracotta running-bond pavers, inset behind the 3D road curb)
  const roadCurbOuter = offsetPolys(roadsClosed, 0.18, true);
  const paving = difference(plate, roadCurbOuter);
  const pavingGeo = slabGeometry(paving, G - 0.3, WALK, { uvTop: 3.2, uvSide: 1.2, sides: false });
  addMesh(ctx, pavingGeo, M.paving, { walk: true, shadow: false });

  // solid 3D chamfered stone roadside curb (rises cleanly from road G to WALK + 0.018 and steps into the brick sidewalk)
  const roadCurbProfile = [
    [0.0, G - 0.02, 0.0],
    [0.014, WALK - 0.015, 0.28],
    [0.042, WALK + 0.018, 0.40],
    [0.20, WALK + 0.018, 0.88],
    [0.21, WALK - 0.02, 1.0],
  ];
  addMesh(ctx, curbGeometry(roadsClosed, roadCurbProfile, { uvStep: 0.65 }), M.curb, { walk: true, shadow: false });

  // continuous stone coping along outer seawall promenade perimeter
  const seawallCopingProfile = [
    [-0.29, WALK - 0.02, 1.0],
    [-0.28, WALK + 0.022, 0.88],
    [-0.02, WALK + 0.022, 0.32],
    [0.0, WALK - 0.01, 0.15],
    [0.0, G - 0.3, 0.0],
  ];
  addMesh(ctx, curbGeometry(plate, seawallCopingProfile, { uvStep: 0.75 }), M.curb, { walk: true, shadow: false });

  // seawall faces
  addMesh(ctx, slabGeometry(plate, -3.2, G - 0.3, { top: false, uvSide: 3 }), M.stone, { shadow: false });

  // --- markings -------------------------------------------------------------
  const lineHalf = 0.07;
  const crossingRects = [];
  const crossingGuardRects = [];
  D.crossings = [];
  for (const c of CROSSINGS) {
    const r = roads[c.road];
    const s = r.pl.project(c.at[0], c.at[1]);
    const p = r.pl.at(s);
    const rot = Math.atan2(-p.tz, p.tx);
    crossingRects.push(rectPoly(p.x, p.z, 3.3, r.width + 0.4, rot));
    crossingGuardRects.push(rectPoly(p.x, p.z, 5.2, r.width + 0.6, rot));
    D.crossings.push({ road: c.road, s, x: p.x, z: p.z, tx: p.tx, tz: p.tz, width: r.width });
  }

  // continuous yellow road-edge markings following curves and junction curb returns without gaps or kinks
  const yellowOuter = offsetPolys(roadsClosed, -0.34, true);
  const yellowInner = offsetPolys(roadsClosed, -0.48, true);
  const yellowLines = difference(difference(yellowOuter, yellowInner), crossingRects);
  const roadMarkingInterior = offsetPolys(roadsClosed, -0.52, true);

  const whiteLines = [];
  const junctionZones = [];
  for (const j of JUNCTIONS) {
    const mi = roads[j.minor], ma = roads[j.major];
    const endPt = j.end === 'start' ? mi.pts[0] : mi.pts[mi.pts.length - 1];
    junctionZones.push(circlePoly(endPt[0], endPt[1], ma.width * 0.78, 24));
  }

  for (const [name, r] of Object.entries(roads)) {
    let clip = union(crossingGuardRects, junctionZones);
    for (const j of JUNCTIONS) {
      if (j.minor === name) {
        const ma = roads[j.major];
        clip = union(clip, bufferLines([ma.pts], ma.width / 2 + 4.1, { closedLines: ma.closed, round: true }));
      }
    }
    // dashed centre line sampled finely along smooth curve
    const dashes = [];
    for (let s = 1.2; s < r.pl.length - 2.2; s += 5.6) {
      dashes.push(r.pl.slice(s, Math.min(s + 2.6, r.pl.length - 1.2), 0.15));
    }
    const rawDashes = difference(bufferLines(dashes, lineHalf, { round: false }), clip);
    for (const dPoly of rawDashes) {
      if (Math.abs(ringArea(dPoly)) > 0.14) whiteLines.push(dPoly);
    }
  }

  // junction stop & give-way lines on minor roads, aligned with road throat and clipped inside yellow edges
  for (const j of JUNCTIONS) {
    const mi = roads[j.minor], ma = roads[j.major];
    const d = ma.width / 2 + 3.75;
    const L = mi.pl.length;
    let sGW = j.end === 'start' ? 0 : L;
    for (let k = 0; k <= L; k += 0.15) {
      const s = j.end === 'start' ? k : L - k;
      const p = mi.pl.at(s);
      const sp = ma.pl.at(ma.pl.project(p.x, p.z));
      if (Math.hypot(sp.x - p.x, sp.z - p.z) >= d) { sGW = s; break; }
    }
    const p = mi.pl.at(sGW);
    // outward normal across minor road width
    const nx = -p.tz, nz = p.tx;
    // approaching left-hand lane gets a solid stop bar; other half gets dashed give-way bars
    const dirSign = j.end === 'start' ? -1 : 1;
    const stopSeg = [[p.x, p.z], [p.x + nx * dirSign * (mi.width / 2 - 0.52), p.z + nz * dirSign * (mi.width / 2 - 0.52)]];
    whiteLines.push(...intersection(bufferLines([stopSeg], 0.16, { round: false }), roadMarkingInterior));
    const gwSegs = [];
    for (let o = 0.35; o < mi.width / 2 - 0.55; o += 0.9) {
      const a0 = -dirSign * o, a1 = -dirSign * Math.min(o + 0.5, mi.width / 2 - 0.52);
      gwSegs.push([[p.x + nx * a0, p.z + nz * a0], [p.x + nx * a1, p.z + nz * a1]]);
    }
    whiteLines.push(...intersection(bufferLines(gwSegs, 0.13, { round: false }), roadMarkingInterior));
  }

  // zebra crossings + approaching lane stop lines
  for (const c of D.crossings) {
    const r = roads[c.road];
    const rot = Math.atan2(-c.tz, c.tx);
    const nx = -c.tz, nz = c.tx;
    const stripes = [];
    for (let o = -c.width / 2 + 0.75; o <= c.width / 2 - 0.75 + 1e-3; o += 0.95) {
      stripes.push(rectPoly(c.x + nx * o, c.z + nz * o, 2.8, 0.46, rot));
    }
    whiteLines.push(...intersection(stripes, roadMarkingInterior));
    // stop lines 2.25m before zebra crossing on each approaching left-hand lane
    for (const side of [-1, 1]) {
      const sStop = c.s + side * 2.25;
      if (!r.closed && (sStop < 3.5 || sStop > r.pl.length - 3.5)) continue;
      const ps = r.pl.at(sStop);
      if (pointInPolys(ps.x, ps.z, junctionZones)) continue;
      const snx = -ps.tz, snz = ps.tx;
      const laneSign = side < 0 ? 1 : -1;
      const stopLine = [[ps.x + snx * laneSign * 0.18, ps.z + snz * laneSign * 0.18],
        [ps.x + snx * laneSign * (r.width / 2 - 0.54), ps.z + snz * laneSign * (r.width / 2 - 0.54)]];
      whiteLines.push(...intersection(bufferLines([stopLine], 0.14, { round: false }), roadMarkingInterior));
    }
  }
  const clean = (polys) => polys.filter((p) => Math.abs(ringArea(p)) > 0.04);
  addMesh(ctx, flatGeometry(clean(whiteLines), G + 0.008), M.lineWhite, { shadow: false });
  addMesh(ctx, flatGeometry(clean(yellowLines), G + 0.008), M.lineYellow, { shadow: false });

  // --- coast: one heightfield for beach, foreshore and seabed --------------------------
  const stairS = outlinePL.project(-10, 43);
  const sp = outlinePL.at(stairS);
  const outSign = ringArea(outline) > 0 ? 1 : -1;
  // outward normal (right of travel when ring is CCW in x/z math sense)
  const onx = sp.tz * outSign, onz = -sp.tx * outSign;
  const nSteps = 8, tread = 0.3, stairW = 3.2;
  const stairFoot = [sp.x + onx * (nSteps * tread + 0.4), sp.z + onz * (nSteps * tread + 0.4)];
  // rocky points framing the pocket beach, curving slightly in to enclose the bay
  const headlands = [[BEACH.x0 - 1.2, -0.25, 8.5], [BEACH.x1 + 1.4, 0.2, 7.5]].map(([hx, turn, len]) => {
    const p = outlinePL.at(outlinePL.project(hx, 46));
    let nx = p.tz * outSign, nz = -p.tx * outSign;
    const c = Math.cos(turn), s = Math.sin(turn);
    [nx, nz] = [nx * c - nz * s, nx * s + nz * c];
    return { x: p.x, z: p.z, nx, nz, len };
  });
  D.headlands = headlands;
  coastField = buildCoastField({ outline, stairFoot, headlands });
  D.coast = coastField;
  const CT = makeCoastTextures(ctx.maxAniso || 4);
  ctx.coastT = CT;
  coastUniforms.uCoastTex.value = CT.coastTex;
  coastUniforms.uNoiseTex.value = CT.noiseTex;
  M.coastGround = makeCoastGroundMaterial(CT);
  const coastMesh = buildCoastMesh(coastField, {
    xs: axisSamples(-FIELD_EXT, FIELD_EXT, -50, 26, 0.42, -80, 80, 1.4, 8, 1.18),
    zs: axisSamples(-FIELD_EXT, FIELD_EXT, 30, 74, 0.42, -72, 82, 1.4, 8, 1.18),
    walkRect: [-50, 30, 26, 74],
  });
  const ground = addMesh(ctx, coastMesh.geometry, M.coastGround, { shadow: false });
  ground.name = 'coast-ground';
  ctx.walk.push(coastMesh.walkGeometry);
  D.coastStats = { verts: coastMesh.verts, tris: coastMesh.tris };

  // dry-sand polygon: march out from the seawall along its normal to the still-water line
  {
    const shore = [], back = [];
    for (let s = 0; s < outlinePL.length; s += 0.5) {
      const p = outlinePL.at(s);
      if (coastField.beachWidthAt(p.x, p.z) < 0.35) continue;
      const nx = p.tz * outSign, nz = -p.tx * outSign;
      let t = 0;
      while (t < 24 && coastField.height(p.x + nx * t, p.z + nz * t) > 0) t += 0.1;
      shore.push([p.x + nx * t, p.z + nz * t]);
      back.push([p.x - nx * 1.2, p.z - nz * 1.2]);
    }
    D.beachPoly = [[...shore, ...back.reverse()]];
  }
  const beachPoly = D.beachPoly;

  // --- beach stairs -------------------------------------------------------------
  const stairRot = Math.atan2(onx, onz);         // local +z -> outward
  const bottomY = beachHeight(sp.x + onx * nSteps * tread, sp.z + onz * nSteps * tread) + 0.05;
  const rise = (WALK - bottomY) / nSteps;
  const stairMat = new THREE.Matrix4().compose(new THREE.Vector3(sp.x, 0, sp.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), stairRot), new THREE.Vector3(1, 1, 1));
  for (let k = 1; k <= nSteps; k++) {
    const top = WALK - k * rise;
    const h = top + 0.6;
    const g = ctx.batch.add(boxGeo(stairW, h, tread + 0.02, 1), M.concrete, 0, top - h / 2, (k - 0.5) * tread - 0.02, 0, { parent: stairMat });
    ctx.walk.push(g);
  }
  // cheek walls + handrails
  for (const sx of [-1, 1]) {
    const len = nSteps * tread;
    const cheek = new THREE.Shape([new THREE.Vector2(0, WALK + 0.05), new THREE.Vector2(len, bottomY + 0.05),
      new THREE.Vector2(len, -0.4), new THREE.Vector2(0, -0.4)]);
    const cg = new THREE.ExtrudeGeometry(cheek, { depth: 0.25, bevelEnabled: false });
    cg.rotateY(-Math.PI / 2);
    ctx.batch.add(cg, M.concrete, sx * (stairW / 2 + 0.125) + 0.125, 0, 0, 0, { parent: stairMat });
    for (let k = 0; k <= 3; k++) {
      const d = (k / 3) * len;
      const y = WALK + (bottomY - WALK) * (d / len);
      ctx.batch.add(new THREE.CylinderGeometry(0.04, 0.04, 1, 6), M.railing, sx * (stairW / 2 + 0.12), y + 0.55, d, 0, { parent: stairMat });
    }
    const rail = new THREE.CylinderGeometry(0.035, 0.035, Math.hypot(len, WALK - bottomY), 6);
    ctx.batch.add(rail, M.railing, sx * (stairW / 2 + 0.12), (WALK + bottomY) / 2 + 1.05, len / 2, 0,
      { parent: stairMat, rx: Math.PI / 2 + Math.atan2(WALK - bottomY, len) });
  }
  D.beachStair = { x: sp.x, z: sp.z, nx: onx, nz: onz };

  // --- pier -------------------------------------------------------------------
  const pierS = outlinePL.project(PIER.root[0], PIER.root[1]);
  const pr = outlinePL.at(pierS);
  const deckTop = PIER.deckTop;
  const pieces = [
    { cx: 28, cz: (pr.z - 0.6 + 48) / 2, w: 3, d: 48 - (pr.z - 0.6), rot: 0 },
    { cx: 28, cz: 51, w: 9, d: 7, rot: 0 },
  ];
  const armA = [32.4, 52.2], armB = [50, 57.2];
  const armLen = Math.hypot(armB[0] - armA[0], armB[1] - armA[1]);
  const armRot = Math.atan2(-(armB[1] - armA[1]), armB[0] - armA[0]);
  pieces.push({ cx: (armA[0] + armB[0]) / 2, cz: (armA[1] + armB[1]) / 2, w: armLen + 0.4, d: 3, rot: armRot });
  pieces.push({ cx: armB[0] + Math.cos(armRot) * 1.6, cz: armB[1] - Math.sin(armRot) * 1.6, w: 3.4, d: 8, rot: armRot });
  D.pier = { pieces, armRot, deckTop, root: [pr.x, pr.z] };
  const piles = [];
  for (const p of pieces) {
    const g = ctx.batch.add(boxGeo(p.w, 0.25, p.d, 3), M.planks, p.cx, deckTop - 0.125, p.cz, p.rot);
    ctx.walk.push(g);
    const c = Math.cos(p.rot), s = Math.sin(p.rot);
    // edge beams
    for (const v of [-p.d / 2 + 0.12, p.d / 2 - 0.12]) {
      ctx.batch.add(boxGeo(p.w, 0.3, 0.2, 1), M.woodDark, p.cx + v * s, deckTop - 0.4, p.cz + v * c, p.rot);
    }
    for (let u = -p.w / 2 + 0.3; u <= p.w / 2 - 0.2; u += 2.8) {
      for (const v of [-p.d / 2 + 0.25, p.d / 2 - 0.25]) {
        const x = p.cx + u * c + v * s, z = p.cz - u * s + v * c;
        if (z < pr.z + 0.3) continue;
        piles.push([x, z]);
      }
    }
  }
  D.pier.piles = piles;
  const pileGeo = new THREE.CylinderGeometry(0.17, 0.2, 1, 7);
  for (const [x, z] of piles) {
    const top = deckTop - 0.25, bot = -3;
    ctx.batch.add(pileGeo, M.woodDark, x, (top + bot) / 2, z, 0, { sy: top - bot });
  }
  // pier railings: approach (both sides), arm north side
  const railLine = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 2));
    const ry = Math.atan2(b[0] - a[0], b[1] - a[1]);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      ctx.batch.add(boxGeo(0.12, 1.0, 0.12, 1), M.wood, a[0] + (b[0] - a[0]) * t, deckTop + 0.5, a[1] + (b[1] - a[1]) * t);
    }
    for (const h of [0.55, 1.0]) {
      ctx.batch.add(boxGeo(0.08, 0.08, len, 1), M.wood, (a[0] + b[0]) / 2, deckTop + h, (a[1] + b[1]) / 2, ry);
    }
  };
  railLine([26.6, pr.z + 0.4], [26.6, 47.6]);
  railLine([29.4, pr.z + 0.4], [29.4, 47.6]);
  railLine([23.6, 47.6], [26.6, 47.6]);
  railLine([29.4, 47.6], [32.4, 47.6]);
  railLine([23.6, 47.6], [23.6, 54.4]);
  {
    const c = Math.cos(armRot), s = Math.sin(armRot);
    const off = (u, v) => [armA[0] + (armB[0] - armA[0]) * u + v * s, armA[1] + (armB[1] - armA[1]) * u + v * c];
    railLine(off(0, -1.4), off(1, -1.4));
  }

  // --- railings along the seawall ------------------------------------------------
  const gaps = [
    { s: stairS, half: stairW / 2 + 0.3 },
    { s: pierS, half: 1.8 },
  ];
  const inGap = (s) => gaps.some((g) => {
    let d = Math.abs(s - g.s); d = Math.min(d, outlinePL.length - d);
    return d < g.half;
  });
  const postGeo = new THREE.CylinderGeometry(0.045, 0.05, 1.0, 6);
  const railH = [0.5, 0.98];
  const step = 2.0;
  const n = Math.floor(outlinePL.length / step);
  const inset = 0.25;
  const railPt = (s) => {
    const p = outlinePL.at(s);
    return [p.x - p.tz * outSign * inset, p.z + p.tx * outSign * inset];
  };
  for (let i = 0; i < n; i++) {
    const s0 = i * step, s1 = (i + 1) * step;
    if (inGap(s0)) continue;
    const a = railPt(s0);
    ctx.batch.add(postGeo, M.railing, a[0], WALK + 0.5, a[1]);
    if (inGap(s1)) continue;
    const b = railPt(s1);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ry = Math.atan2(b[0] - a[0], b[1] - a[1]);
    for (const h of railH) {
      ctx.batch.add(boxGeo(0.06, 0.06, len + 0.04, 1), M.railing, (a[0] + b[0]) / 2, WALK + h, (a[1] + b[1]) / 2, ry);
    }
  }

  // --- planting beds --------------------------------------------------------------
  const footprints = buildingFootprints(ctx.data.stationFootprint || []);
  D.footprints = footprints;
  const pathLines = PATHS.map((p) => p.pts);
  let green = offsetPolys(plate, -3.2, true);
  green = difference(green, offsetPolys(roadsClosed, 2.6, true));
  green = difference(green, footprints);
  green = difference(green, PLAZAS);
  green = difference(green, bufferLines(pathLines, 1.2, { round: true }));
  green = difference(green, crossingRects.map((r) => r).flatMap((r) => offsetPolys([r], 3.2, true)));
  green = difference(green, offsetPolys(beachPoly, 0.5, true));
  green = openPolys(green, 0.7);
  green = green.filter((r) => Math.abs(ringArea(r)) > 4 || ringArea(r) < 0);
  D.green = green;

  // tropical lawn surface (inset behind the 18cm raised stone garden curb so grass never pokes through the curb wall)
  const greenGrassPoly = offsetPolys(green, -0.10, true);
  addMesh(ctx, slabGeometry(greenGrassPoly, WALK, GREEN_TOP, { uvTop: 3.8, sides: false }), M.grass, { walk: true });

  // solid 3D chamfered stone garden curb wall rising cleanly from WALK to GREEN_TOP + 0.018
  const greenCurbProfile = [
    [-0.19, GREEN_TOP - 0.03, 1.0],
    [-0.18, GREEN_TOP + 0.018, 0.90],
    [-0.038, GREEN_TOP + 0.018, 0.56],
    [-0.012, GREEN_TOP - 0.018, 0.44],
    [0.0, WALK - 0.02, 0.0],
  ];
  addMesh(ctx, curbGeometry(green, greenCurbProfile, { uvStep: 0.6 }), M.curb, { walk: true });

  // building foundation stone plinth trim
  const bldgBases = [
    rectPoly(APARTMENT.x, APARTMENT.z, APARTMENT.w, APARTMENT.d),
    rectPoly(GRAFFITI.x, GRAFFITI.z, GRAFFITI.w, GRAFFITI.d),
    rectPoly(CAFE.x, CAFE.z, CAFE.w, CAFE.d),
    rectPoly(PAVILION.x, PAVILION.z, PAVILION.size, PAVILION.size),
    rectPoly(SHOP.x, SHOP.z, SHOP.w, SHOP.d),
  ];
  const plinthProfile = [
    [-0.02, WALK + 0.08, 1.0],
    [0.03, WALK + 0.08, 0.65],
    [0.05, WALK + 0.055, 0.45],
    [0.06, WALK - 0.02, 0.0],
  ];
  addMesh(ctx, curbGeometry(bldgBases, plinthProfile, { uvStep: 0.65 }), M.curb, { shadow: false });

  // --- palm planters along the promenade -------------------------------------------
  const r = rng(77);
  D.palmSpots = [];
  const promenadeOff = 1.9;
  for (let s = 0; s < outlinePL.length; s += 8.5 + r() * 3) {
    if (inGap(s) || gaps.some((g) => Math.min(Math.abs(s - g.s), outlinePL.length - Math.abs(s - g.s)) < 4)) continue;
    const p = outlinePL.at(s);
    const x = p.x - p.tz * outSign * promenadeOff, z = p.z + p.tx * outSign * promenadeOff;
    if (pointInPolys(x, z, offsetPolys(roadsClosed, 0.6))) continue;
    if (pointInPolys(x, z, PLAZAS)) continue;
    if (D.crossings.some((c) => Math.hypot(c.x - x, c.z - z) < c.width / 2 + 3)) continue;
    if (pointInPolys(x, z, bufferLines(pathLines, 2.4, { round: true }))) continue;   // keep path ends open
    D.palmSpots.push([x, z]);
  }
  // round planter curbs with chamfered stone coping for promenade palms
  const planters = D.palmSpots.map(([x, z]) => circlePoly(x, z, 0.88, 24));
  const planterSoil = D.palmSpots.map(([x, z]) => circlePoly(x, z, 0.75, 24));
  if (planters.length) {
    addMesh(ctx, slabGeometry(planterSoil, WALK, WALK + 0.32, { uvTop: 1, sides: false }), M.soil, { walk: false });
    const planterCurbProfile = [
      [-0.15, WALK + 0.28, 1.0],
      [-0.14, WALK + 0.35, 0.86],
      [-0.02, WALK + 0.35, 0.54],
      [0.0, WALK + 0.32, 0.42],
      [0.01, WALK - 0.02, 0.0],
    ];
    addMesh(ctx, curbGeometry(planters, planterCurbProfile, { uvStep: 0.5 }), M.curb, { walk: false });
    for (const [x, z] of D.palmSpots) ctx.colliders.push({ type: 'circle', x, z, r: 1.0 });
  }

  // shoreline rocks + all planting are generated by src/nature (procedural asset system)
}

import * as THREE from 'three';
import ClipperLib from 'clipper-lib';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Sample a Catmull-Rom curve through [x,z] points into an evenly spaced polyline. */
export function sampleCurve(pts, closed, step = 1, tension = 0.5) {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, 'centripetal', tension);
  const len = curve.getLength();
  const n = Math.max(2, Math.round(len / step));
  const out = [];
  for (let i = 0; i < (closed ? n : n + 1); i++) {
    const p = curve.getPointAt(i / n);
    out.push([p.x, p.z]);
  }
  return out;
}

/** Arc-length table and helpers for a sampled polyline. */
export class Polyline {
  constructor(pts, closed) {
    this.pts = pts;
    this.closed = closed;
    this.cum = [0];
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      this.cum.push(this.cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }
  /** Position & unit tangent at arc length s. */
  at(s) {
    const L = this.length;
    if (this.closed) s = ((s % L) + L) % L; else s = Math.min(Math.max(s, 0), L);
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const seg = this.cum[lo + 1] - this.cum[lo] || 1;
    const t = (s - this.cum[lo]) / seg;
    const tx = (b[0] - a[0]) / seg, tz = (b[1] - a[1]) / seg;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx, tz };
  }
  /** Arc length of the closest point to (x,z). */
  project(x, z) {
    let best = Infinity, bestS = 0;
    const n = this.closed ? this.pts.length : this.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i], b = this.pts[(i + 1) % this.pts.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
      t = Math.min(1, Math.max(0, t));
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) { best = d; bestS = this.cum[i] + t * Math.sqrt(l2); }
    }
    return bestS;
  }
  /** Sub-polyline between arc lengths s0..s1 (s1 may exceed length on closed curves). */
  slice(s0, s1, step = 0.5) {
    const out = [];
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (let i = 0; i <= n; i++) { const p = this.at(s0 + (s1 - s0) * i / n); out.push([p.x, p.z]); }
    return out;
  }
  /** Offset polyline (left = +, using left normal (-tz, tx)... in x/z with +z south). */
  offset(d) {
    const out = [];
    const N = this.pts.length;
    for (let i = 0; i < N; i++) {
      const prev = this.pts[this.closed ? (i - 1 + N) % N : Math.max(0, i - 1)];
      const next = this.pts[this.closed ? (i + 1) % N : Math.min(N - 1, i + 1)];
      let tx = next[0] - prev[0], tz = next[1] - prev[1];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      out.push([this.pts[i][0] + tz * d, this.pts[i][1] - tx * d]);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Clipper polygon ops (world x,z <-> integer X,Y)
// ---------------------------------------------------------------------------
const S = 1000;
const toC = (path) => path.map(([x, z]) => ({ X: Math.round(x * S), Y: Math.round(z * S) }));
const fromC = (path) => path.map((p) => [p.X / S, p.Y / S]);

/** Polygon set = array of closed rings ([x,z][]) interpreted with non-zero fill. */
export function bufferLines(lines, halfWidth, { round = true, closedLines = false } = {}) {
  const co = new ClipperLib.ClipperOffset(2, 0.05 * S);
  for (const l of lines) {
    co.AddPath(toC(l), round ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter,
      closedLines ? ClipperLib.EndType.etClosedLine : (round ? ClipperLib.EndType.etOpenRound : ClipperLib.EndType.etOpenButt));
  }
  const sol = new ClipperLib.Paths();
  co.Execute(sol, halfWidth * S);
  return sol.map(fromC);
}

export function offsetPolys(polys, d, round = true) {
  const co = new ClipperLib.ClipperOffset(2, 0.05 * S);
  co.AddPaths(polys.map(toC), round ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, d * S);
  return sol.map(fromC);
}

function boolOp(type, a, b) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(a.map(toC), ClipperLib.PolyType.ptSubject, true);
  if (b && b.length) c.AddPaths(b.map(toC), ClipperLib.PolyType.ptClip, true);
  const sol = new ClipperLib.Paths();
  c.Execute(type, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol.map(fromC);
}
export const union = (a, b = []) => boolOp(ClipperLib.ClipType.ctUnion, a, b);
export const difference = (a, b) => boolOp(ClipperLib.ClipType.ctDifference, a, b);
export const intersection = (a, b) => boolOp(ClipperLib.ClipType.ctIntersection, a, b);

/** Morphological close: rounds concave corners (curb returns at junctions). */
export const closePolys = (p, r) => offsetPolys(offsetPolys(p, r, true), -r, true);
export const openPolys = (p, r) => offsetPolys(offsetPolys(p, -r, true), r, true);

function cleanPolyRing(raw, minStep = 0.015) {
  if (!raw || raw.length < 3) return raw;
  const pts = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) >= minStep) {
      pts.push(p);
    }
  }
  while (pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < minStep) {
    pts.pop();
  }
  return pts.length >= 3 ? pts : raw;
}

/** Convert polygon set into [{outer, holes}] using a Clipper PolyTree. */
export function toExPolys(polys) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(polys.map(toC), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((e) => ({
    outer: cleanPolyRing(fromC(e.outer)),
    holes: e.holes.map((h) => cleanPolyRing(fromC(h))),
  }));
}

export function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export const polysArea = (polys) => polys.reduce((s, r) => s + ringArea(r), 0);

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Even-odd containment across all rings of a polygon set. */
export function pointInPolys(x, z, polys) {
  let c = false;
  for (const r of polys) if (pointInRing(x, z, r)) c = !c;
  return c;
}

export function rectPoly(cx, cz, w, d, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
}
export function circlePoly(cx, cz, r, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/**
 * Extrude polygon set to a slab: top cap at yTop plus side walls down to yBottom.
 * World-space UVs (tile size uvTop / uvSide). Groups: 0 = top, 1 = sides.
 */
export function slabGeometry(polys, yBottom, yTop, { uvTop = 4, uvSide = 2, top = true, sides = true } = {}) {
  const ex = toExPolys(polys);
  const pos = [], nor = [], uv = [];
  let topCount = 0;
  if (top) {
    for (const { outer, holes } of ex) {
      const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
      const hs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
      const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
      const all = contour.concat(...hs);
      for (const [a, b, c] of tris) {
        let A = all[a], B = all[b], C = all[c];
        // ensure +y normal: cross((B-A),(C-A)).y = (Bz-Az)(Cx-Ax) - (Bx-Ax)(Cz-Az) > 0
        const cy = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
        if (cy < 0) [B, C] = [C, B];
        for (const P of [A, B, C]) { pos.push(P.x, yTop, P.y); nor.push(0, 1, 0); uv.push(P.x / uvTop, -P.y / uvTop); }
      }
    }
    topCount = pos.length / 3;
  }
  if (sides) {
    for (const { outer, holes } of ex) {
      for (const ring of [outer, ...holes]) {
        const isHole = ring !== outer;
        const ccw = ringArea(ring) > 0;
        let run = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const l = Math.hypot(dx, dz);
          if (l < 1e-6) continue;
          // outward (away from material) normal
          let nx = dz / l, nz = -dx / l;              // right-hand side
          const rightIsOutside = (ccw && !isHole) || (!ccw && isHole);
          if (!rightIsOutside) { nx = -nx; nz = -nz; }
          const u0 = run / uvSide, u1 = (run + l) / uvSide; run += l;
          const v0 = yBottom / uvSide, v1 = yTop / uvSide;
          const quad = [[a, yBottom, u0, v0], [b, yBottom, u1, v0], [b, yTop, u1, v1], [a, yTop, u0, v1]];
          // two triangles; fix winding to face (nx,nz)
          let tri = [[0, 1, 2], [0, 2, 3]];
          const p0 = quad[0], p1 = quad[1], p2 = quad[2];
          const e1 = [p1[0][0] - p0[0][0], p1[1] - p0[1], p1[0][1] - p0[0][1]];
          const e2 = [p2[0][0] - p0[0][0], p2[1] - p0[1], p2[0][1] - p0[0][1]];
          const cx = e1[1] * e2[2] - e1[2] * e2[1];
          const cz = e1[0] * e2[1] - e1[1] * e2[0];
          if (cx * nx + cz * nz < 0) tri = [[0, 2, 1], [0, 3, 2]];
          for (const t of tri) for (const k of t) {
            const q = quad[k];
            pos.push(q[0][0], q[1], q[0][1]); nor.push(nx, 0, nz); uv.push(q[2], q[3]);
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (top && sides) {
    g.addGroup(0, topCount, 0);
    g.addGroup(topCount, pos.length / 3 - topCount, 1);
  }
  return g;
}

/** Flat polygon decal at height y (markings). */
export function flatGeometry(polys, y, uvScale = 1) {
  return slabGeometry(polys, y, y, { uvTop: uvScale, sides: false });
}

/**
 * Extrude a 2D cross-section profile along all boundary rings of a polygon set.
 * profile: array of [outwardOffset, y, v] where outwardOffset > 0 is outside the polygon
 * and outwardOffset < 0 is inside the polygon. Produces continuous mitered corner/curve
 * geometry with arc-length UVs for fitted curb stones and edge courses.
 */
function cleanCurbRing(raw, minStep = 0.22) {
  if (!raw || raw.length < 3) return raw;
  // Pass 1: merge vertices closer than minStep (22cm) so 18-29cm curb profiles never fold over shorter segments
  const pts = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) >= minStep) {
      pts.push(p);
    }
  }
  while (pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < minStep) {
    pts.pop();
  }
  if (pts.length < 4) return pts.length >= 3 ? pts : raw;
  // Pass 2: remove sharp short staircase kinks produced by Clipper boolean intersections
  const out = [];
  const M = pts.length;
  for (let i = 0; i < M; i++) {
    const prev = out.length ? out[out.length - 1] : pts[(i - 1 + M) % M];
    const curr = pts[i];
    const next = pts[(i + 1) % M];
    const dx1 = curr[0] - prev[0], dz1 = curr[1] - prev[1];
    const dx2 = next[0] - curr[0], dz2 = next[1] - curr[1];
    const l1 = Math.hypot(dx1, dz1), l2 = Math.hypot(dx2, dz2);
    if (l1 < 1e-4 || l2 < 1e-4) continue;
    const dot = (dx1 * dx2 + dz1 * dz2) / (l1 * l2);
    // If a short segment (< 0.45m) kinks sharply or reverses direction relative to neighbours, skip the spike vertex
    if (Math.min(l1, l2) < 0.45 && dot < 0.35) continue;
    out.push(curr);
  }
  return out.length >= 3 ? out : pts;
}

export function curbGeometry(polys, profile, { uvStep = 0.6, filterSeg = null } = {}) {
  const ex = toExPolys(polys);
  const pos = [], nor = [], uv = [];
  for (const { outer, holes } of ex) {
    for (const rawRing of [outer, ...holes]) {
      const isHole = rawRing !== outer;
      const ring = cleanCurbRing(rawRing);
      const N = ring.length;
      if (N < 3) continue;
      const ccw = ringArea(ring) > 0;
      const rightIsOutside = (ccw && !isHole) || (!ccw && isHole);
      const segN = [];
      const segLen = [];
      for (let i = 0; i < N; i++) {
        const a = ring[i], b = ring[(i + 1) % N];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const l = Math.hypot(dx, dz) || 1e-6;
        let nx = dz / l, nz = -dx / l;
        if (!rightIsOutside) { nx = -nx; nz = -nz; }
        segN.push([nx, nz]);
        segLen.push(l);
      }
      // Mitered outward vectors at each vertex with safe bevel clamp
      const vMiter = [];
      for (let i = 0; i < N; i++) {
        const n0 = segN[(i - 1 + N) % N], n1 = segN[i];
        let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
        const ml = Math.hypot(mx, mz);
        if (ml < 1e-3) {
          vMiter.push([n1[0], n1[1], 1]);
        } else {
          mx /= ml; mz /= ml;
          const dot = Math.max(0.72, mx * n1[0] + mz * n1[1]);
          vMiter.push([mx, mz, Math.min(1.25, 1 / dot)]);
        }
      }
      let run = 0;
      for (let i = 0; i < N; i++) {
        const l = segLen[i];
        if (l < 1e-5) continue;
        const a = ring[i], b = ring[(i + 1) % N];
        const u0 = run / uvStep, u1 = (run + l) / uvStep;
        run += l;
        if (filterSeg && !filterSeg((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)) continue;
        const mA = vMiter[i], mB = vMiter[(i + 1) % N];
        const sn = segN[i];
        for (let k = 0; k < profile.length - 1; k++) {
          const [off0, y0, v0] = profile[k];
          const [off1, y1, v1] = profile[k + 1];
          const doff = off1 - off0, dy = y1 - y0;
          const dl = Math.hypot(doff, dy) || 1;
          const nOut = -dy / dl, nUp = doff / dl;
          const nx = sn[0] * nOut, ny = nUp, nz = sn[1] * nOut;
          const p00 = [a[0] + mA[0] * mA[2] * off0, y0, a[1] + mA[1] * mA[2] * off0, u0, v0];
          const p10 = [b[0] + mB[0] * mB[2] * off0, y0, b[1] + mB[1] * mB[2] * off0, u1, v0];
          const p11 = [b[0] + mB[0] * mB[2] * off1, y1, b[1] + mB[1] * mB[2] * off1, u1, v1];
          const p01 = [a[0] + mA[0] * mA[2] * off1, y1, a[1] + mA[1] * mA[2] * off1, u0, v1];
          const quad = [p00, p10, p11, p01];
          const e1 = [p10[0] - p00[0], p10[1] - p00[1], p10[2] - p00[2]];
          const e2 = [p11[0] - p00[0], p11[1] - p00[1], p11[2] - p00[2]];
          const cx = e1[1] * e2[2] - e1[2] * e2[1];
          const cy = e1[2] * e2[0] - e1[0] * e2[2];
          const cz = e1[0] * e2[1] - e1[1] * e2[0];
          const tris = (cx * nx + cy * ny + cz * nz < 0) ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
          for (const t of tris) for (const idx of t) {
            const q = quad[idx];
            pos.push(q[0], q[1], q[2]);
            nor.push(nx, ny, nz);
            uv.push(q[3], q[4]);
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Box with world-scaled UVs (texture tile tw x th metres). */
export function boxGeo(w, h, d, tw = 1, th = tw) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // faces: px, nx, py, ny, pz, nz (4 verts each)
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * dims[f][0] / tw, uv.getY(k) * dims[f][1] / th);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Static batcher: collect geometries per material, merge into one mesh each.
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();
export class Batch {
  constructor() { this.groups = new Map(); }
  /** add(geometry, material, position/rotation/scale or Matrix4) */
  add(geo, mat, x = 0, y = 0, z = 0, ry = 0, opts = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    g.clearGroups();
    if (opts.matrix) g.applyMatrix4(opts.matrix);
    else {
      _m.compose(new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(opts.rx || 0, ry, opts.rz || 0, 'YXZ')),
        new THREE.Vector3(opts.sx ?? 1, opts.sy ?? 1, opts.sz ?? 1));
      g.applyMatrix4(_m);
    }
    if (opts.parent) g.applyMatrix4(opts.parent);
    const key = mat.uuid + (opts.noShadow ? ':ns' : '');
    if (!this.groups.has(key)) this.groups.set(key, { mat, geos: [], noShadow: !!opts.noShadow });
    this.groups.get(key).geos.push(g);
    return g;
  }
  build(parent) {
    const meshes = [];
    for (const { mat, geos, noShadow } of this.groups.values()) {
      const merged = mergeGeometries(geos, false);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = !noShadow && !mat.transparent;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.groups.clear();
    return meshes;
  }
}

/** Deterministic PRNG so the layout is identical every load. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

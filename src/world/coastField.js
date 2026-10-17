import * as THREE from 'three';
import { BEACH, SWELL_FROM } from '../layout.js';

// ---------------------------------------------------------------------------
// Coastal heightfield: one continuous surface for dry beach, wet foreshore,
// submerged shelf and offshore seabed, derived from the real seawall outline
// with exact distance transforms. Everything coastal (beach mesh, seabed,
// rock bedding, water depth/foam fields, swash) samples this one field, so
// land, sand, rocks and water always agree.
// ---------------------------------------------------------------------------

export const FN = 1024;                 // field resolution (cells per side)
export const FEXT = 160;                // field covers world [-FEXT, FEXT] in x and z
export const FCELL = (2 * FEXT) / FN;   // 0.3125 m

// ---- deterministic value noise ------------------------------------------------
function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed + 1013, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(x, z, seed = 0) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let xf = x - xi, zf = z - zi;
  xf = xf * xf * (3 - 2 * xf); zf = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed), c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
}
export function fbm(x, z, seed = 0, oct = 3) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f, seed + i * 31); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
export const sstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

// ---- rasterisation, distance transforms, filters ------------------------------
/** Even-odd fill of [x,z] rings into an N x N cell mask over [-ext, ext]. */
export function rasterize(rings, N = FN, ext = FEXT) {
  const cell = (2 * ext) / N;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.beginPath();
  for (const ring of rings) {
    ring.forEach(([x, z], i) => { const px = (x + ext) / cell, py = (z + ext) / cell; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
    g.closePath();
  }
  g.fill('evenodd');
  const d = g.getImageData(0, 0, N, N).data;
  const m = new Uint8Array(N * N);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return m;
}

// Felzenszwalb & Huttenlocher exact squared EDT, 1D pass.
function edt1d(f, n, d, v, zz) {
  let k = 0;
  v[0] = 0; zz[0] = -1e20; zz[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= zz[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; zz[k] = s; zz[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (zz[k + 1] < q) k++; const dq = q - v[k]; d[q] = dq * dq + f[v[k]]; }
}
/** Euclidean distance (in cells) from every cell to the nearest cell where mask === on. */
export function edt(mask, N = FN, on = 1) {
  const g = new Float64Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] === on ? 0 : 1e20;
  const f = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), zz = new Float64Array(N + 1);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) f[y] = g[y * N + x];
    edt1d(f, N, d, v, zz);
    for (let y = 0; y < N; y++) g[y * N + x] = d[y];
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const o = y * N;
    for (let x = 0; x < N; x++) f[x] = g[o + x];
    edt1d(f, N, d, v, zz);
    for (let x = 0; x < N; x++) out[o + x] = Math.sqrt(d[x]);
  }
  return out;
}
/** Signed distance in metres: positive outside the mask, negative inside. */
export function signedDistance(mask, N = FN, cell = FCELL) {
  const dOut = edt(mask, N, 1), dIn = edt(mask, N, 0);
  const sd = new Float32Array(N * N);
  for (let i = 0; i < sd.length; i++) sd[i] = (dOut[i] > 0 ? dOut[i] - 0.5 : 0.5 - dIn[i]) * cell;
  return sd;
}
/** Separable box blur with radius r cells (repeated passes approximate a gaussian). */
export function boxBlur(src, N = FN, r = 1, passes = 1) {
  let a = Float32Array.from(src), b = new Float32Array(N * N);
  const w = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) {
      const o = y * N;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[o + Math.min(N - 1, Math.max(0, k))];
      for (let x = 0; x < N; x++) {
        b[o + x] = acc / w;
        acc += a[o + Math.min(N - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[Math.min(N - 1, Math.max(0, k)) * N + x];
      for (let y = 0; y < N; y++) {
        a[y * N + x] = acc / w;
        acc += b[Math.min(N - 1, y + r + 1) * N + x] - b[Math.max(0, y - r) * N + x];
      }
    }
  }
  return a;
}
/** Bilinear sampler over a cell-centred field (clamped at the border). */
export function sampler(arr, N = FN, ext = FEXT, stride = 1, offset = 0) {
  const cell = (2 * ext) / N;
  return (x, z) => {
    let fx = (x + ext) / cell - 0.5, fz = (z + ext) / cell - 0.5;
    fx = Math.min(N - 1.001, Math.max(0, fx)); fz = Math.min(N - 1.001, Math.max(0, fz));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * N + i;
    const a = arr[k * stride + offset], b = arr[(k + 1) * stride + offset];
    const c = arr[(k + N) * stride + offset], d = arr[(k + N + 1) * stride + offset];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

// ---- beach plan shape ---------------------------------------------------------------
/**
 * Width of dry sand (seawall foot -> still-water line) along the southern shore.
 * A pocket beach between two rocky points: broad and fairly straight in the
 * middle, horns that taper quickly into the headlands, low-frequency width
 * wander and faint rhythmic beach cusps.
 */
export function beachWidthParts(x) {
  const c = (BEACH.x0 + BEACH.x1) / 2, hs = (BEACH.x1 - BEACH.x0) / 2;
  const t = (x - c) / hs;
  const inside = 1 - t * t;
  if (inside <= 0) return { w: 0, ws: 0, cusp: 0 };
  let ws = BEACH.width * Math.pow(inside, 0.42);
  ws *= 1 + 0.2 * (fbm(x * 0.085, 3.7, 17, 2) - 0.5) * 2;
  // short irregularities + rhythmic beach cusps with wandering spacing and strength (shoreline only)
  const cusp = (0.07 * ws * (vnoise(x * 0.31, 8.1, 19) - 0.5) * 2
    + Math.sin(x * 0.92 + 2.2 * vnoise(x * 0.17, 0.5, 23)) * (0.25 + 0.5 * vnoise(x * 0.11, 2.5, 29))) * Math.min(1, inside * 2.5);
  return { w: Math.max(0, ws + cusp), ws, cusp };
}
export const beachWidthX = (x) => beachWidthParts(x).w;
/** Smooth along-shore envelope of the beach's submerged sand terrace (wider and softer than the dry sand). */
export function beachTerraceX(x) {
  const c = (BEACH.x0 + BEACH.x1) / 2, hs = (BEACH.x1 - BEACH.x0) / 2;
  const t = Math.abs(x - c) / hs;
  return 1 - sstep(0.55, 1.45, t);
}
export const beachSouth = (z) => sstep(31, 37, z);

// ---- field ---------------------------------------------------------------------------
/**
 * outline: seawall ring; stairFoot: [x,z] where the access stair lands;
 * headlands: [{x,z,nx,nz,len}] rocky points framing the beach (reef shelves).
 */
export function buildCoastField({ outline, stairFoot, headlands }) {
  const N = FN, cell = FCELL, ext = FEXT;
  const plate = rasterize([outline]);
  const sd = boxBlur(signedDistance(plate), N, 1, 1);
  const H = new Float32Array(N * N), BI = new Float32Array(N * N);
  const [sfx, sfz] = stairFoot;
  const [fx, fz] = SWELL_FROM;
  for (let j = 0; j < N; j++) {
    const z = -ext + (j + 0.5) * cell;
    for (let i = 0; i < N; i++) {
      const x = -ext + (i + 0.5) * cell;
      const k = j * N + i;
      const d = Math.max(0, sd[k]);
      // seaward normal of the nearest seawall (distance gradient) -> wave exposure
      const gx = sd[k + (i < N - 1 ? 1 : 0)] - sd[k - (i > 0 ? 1 : 0)];
      const gz = sd[k + (j < N - 1 ? N : 0)] - sd[k - (j > 0 ? N : 0)];
      const gl = Math.hypot(gx, gz) || 1;
      const expo = Math.max(0, (gx * fx + gz * fz) / gl);

      // ---- offshore profile: narrow rocky shelf, drop-off, deep sandy floor
      if (d > 140) { H[k] = -12.4 + 0.4 * (vnoise(x * 0.02, z * 0.02, 7) - 0.5); continue; }
      const shelf = (7 + 7 * vnoise(x * 0.03, z * 0.03, 5)) * (1 - 0.32 * expo);
      const drop = 24 + 16 * vnoise(x * 0.021 + 3.1, z * 0.021, 6);
      let h = -0.42 - 0.85 * sstep(0, shelf, d) - 4.2 * sstep(shelf * 0.5, shelf + drop, d) - 7.2 * sstep(30, 125, d);
      h += 0.5 * (fbm(x * 0.045, z * 0.045, 9, 3) - 0.5) * sstep(3, 18, d);
      h += 0.2 * (vnoise(x * 0.12, z * 0.12, 12) - 0.5) * sstep(1.5, 6, d) * (1 - sstep(20, 40, d));

      // ---- beach: backshore, berm, foreshore, low-tide terrace, runnel and bar
      const south = beachSouth(z);
      const lat = beachTerraceX(x) * south;
      let bi = 0;
      if (lat > 0.001) {
        const bw = beachWidthParts(x);
        const w = bw.w * south;
        const wc = Math.max(bw.ws * south, 0.6);
        const T = BEACH.top * sstep(0, 6, w);
        const back = T - 0.035 * d;
        const berm = T - 0.035 * 0.58 * wc;
        const fs = Math.min(0.16, Math.max(0.05, berm / (0.42 * wc)));
        const q = d - wc;
        const fore = q <= 0 ? -fs * q : -fs * 5 * (1 - Math.exp(-q / 5)) - 0.045 * q;
        let hs = smin(back, fore, 0.25);
        hs += fs * bw.cusp * south * Math.exp(-(q * q) / 7);                         // cusps shape the waterline only
        const dry = sstep(w + 0.5, w - 1.5, d);
        hs += 0.05 * (fbm(x * 0.3, z * 0.3, 31, 2) - 0.5) * 2 * (0.4 + 0.6 * dry);   // uneven accumulation
        hs += 0.11 * fbm(x * 0.45, z * 0.45, 33, 2) * Math.exp(-d / 2.6);             // wind hummocks at the wall
        hs += 0.1 * Math.exp(-d / 0.9);                                                 // sand banked against the wall
        hs += (-0.07 * Math.exp(-((q - 3.5) ** 2) / 3) + 0.05 * Math.exp(-((q - 7.5) ** 2) / 5)) * (0.5 + vnoise(x * 0.08, 1.3, 41));
        const sf = (x - sfx) ** 2 + (z - sfz) ** 2;
        hs += 0.12 * Math.exp(-sf / 3);                                                 // drift heaped at the stair foot
        // dry sand follows the plan width exactly; the submerged terrace fades
        // laterally (soft envelope) and offshore into the shelf drop-off
        const dryK = sstep(0.3, 2.5, w);
        bi = (dryK + (1 - dryK) * sstep(0, 4, q)) * lat * (1 - sstep(6, 24, q));
        h += (smax(h, hs, 0.35) - h) * bi;
        bi *= sstep(0.3, 2.5, w + 1.5);
      }
      // ---- reef shelves under the rocky points (rocks bed onto these)
      for (const hd of headlands) {
        const px = x - hd.x, pz = z - hd.z;
        const u = px * hd.nx + pz * hd.nz, v = -px * hd.nz + pz * hd.nx;
        const uc = Math.max(0, Math.min(hd.len, u));
        const dist2 = (u - uc) ** 2 + v * v;
        if (dist2 > 60) continue;
        const hr = -0.22 - 0.05 * uc - 0.06 * dist2 + 0.18 * (vnoise(x * 0.5, z * 0.5, 51) - 0.5);
        h = smax(h, hr, 0.4);
      }
      H[k] = h;
      BI[k] = bi;
    }
  }
  const height = sampler(H), wallDist = sampler(sd), beachInf = sampler(BI);
  return {
    N, cell, ext, H, BI, sd, plate, height, wallDist, beachInf,
    beachWidthAt: (x, z) => beachWidthX(x) * beachSouth(z),
    /** Surface normal of the field (world). */
    normal(x, z, e = 0.35) {
      const nx = height(x - e, z) - height(x + e, z), nz = height(x, z - e) - height(x, z + e);
      const l = Math.hypot(nx, 2 * e, nz);
      return [nx / l, (2 * e) / l, nz / l];
    },
  };
}

// ---- meshes ---------------------------------------------------------------------------
/**
 * Non-uniform axis samples: `fine` spacing inside [f0,f1], `mid` inside [m0,m1],
 * geometric growth beyond (to `maxStep`). Tensor grids built from two such axes
 * have no T-junctions, so density can vary without cracks.
 */
export function axisSamples(lo, hi, f0, f1, fine, m0, m1, mid, maxStep = 8, growth = 1.18) {
  const out = [lo];
  let v = lo;
  const stepAt = (p) => {
    if (p >= f0 && p < f1) return fine;
    if (p >= m0 && p < m1) return p < f0 ? Math.min(mid, f0 - p) : mid;
    const out0 = p < m0 ? m0 - p : p - m1;
    return Math.min(maxStep, mid * Math.pow(growth, out0 / mid));
  };
  while (v < hi) {
    let s = stepAt(v);
    if (v < f0 && v + s > f0) s = f0 - v;
    if (v < m0 && v + s > m0) s = m0 - v;
    v = Math.min(hi, v + Math.max(0.05, s));
    out.push(v);
  }
  return out;
}

/** Terrain (beach + seabed) mesh, plus a walkable sub-mesh of the beach. */
export function buildCoastMesh(field, { xs, zs, walkRect }) {
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = xs[i], z = zs[j], k = j * nx + i;
    pos[k * 3] = x; pos[k * 3 + 1] = field.height(x, z); pos[k * 3 + 2] = z;
    const n = field.normal(x, z);
    nor[k * 3] = n[0]; nor[k * 3 + 1] = n[1]; nor[k * 3 + 2] = n[2];
    inside[k] = field.wallDist(x, z) < -1.6 ? 1 : 0;   // buried deep under the island plate
  }
  const idx = [], walk = [];
  const [wx0, wz0, wx1, wz1] = walkRect;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    if (inside[a] && inside[b] && inside[c] && inside[d]) continue;
    idx.push(a, c, b, b, c, d);
    const x = xs[i], z = zs[j];
    if (x >= wx0 && x <= wx1 && z >= wz0 && z <= wz1) {
      const top = Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1], pos[d * 3 + 1]);
      if (top > -0.7) for (const v of [a, c, b, b, c, d]) walk.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeBoundingSphere();
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(walk, 3));
  return { geometry: g, walkGeometry: wg, verts: nx * nz, tris: idx.length / 3 };
}

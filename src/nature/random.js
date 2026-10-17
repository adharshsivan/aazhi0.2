// Seeded randomness + noise used by every procedural asset and placement pass,
// so the island regenerates identically on every load.
export { rng } from '../geom.js';

export function hash3(x, y, z, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/** Trilinear value noise in [0,1]. */
export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const h = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), xf), l(h(0, 1, 0), h(1, 1, 0), xf), yf),
    l(l(h(0, 0, 1), h(1, 0, 1), xf), l(h(0, 1, 1), h(1, 1, 1), xf), yf), zf);
}

export function fbm3(x, y, z, seed = 0, oct = 3) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise3(x * f, y * f, z * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

/** 2D noise for species clustering across the island. */
export const noise2 = (x, z, seed = 0) => noise3(x, 0.5, z, seed);

/** Polygon set rasterised once (canvas, even-odd) for O(1) point-in-zone tests. */
export class PolyMask {
  constructor(polys, cell = 0.15, bounds = [-75, -65, 75, 75]) {
    const [x0, z0, x1, z1] = bounds;
    this.x0 = x0; this.z0 = z0; this.cell = cell;
    this.w = Math.ceil((x1 - x0) / cell); this.h = Math.ceil((z1 - z0) / cell);
    const c = document.createElement('canvas');
    c.width = this.w; c.height = this.h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.beginPath();
    for (const ring of polys) {
      ring.forEach(([x, z], i) => { const px = (x - x0) / cell, py = (z - z0) / cell; i ? g.lineTo(px, py) : g.moveTo(px, py); });
      g.closePath();
    }
    g.fill('evenodd');
    const d = g.getImageData(0, 0, this.w, this.h).data;
    this.bits = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.bits.length; i++) this.bits[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  }
  has(x, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    return this.bits[j * this.w + i] === 1;
  }
}

/** Uniform-grid spatial hash for neighbour queries during placement. */
export class SpatialHash {
  constructor(cell = 2.5) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  add(q) {
    const k = this.key(Math.floor(q.x / this.cell), Math.floor(q.z / this.cell));
    let l = this.map.get(k); if (!l) this.map.set(k, (l = [])); l.push(q);
  }
  /** First item within `rad` satisfying fn(item, distance). */
  find(x, z, rad, fn) {
    const c = this.cell, i0 = Math.floor((x - rad) / c), i1 = Math.floor((x + rad) / c);
    const j0 = Math.floor((z - rad) / c), j1 = Math.floor((z + rad) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l = this.map.get(this.key(i, j)); if (!l) continue;
      for (const q of l) { const d = Math.hypot(q.x - x, q.z - z); if (d <= rad && fn(q, d)) return q; }
    }
    return null;
  }
  any(x, z, rad, fn) { return this.find(x, z, rad, fn) !== null; }
}

/**
 * Bridson Poisson-disk sampling inside [x0,x1]x[z0,z1].
 * `radius(x,z)` may vary spatially; `accept(x,z)` filters candidates.
 */
export function poissonDisk(r, bounds, rMin, radius, accept, maxPoints = 1e5, k = 18) {
  const [x0, z0, x1, z1] = bounds;
  const cell = rMin / Math.SQRT2;
  const gw = Math.ceil((x1 - x0) / cell), gh = Math.ceil((z1 - z0) / cell);
  const grid = new Map();
  const pts = [], active = [];
  const key = (x, z) => Math.floor((x - x0) / cell) + Math.floor((z - z0) / cell) * gw;
  const fits = (x, z, rr) => {
    const gx = Math.floor((x - x0) / cell), gz = Math.floor((z - z0) / cell);
    const span = Math.ceil(rr / cell) + 1;
    for (let j = gz - span; j <= gz + span; j++) {
      if (j < 0 || j >= gh) continue;
      for (let i = gx - span; i <= gx + span; i++) {
        if (i < 0 || i >= gw) continue;
        const list = grid.get(i + j * gw);
        if (!list) continue;
        for (const p of list) {
          const need = Math.max(rr, p.r);
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < need * need) return false;
        }
      }
    }
    return true;
  };
  const add = (x, z) => {
    const p = { x, z, r: radius(x, z) };
    pts.push(p); active.push(p);
    const kk = key(x, z);
    if (!grid.has(kk)) grid.set(kk, []);
    grid.get(kk).push(p);
  };
  // seed many starting points so disconnected beds all get covered
  for (let i = 0; i < 400 && pts.length < maxPoints; i++) {
    const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
    if (accept(x, z) && fits(x, z, radius(x, z))) add(x, z);
  }
  while (active.length && pts.length < maxPoints) {
    const idx = Math.floor(r() * active.length);
    const p = active[idx];
    let found = false;
    for (let t = 0; t < k; t++) {
      const a = r() * Math.PI * 2, d = p.r * (1 + r());
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      if (!accept(x, z)) continue;
      if (!fits(x, z, radius(x, z))) continue;
      add(x, z); found = true; break;
    }
    if (!found) active.splice(idx, 1);
  }
  return pts;
}

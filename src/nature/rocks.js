import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, fbm3, noise3 } from './random.js';

// Procedural coastal boulders. Each rock is a pure function of its seed:
// a noisy ellipsoid sculpted by random planar fractures (angular faces) and a
// flat-ish bearing face, so every LOD of the same rock has the same silhouette.

/**
 * Tileable granite textures for world-space triplanar use:
 *  albedo (sRGB, low large-scale contrast) + tangent-space normal map derived
 *  from the same height field (replaces screen-derivative bump, which produced
 *  2x2-pixel blocky noise).
 */
export function makeRockTextures(maxAniso = 4) {
  const N = 512;
  const r = rng(707);
  const octs = [4, 8, 16, 32, 64, 128].map((P) => {
    const g = new Float32Array(P * P);
    for (let i = 0; i < g.length; i++) g[i] = r();
    return { P, g };
  });
  const sm = (t) => t * t * (3 - 2 * t);
  const val = (o, x, y) => {
    const fx = (x / N) * o.P, fy = (y / N) * o.P;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
    const P = o.P, g = o.g, xa = x0 % P, xb = (x0 + 1) % P, ya = y0 % P, yb = (y0 + 1) % P;
    const a = g[ya * P + xa], b = g[ya * P + xb], c = g[yb * P + xa], d = g[yb * P + xb];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
  };
  const H = new Float32Array(N * N), lich = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, amp = 0.5, tot = 0;
    for (const o of octs) { v += val(o, x, y) * amp; tot += amp; amp *= 0.55; }
    H[y * N + x] = v / tot;
    lich[y * N + x] = val(octs[1], x + 97, y + 31);
  }
  const W = (i) => ((i % N) + N) % N;
  const stamp = (cx, cy, rad, delta, arr = H) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const d2 = dx * dx + dy * dy; if (d2 > rad * rad) continue;
      arr[W(cy + dy) * N + W(cx + dx)] += delta * (1 - d2 / (rad * rad + 1));
    }
  };
  // feldspar / mica grains (soft, a few px) and weathering pits
  for (let i = 0; i < 9000; i++) stamp(Math.floor(r() * N), Math.floor(r() * N), 1 + Math.floor(r() * 2), r() < 0.5 ? -0.08 : 0.07);
  for (let i = 0; i < 260; i++) stamp(Math.floor(r() * N), Math.floor(r() * N), 2 + Math.floor(r() * 3), -0.12);
  // hairline fractures
  for (let k = 0; k < 18; k++) {
    let x = r() * N, y = r() * N, a = r() * 6.28;
    const len = 80 + r() * 260;
    for (let s = 0; s < len; s++) { a += (r() - 0.5) * 0.35; x += Math.cos(a); y += Math.sin(a); stamp(Math.floor(x), Math.floor(y), 1, -0.18); }
  }
  const albedo = new Uint8Array(N * N * 4), normal = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const h = H[i];
    let l = 0.6 + (h - 0.5) * 0.6;
    const lc = Math.max(0, lich[i] - 0.62) * 1.6;                  // pale lichen / salt bloom patches
    let R = l * (1 + lc * 0.12), G = l * (1 + lc * 0.14), B = l * (0.97 + lc * 0.04);
    albedo[i * 4] = Math.min(255, R * 255); albedo[i * 4 + 1] = Math.min(255, G * 255); albedo[i * 4 + 2] = Math.min(255, B * 255); albedo[i * 4 + 3] = 255;
    const dx = H[y * N + W(x + 1)] - H[y * N + W(x - 1)];
    const dy = H[W(y + 1) * N + x] - H[W(y - 1) * N + x];
    const k = 9;
    let nx = -dx * k, ny = -dy * k, nz = 1;
    const ln = Math.hypot(nx, ny, nz); nx /= ln; ny /= ln; nz /= ln;
    normal[i * 4] = (nx * 0.5 + 0.5) * 255; normal[i * 4 + 1] = (ny * 0.5 + 0.5) * 255; normal[i * 4 + 2] = (nz * 0.5 + 0.5) * 255; normal[i * 4 + 3] = 255;
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = maxAniso; t.needsUpdate = true;
    return t;
  };
  return { albedo: mk(albedo, true), normal: mk(normal, false) };
}

// granite greys, weathered browns, a rare laterite-red stone (sRGB)
const PALETTE = [[0.6, 0.59, 0.57], [0.53, 0.52, 0.5], [0.46, 0.45, 0.44], [0.62, 0.59, 0.54], [0.56, 0.52, 0.47], [0.58, 0.48, 0.41]];

/**
 * kind: 'boulder' (rounded, few fractures), 'block' (angular quarry stone), 'slab' (flat).
 * Returns geometry with position/normal/uv/color (+ bounds in userData).
 */
export function rockGeometry(seed, detail, kind = 'boulder') {
  const r = rng(seed);
  const ax = new THREE.Vector3(1, 0.62 + r() * 0.28, 0.82 + r() * 0.3);
  if (kind === 'slab') ax.y = 0.42 + r() * 0.15;
  const cuts = [];
  const nCuts = kind === 'block' ? 9 + Math.floor(r() * 4) : kind === 'slab' ? 6 + Math.floor(r() * 3) : 6 + Math.floor(r() * 4);
  for (let i = 0; i < nCuts; i++) {
    const n = new THREE.Vector3(r() - 0.5, (r() - 0.5) * (kind === 'block' ? 1.2 : 0.9), r() - 0.5).normalize();
    // fracture planes: flat faces meeting at fairly crisp edges
    cuts.push({ n, o: (kind === 'block' ? 0.42 : 0.52) + r() * 0.24, k: 0.98 + r() * 0.02 });
  }
  cuts.push({ n: new THREE.Vector3((r() - 0.5) * 0.3, -1, (r() - 0.5) * 0.3).normalize(), o: 0.36 + r() * 0.12, k: 0.97 });
  const ns = Math.floor(r() * 1000);
  const pal = PALETTE[r() < 0.06 ? 5 : Math.floor(r() * 5)];
  const base = new THREE.Color().setRGB(pal[0], pal[1], pal[2], THREE.SRGBColorSpace);

  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const d = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    const rad = 1 + 0.3 * (fbm3(d.x * 1.3 + ns, d.y * 1.3, d.z * 1.3, ns, 3) - 0.5) + 0.1 * (fbm3(d.x * 3.6, d.y * 3.6 + ns, d.z * 3.6, ns + 5, 2) - 0.5);
    v.copy(d).multiplyScalar(rad).multiply(ax);
    for (const c of cuts) {
      const k = v.dot(c.n) - c.o;
      if (k > 0) v.addScaledVector(c.n, -k * c.k);
    }
    v.addScaledVector(d, 0.03 * (noise3(d.x * 9 + ns, d.y * 9, d.z * 9, ns + 9) - 0.5));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();

  // cavity AO from neighbour directions + mottled colour
  const idx = g.index.array, nrm = g.attributes.normal;
  const cav = new Float32Array(pos.count), cnt = new Float32Array(pos.count);
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), na = new THREE.Vector3();
  const edge = (a, b) => {
    pa.fromBufferAttribute(pos, a); pb.fromBufferAttribute(pos, b); na.fromBufferAttribute(nrm, a);
    const e = pb.sub(pa); const l = e.length(); if (l < 1e-6) return;
    cav[a] += na.dot(e) / l; cnt[a]++;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(a, c); edge(c, a);
  }
  const col = new Float32Array(pos.count * 3), uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const c = cnt[i] ? cav[i] / cnt[i] : 0;
    const ao = THREE.MathUtils.clamp(1 - Math.max(0, c) * 2.2, 0.45, 1);
    const mott = 0.9 + 0.18 * fbm3(v.x * 2.2 + ns, v.y * 2.2, v.z * 2.2, ns + 3, 3);
    const low = 0.78 + 0.22 * THREE.MathUtils.clamp(v.y + 0.55, 0, 1);
    const k = ao * mott * low;
    col[i * 3] = base.r * k; col[i * 3 + 1] = base.g * k; col[i * 3 + 2] = base.b * k;
    uv[i * 2] = v.x * 0.5; uv[i * 2 + 1] = v.z * 0.5;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingBox(); g.computeBoundingSphere();
  const bb = g.boundingBox;
  g.userData.bounds = { minY: bb.min.y, maxY: bb.max.y, rXZ: Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) };
  return g;
}

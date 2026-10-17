import * as THREE from 'three';
import { rng } from './geom.js';

// High-quality procedural ground surfaces built from tileable height fields:
// every surface gets a matching albedo + tangent-space normal map. Colour
// variation is multi-scale and low-contrast (no per-pixel speckle noise).

function periodicNoise(N, P, r) {
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = ((x / N) * P) % P, fy = ((y / N) * P) % P;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
    const xa = ((x0 % P) + P) % P, xb = (xa + 1) % P, ya = ((y0 % P) + P) % P, yb = (ya + 1) % P;
    const a = g[ya * P + xa], b = g[ya * P + xb], c = g[yb * P + xa], d = g[yb * P + xb];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };
}
function fbm(N, periods, r) {
  const fns = periods.map((P) => periodicNoise(N, P, r));
  return (x, y) => { let v = 0, a = 0.5, t = 0; for (const f of fns) { v += f(x, y) * a; t += a; a *= 0.5; } return v / t; };
}
const wrap = (i, N) => ((i % N) + N) % N;

function normalFrom(H, N, k) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = H[y * N + wrap(x + 1, N)] - H[y * N + wrap(x - 1, N)];
    const dy = H[wrap(y + 1, N) * N + x] - H[wrap(y - 1, N) * N + x];
    let nx = -dx * k, ny = dy * k, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}
function texFrom(data, N, srgb, aniso) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = aniso; t.flipY = false; t.needsUpdate = true;
  return t;
}
function pack(N, fn) {
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const [r, g, b] = fn(x, y, y * N + x);
    const i = (y * N + x) * 4;
    d[i] = Math.max(0, Math.min(255, r * 255)); d[i + 1] = Math.max(0, Math.min(255, g * 255)); d[i + 2] = Math.max(0, Math.min(255, b * 255)); d[i + 3] = 255;
  }
  return d;
}
function stamp(H, N, cx, cy, rad, h) {
  const R = Math.ceil(rad);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d2 = (dx * dx + dy * dy) / (rad * rad); if (d2 > 1) continue;
    H[wrap(cy + dy, N) * N + wrap(cx + dx, N)] += h * (1 - d2);
  }
}

export function makeSurfaces(aniso = 4) {
  const S = {};

  // ---- rectangular terracotta running-bond pavers (16x32 per 3.2m tile = 20x10cm bricks, narrow dark joints) ----
  {
    const N = 1024, r = rng(101);
    const cols = 16, rows = 32, bw = N / cols, bh = N / rows; // 64px x 32px per brick
    const low = fbm(N, [3, 6, 12], r), med = fbm(N, [24, 48], r), fine = fbm(N, [96, 192], r);
    const tone = new Float32Array(cols * rows), warm = new Float32Array(cols * rows), tilt = new Float32Array(cols * rows * 2);
    for (let i = 0; i < tone.length; i++) { tone[i] = r(); warm[i] = r() - 0.5; }
    for (let i = 0; i < tilt.length; i++) tilt[i] = (r() - 0.5);
    const H = new Float32Array(N * N), id = new Int32Array(N * N), joint = new Float32Array(N * N), edgeDark = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      const row = Math.floor(y / bh), off = (row % 2) * (bw / 2);
      for (let x = 0; x < N; x++) {
        const xx = wrap(x - off, N), col = Math.floor(xx / bw);
        const lx = xx - col * bw, ly = y - row * bh;
        const e = Math.min(lx, bw - lx, ly, bh - ly);
        // narrow 1.3px recessed joint + 1.8px micro-chamfer (no oversized pillow bevel)
        const bev = Math.min(1, Math.max(0, (e - 0.85) / 1.7));
        const rim = Math.min(1, Math.max(0, (e - 0.85) / 4.2));
        const k = row * cols + col;
        const surf = 0.03 * (med(x, y) - 0.5) + 0.025 * (fine(x, y) - 0.5);
        H[y * N + x] = bev * (0.85 + 0.035 * tilt[k * 2] * (lx / bw - 0.5) + 0.035 * tilt[k * 2 + 1] * (ly / bh - 0.5) + surf);
        id[y * N + x] = k;
        joint[y * N + x] = 1 - bev;
        edgeDark[y * N + x] = (1 - rim) * bev;
      }
    }
    S.paving = texFrom(pack(N, (x, y, i) => {
      const k = id[i], t = tone[k], w = warm[k], j = joint[i], ed = edgeDark[i];
      const lo = low(x, y), m = med(x, y), f = fine(x, y);
      // restrained Kerala terracotta / burnt clay palette with subtle per-tile variation
      let R = 0.57 + 0.065 * t + 0.02 * w;
      let G = 0.34 + 0.038 * t - 0.008 * w;
      let B = 0.26 + 0.030 * t - 0.012 * w;
      const mod = 0.94 + 0.09 * lo + 0.04 * (m - 0.5) + 0.025 * (f - 0.5) - 0.055 * ed;
      R *= mod; G *= mod; B *= mod;
      // narrow recessed joint: darkened weathered sand-mortar
      R = R * (1 - j) + 0.27 * j;
      G = G * (1 - j) + 0.21 * j;
      B = B * (1 - j) + 0.18 * j;
      return [R, G, B];
    }), N, true, aniso);
    S.pavingN = texFrom(normalFrom(H, N, 2.1), N, false, aniso);
  }

  // ---- asphalt: believable dark grey road surface, fine mineral aggregate, restrained weathering ----
  {
    const N = 1024, r = rng(102);
    const H = new Float32Array(N * N), A = new Float32Array(N * N);
    const patch = fbm(N, [2, 4, 8], r), med = fbm(N, [16, 32, 64], r), agg = fbm(N, [128, 256], r);
    // subtle fine aggregate micro-stones
    for (let i = 0; i < 45000; i++) {
      const x = Math.floor(r() * N), y = Math.floor(r() * N), rad = 0.7 + r() * 1.1;
      stamp(H, N, x, y, rad, 0.14 + r() * 0.2);
      stamp(A, N, x, y, rad * 0.85, (r() - 0.48) * 0.18);
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      H[i] = H[i] * 0.55 + 0.28 * agg(x, y) + 0.17 * med(x, y);
    }
    S.asphalt = texFrom(pack(N, (x, y, i) => {
      const p = patch(x, y), m = med(x, y), ag = agg(x, y);
      const l = 0.215 + 0.024 * (p - 0.5) + 0.016 * (m - 0.5) + 0.018 * (ag - 0.5) + 0.016 * A[i];
      return [l * 0.99, l * 1.0, l * 1.03];
    }), N, true, aniso);
    S.asphaltN = texFrom(normalFrom(H, N, 0.95), N, false, aniso);
  }

  // ---- tropical Kerala lawn: rich organic green patches, fine blade micro-clusters, clover/soil undertones ----
  {
    const N = 1024, r = rng(103);
    const patch = fbm(N, [2, 4, 8], r), mid = fbm(N, [14, 28], r), fine = fbm(N, [56, 112], r), soil = fbm(N, [6, 12], r);
    const H = new Float32Array(N * N), Bld = new Float32Array(N * N), Weed = new Float32Array(N * N);
    // soft directional grass blade clusters
    for (let i = 0; i < 55000; i++) {
      let x = r() * N, y = r() * N;
      const a = r() * Math.PI * 2, len = 4 + r() * 6, v = (r() - 0.45) * 0.14;
      for (let s = 0; s < len; s++) {
        const xi = wrap(Math.floor(x), N), yi = wrap(Math.floor(y), N);
        Bld[yi * N + xi] += v;
        H[yi * N + xi] += 0.16 * (1 - s / len);
        x += Math.cos(a) * 0.9; y += Math.sin(a) * 0.9;
      }
    }
    // sparse low clover / broadleaf groundcover rosettes
    for (let i = 0; i < 1400; i++) {
      const cx = Math.floor(r() * N), cy = Math.floor(r() * N), tone = 0.04 + r() * 0.05;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + r() * 0.5;
        stamp(Weed, N, Math.round(cx + Math.cos(a) * 3), Math.round(cy + Math.sin(a) * 3), 2.6, tone);
        stamp(H, N, Math.round(cx + Math.cos(a) * 3), Math.round(cy + Math.sin(a) * 3), 2.6, 0.22);
      }
    }
    // 3x3 box filter on H and Bld so blades read as soft turf without 1px grain
    const Hs = new Float32Array(N * N), Bs = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let sh = 0, sb = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const idx = wrap(y + dy, N) * N + wrap(x + dx, N);
        sh += H[idx]; sb += Bld[idx];
      }
      const i = y * N + x;
      Hs[i] = sh / 9 + 0.25 * fine(x, y);
      Bs[i] = Math.max(-0.1, Math.min(0.1, sb / 9));
    }
    S.grass = texFrom(pack(N, (x, y, i) => {
      const p = patch(x, y), m = mid(x, y), f = fine(x, y), sl = Math.max(0, soil(x, y) - 0.62) * 1.9;
      const w = Math.min(0.08, Weed[i]);
      let R = 0.20 + 0.05 * p + 0.02 * (m - 0.5) - 0.02 * w;
      let G = 0.34 + 0.065 * p + 0.03 * (m - 0.5) + 0.04 * w;
      let B = 0.12 + 0.025 * p + 0.01 * w;
      const k = 1 + Bs[i] + 0.05 * (f - 0.5);
      R *= k; G *= k; B *= k;
      // warm earthy tropical soil peeking gently in thin spots
      R = R * (1 - sl * 0.35) + 0.30 * (sl * 0.35);
      G = G * (1 - sl * 0.35) + 0.23 * (sl * 0.35);
      B = B * (1 - sl * 0.35) + 0.15 * (sl * 0.35);
      return [R, G, B];
    }), N, true, aniso);
    S.grassN = texFrom(normalFrom(Hs, N, 0.55), N, false, aniso);
  }

  // ---- fitted concrete / granite curb & edge-course blocks (radial joints along u, profile wear along v) ----
  {
    const N = 512, r = rng(107);
    const low = fbm(N, [3, 6], r), med = fbm(N, [16, 32], r), fine = fbm(N, [64, 128], r);
    const H = new Float32Array(N * N), J = new Float32Array(N * N);
    // two fitted curb stone units per UV tile (x = 0 and x = 256 joints)
    const blockW = N / 2;
    const blockTone = [0.0, 0.025];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const lx = x % blockW;
        const distJoint = Math.min(lx, blockW - lx);
        const bev = Math.min(1, Math.max(0, (distJoint - 1.5) / 3.0));
        const i = y * N + x;
        H[i] = bev * (0.85 + 0.1 * med(x, y) + 0.08 * fine(x, y));
        J[i] = 1 - bev;
      }
    }
    S.curb = texFrom(pack(N, (x, y, i) => {
      const blk = Math.floor(x / blockW) % 2;
      const v = y / N; // v across profile: 0 = outer gutter/base, 0.35 = chamfer, 0.9 = inner seam
      const edgeWear = (1 - Math.min(1, v / 0.16)) * 0.12 + Math.max(0, (v - 0.86) / 0.14) * 0.08;
      const chamferHighlight = Math.exp(-Math.pow((v - 0.34) / 0.08, 2)) * 0.035;
      const j = J[i];
      let l = 0.74 + blockTone[blk] + 0.045 * (low(x, y) - 0.5) + 0.03 * (med(x, y) - 0.5) + 0.02 * (fine(x, y) - 0.5) - edgeWear + chamferHighlight;
      l = l * (1 - j) + 0.42 * j;
      return [l, l * 0.97, l * 0.92];
    }), N, true, aniso);
    S.curbN = texFrom(normalFrom(H, N, 1.8), N, false, aniso);
  }

  // ---- sand: wind ripples + grain ----
  {
    const N = 512, r = rng(104);
    const warp = fbm(N, [4, 8], r), low = fbm(N, [3, 6], r), grain = fbm(N, [128, 256], r);
    const H = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const w = warp(x, y);
      H[y * N + x] = 0.5 + 0.35 * Math.sin((y / N) * Math.PI * 2 * 14 + w * 9) + 0.25 * grain(x, y);
    }
    S.sand = texFrom(pack(N, (x, y, i) => {
      const l = 0.86 + 0.06 * (low(x, y) - 0.5) * 2 + 0.05 * (grain(x, y) - 0.5) + 0.025 * (H[i] - 0.5);
      return [0.9 * l, 0.8 * l, 0.6 * l];
    }), N, true, aniso);
    S.sandN = texFrom(normalFrom(H, N, 1.2), N, false, aniso);
  }

  // ---- seawall masonry: irregular coursed granite blocks with recessed joints ----
  {
    const N = 512, r = rng(105);
    const fine = fbm(N, [32, 64, 128], r), low = fbm(N, [4, 8], r);
    const H = new Float32Array(N * N), tone = new Float32Array(N * N);
    const courses = 8, ch = N / courses;
    for (let c = 0; c < courses; c++) {
      let x = r() * 40;
      const cuts = [];
      while (x < N) { cuts.push(x); x += 55 + r() * 70; }
      const tones = cuts.map(() => r());
      for (let y = Math.floor(c * ch); y < Math.floor((c + 1) * ch); y++) {
        const ly = y - c * ch;
        for (let xx = 0; xx < N; xx++) {
          let k = cuts.length - 1;
          for (let q = 0; q < cuts.length; q++) if (cuts[q] > xx) { k = q - 1; break; }
          if (k < 0) k = cuts.length - 1;
          const x0 = cuts[k] ?? 0, x1 = k + 1 < cuts.length ? cuts[k + 1] : cuts[0] + N;
          const lx = xx >= x0 ? xx - x0 : xx + N - x0;
          const e = Math.min(lx, x1 - x0 - lx, ly, ch - ly);
          const bev = Math.min(1, Math.max(0, (e - 2) / 6));
          H[y * N + xx] = bev * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, lx / (x1 - x0))) * Math.sin(Math.PI * ly / ch)) + 0.18 * fine(xx, y);
          tone[y * N + xx] = bev > 0.01 ? tones[k] : -1;
        }
      }
    }
    S.stone = texFrom(pack(N, (x, y, i) => {
      if (tone[i] < 0) return [0.36, 0.34, 0.31];
      const l = (0.5 + 0.12 * tone[i]) * (0.92 + 0.12 * low(x, y)) * (0.92 + 0.16 * fine(x, y));
      return [l, l * 0.97, l * 0.92];
    }), N, true, aniso);
    S.stoneN = texFrom(normalFrom(H, N, 2.6), N, false, aniso);
  }

  // ---- concrete (slabs, stairs): smooth, mottled, tiny pores ----
  {
    const N = 512, r = rng(106);
    const low = fbm(N, [4, 8, 16], r), fine = fbm(N, [128, 256], r);
    const H = new Float32Array(N * N);
    for (let i = 0; i < 2500; i++) stamp(H, N, Math.floor(r() * N), Math.floor(r() * N), 0.8 + r(), -0.5);
    S.concrete = texFrom(pack(N, (x, y, i) => {
      const l = 0.78 + 0.05 * (low(x, y) - 0.5) * 2 + 0.03 * (fine(x, y) - 0.5) + 0.06 * H[i];
      return [l, l * 0.98, l * 0.93];
    }), N, true, aniso);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) H[y * N + x] += 0.15 * fine(x, y);
    S.concreteN = texFrom(normalFrom(H, N, 1.0), N, false, aniso);
  }
  return S;
}

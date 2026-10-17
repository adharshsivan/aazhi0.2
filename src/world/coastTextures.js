import * as THREE from 'three';
import { rng } from '../geom.js';

// Procedural, tileable coastal textures generated once at load (no binary assets):
//  sandA     – sRGB grain detail around a neutral mid value (zone colours come from the shader)
//  sandN     – world-space slope map (RG = -dh/dx, -dh/dz, B = height) of sand ripples + grains
//  waterN    – wind-ripple slope map from a periodic directional wave spectrum
//  coastTex  – R: lacy foam, G: caustic network
//  noiseTex  – four independent tileable fbm channels for macro variation

function periodicNoise(N, P, r) {
  const g = new Float32Array(P * P);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = ((x / N) * P), fy = ((y / N) * P);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
    const xa = ((x0 % P) + P) % P, xb = (xa + 1) % P, ya = ((y0 % P) + P) % P, yb = (ya + 1) % P;
    const a = g[ya * P + xa], b = g[ya * P + xb], c = g[yb * P + xa], d = g[yb * P + xb];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };
}
function pfbm(N, periods, r) {
  const fns = periods.map((P) => periodicNoise(N, P, r));
  return (x, y) => { let v = 0, a = 0.5, t = 0; for (const f of fns) { v += f(x, y) * a; t += a; a *= 0.55; } return v / t; };
}
const wrap = (i, N) => ((i % N) + N) % N;

/** Tileable Voronoi: returns (x,y) -> [F1, F2] in units of cell size. */
function voronoi(N, cells, r) {
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < pts.length; i++) pts[i] = 0.12 + r() * 0.76;
  return (x, y) => {
    const fx = (x / N) * cells, fy = (y / N) * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let f1 = 9, f2 = 9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const k = (wrap(cy, cells) * cells + wrap(cx, cells)) * 2;
      const px = cx + pts[k], py = cy + pts[k + 1];
      const d = Math.hypot(px - fx, py - fy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
}

function dataTex(data, N, { srgb = false, mips = true, aniso = 4, M = N } = {}) {
  const t = new THREE.DataTexture(data, N, M, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips; t.anisotropy = aniso; t.flipY = false; t.needsUpdate = true;
  return t;
}
const u8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

export function makeCoastTextures(aniso = 4) {
  const T = {};

  // ---- sand albedo detail: quartz, dark mineral grains, shell grit, laterite grains
  {
    const N = 512, r = rng(4401);
    const low = pfbm(N, [4, 8], r), mid = pfbm(N, [24, 48], r), fine = pfbm(N, [128, 256], r);
    const L = new Float32Array(N * N), cr = new Float32Array(N * N), cb = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      L[i] = 0.735 + 0.035 * (low(x, y) - 0.5) * 2 + 0.03 * (mid(x, y) - 0.5) * 2 + 0.04 * (fine(x, y) - 0.5) * 2;
    }
    const speck = (n, rad0, rad1, dl, dr, db) => {
      for (let s = 0; s < n; s++) {
        const cx = Math.floor(r() * N), cy = Math.floor(r() * N), rad = rad0 + r() * (rad1 - rad0);
        const R = Math.ceil(rad), k = 0.6 + r() * 0.4;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const q = (dx * dx + dy * dy) / (rad * rad); if (q > 1) continue;
          const i = wrap(cy + dy, N) * N + wrap(cx + dx, N), f = (1 - q) * k;
          L[i] += dl * f; cr[i] += dr * f; cb[i] += db * f;
        }
      }
    };
    speck(26000, 0.6, 1.3, 0.11, 0.0, 0.0);      // clear quartz glints
    speck(9000, 0.6, 1.2, -0.3, 0.0, 0.02);      // ilmenite / monazite (dark mineral sand)
    speck(2600, 0.8, 1.6, 0.08, 0.05, -0.03);    // laterite / feldspar grains (warm)
    speck(700, 1.2, 2.8, 0.16, 0.025, 0.02);     // shell grit (pale pink-white)
    const d = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      const l = L[i];
      d[i * 4] = u8(l + cr[i]); d[i * 4 + 1] = u8(l - cr[i] * 0.3); d[i * 4 + 2] = u8(l - cr[i] * 0.6 + cb[i]); d[i * 4 + 3] = 255;
    }
    T.sandA = dataTex(d, N, { srgb: true, aniso });
  }

  // ---- sand relief: asymmetric ripples (crests along texture x) + grains + pits
  {
    const N = 512, r = rng(4402);
    const warp = pfbm(N, [3, 6], r), warp2 = pfbm(N, [8, 16], r), grain = pfbm(N, [128, 256], r), amp = pfbm(N, [4, 8], r);
    const H = new Float32Array(N * N);
    const ripples = 22;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let ph = (y / N) * ripples + 1.6 * (warp(x, y) - 0.5) + 0.6 * (warp2(x, y) - 0.5);
      ph -= Math.floor(ph);
      // gentle stoss slope, steeper lee face, rounded crest
      const prof = ph < 0.72 ? Math.sin((ph / 0.72) * Math.PI / 2) : Math.cos(((ph - 0.72) / 0.28) * Math.PI / 2);
      const a = 0.55 + 0.6 * amp(x, y);
      H[y * N + x] = prof * a * 0.6 + 0.22 * grain(x, y);
    }
    for (let s = 0; s < 4000; s++) {
      const cx = Math.floor(r() * N), cy = Math.floor(r() * N), rad = 0.8 + r() * 1.4, h = (r() - 0.35) * 0.18;
      const R = Math.ceil(rad);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const q = (dx * dx + dy * dy) / (rad * rad); if (q > 1) continue;
        H[wrap(cy + dy, N) * N + wrap(cx + dx, N)] += h * (1 - q);
      }
    }
    const d = new Uint8Array(N * N * 4);
    const k = 3.2;   // slope gain (texture covers ~3 m: heights are in arbitrary units)
    let hMin = Infinity, hMax = -Infinity;
    for (const v of H) { hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const sx = -(H[y * N + wrap(x + 1, N)] - H[y * N + wrap(x - 1, N)]) * k;
      const sz = -(H[wrap(y + 1, N) * N + x] - H[wrap(y - 1, N) * N + x]) * k;
      d[i * 4] = u8(0.5 + 0.5 * Math.max(-1, Math.min(1, sx)));
      d[i * 4 + 1] = u8(0.5 + 0.5 * Math.max(-1, Math.min(1, sz)));
      d[i * 4 + 2] = u8((H[i] - hMin) / (hMax - hMin));
      d[i * 4 + 3] = 255;
    }
    T.sandN = dataTex(d, N, { aniso });
  }

  // ---- water ripples: periodic directional spectrum (wind along +x of the tile)
  {
    const N = 256, r = rng(4403);
    const waves = [];
    for (let n = 0; n < 56; n++) {
      const kmag = 2 + Math.floor(r() * r() * 22);
      const ang = (r() - 0.5) * 2 * (n % 5 === 0 ? 1.6 : 0.75);    // directional spread around the wind
      const kx = Math.round(Math.cos(ang) * kmag), ky = Math.round(Math.sin(ang) * kmag);
      if (kx === 0 && ky === 0) continue;
      const km = Math.hypot(kx, ky);
      waves.push({ kx, ky, a: Math.pow(km, -1.55) * (0.6 + r() * 0.8), ph: r() * Math.PI * 2 });
    }
    const sx = new Float32Array(N * N), sy = new Float32Array(N * N), hh = new Float32Array(N * N);
    let m = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let h = 0, dx = 0, dy = 0;
      for (const w of waves) {
        const th = ((w.kx * x + w.ky * y) / N) * Math.PI * 2 + w.ph;
        h += w.a * Math.sin(th);
        const c = w.a * Math.cos(th) * Math.PI * 2;
        dx += c * w.kx; dy += c * w.ky;
      }
      const i = y * N + x;
      sx[i] = -dx; sy[i] = -dy; hh[i] = h;
      m = Math.max(m, Math.abs(dx), Math.abs(dy));
    }
    const d = new Uint8Array(N * N * 4);
    let hMin = Infinity, hMax = -Infinity;
    for (const v of hh) { hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); }
    for (let i = 0; i < N * N; i++) {
      d[i * 4] = u8(0.5 + 0.5 * sx[i] / m); d[i * 4 + 1] = u8(0.5 + 0.5 * sy[i] / m);
      d[i * 4 + 2] = u8((hh[i] - hMin) / (hMax - hMin)); d[i * 4 + 3] = 255;
    }
    T.waterN = dataTex(d, N, { aniso });
    T.waterNScale = m / N;   // slope units per (1/tile) — informational
  }

  // ---- foam lace (R) + caustic network (G)
  {
    const N = 256, r = rng(4404);
    const v1 = voronoi(N, 9, r), v2 = voronoi(N, 21, r), vc = voronoi(N, 7, r), vc2 = voronoi(N, 13, r);
    const blot = pfbm(N, [4, 8, 16], r), fineN = pfbm(N, [32, 64], r);
    const d = new Uint8Array(N * N * 4);
    const foam = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const [a1, b1] = v1(x, y), [a2, b2] = v2(x, y);
      const s1 = 1 - Math.min(1, (b1 - a1) / 0.3), s2 = 1 - Math.min(1, (b2 - a2) / 0.34);
      // foam: bubbly strands at cell borders, larger clumps where blotch noise is high
      foam[i] = (0.55 * s1 + 0.35 * s2 * s2 + 0.6 * blot(x, y)) * (0.8 + 0.4 * fineN(x, y));
      const [c1, e1] = vc(x, y), [c2, e2] = vc2(x, y);
      const ca = Math.pow(1 - Math.min(1, (e1 - c1) / 0.16), 2.6), cb = Math.pow(1 - Math.min(1, (e2 - c2) / 0.2), 2.2);
      d[i * 4 + 1] = u8(Math.min(1, ca * 0.75 + cb * 0.45)); d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
    }
    // histogram-equalise the foam so a threshold of (1 - amount) covers exactly `amount` of the area
    const order = Array.from(foam.keys()).sort((p, q) => foam[p] - foam[q]);
    order.forEach((idx, rank) => { d[idx * 4] = u8(rank / (order.length - 1)); });
    T.coastTex = dataTex(d, N, { aniso });
  }

  // ---- macro noise: 4 independent fbm channels
  {
    const N = 256, r = rng(4405);
    const ch = [pfbm(N, [4, 8, 16], r), pfbm(N, [3, 6, 12], r), pfbm(N, [6, 12, 24], r), pfbm(N, [5, 10, 20, 40], r)];
    const d = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      for (let c = 0; c < 4; c++) d[i + c] = u8(0.5 + (ch[c](x, y) - 0.5) * 1.9);
    }
    T.noiseTex = dataTex(d, N, { aniso });
  }
  return T;
}

/**
 * Beach detail map over `rect` = [x0, z0, x1, z1] (world): R = footprint relief
 * (0.5 neutral), G = contact occlusion (1 = open). Built after rocks are placed.
 */
export function makeBeachDetail({ rect, height, rocks, trees, keepOut, W = 2048, Hh = 1024 }) {
  const [x0, z0, x1, z1] = rect;
  const sx = (x1 - x0) / W, sz = (z1 - z0) / Hh;
  const rel = new Float32Array(W * Hh), ao = new Float32Array(W * Hh).fill(1);
  const r = rng(4410);
  const toTex = (x, z) => [(x - x0) / sx, (z - z0) / sz];

  // ---- footprints: heel + ball + toes, soft in dry sand, crisp in damp sand, raised rim
  const stamp = (x, z, ang, left, soft, depth) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const parts = [[-0.075, 0, 0.042, 0.034, 1], [0.04, left ? -0.008 : 0.008, 0.05, 0.04, 0.95], [0.098, left ? -0.012 : 0.012, 0.026, 0.038, 0.6]];
    const ext = 0.17;
    const [cx, cz] = toTex(x, z);
    const rx = Math.ceil(ext / sx), rz = Math.ceil(ext / sz);
    for (let j = Math.floor(cz - rz); j <= cz + rz; j++) {
      if (j < 0 || j >= Hh) continue;
      for (let i = Math.floor(cx - rx); i <= cx + rx; i++) {
        if (i < 0 || i >= W) continue;
        const wx = x0 + (i + 0.5) * sx - x, wz = z0 + (j + 0.5) * sz - z;
        const u = wx * c + wz * s, v = -wx * s + wz * c;     // u along the foot
        let q = 9;
        for (const [pu, pv, ru, rv] of parts) q = Math.min(q, ((u - pu) / ru) ** 2 + ((v - pv) / rv) ** 2);
        const e = Math.sqrt(q);
        const edge = soft ? 0.55 : 0.22;
        const dep = 1 - Math.min(1, Math.max(0, (e - (1 - edge)) / edge));
        const rim = Math.exp(-(((e - 1.15) / (soft ? 0.35 : 0.2)) ** 2)) * (soft ? 0.45 : 0.3);
        const k = j * W + i;
        rel[k] = Math.min(rel[k], -dep * depth) + (dep < 0.02 ? rim * depth : 0);
      }
    }
  };
  const blocked = (x, z) => keepOut.some(([kx, kz, kr]) => Math.hypot(kx - x, kz - z) < kr);
  const trail = (pts, { stride = 0.7, gait = 0.095, age = 1 } = {}) => {
    let left = r() < 0.5;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.floor(len / stride));
      const hd = Math.atan2(bz - az, bx - ax);
      for (let s = 0; s < n; s++) {
        const t = (s + r() * 0.15) / n;
        const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
        const side = left ? -1 : 1;
        const x = px - Math.sin(hd) * gait * side, z = pz + Math.cos(hd) * gait * side;
        left = !left;
        const h = height(x, z);
        if (h < 0.1 || blocked(x, z)) continue;           // swash has erased them / obstacle
        const dry = h > 0.36;
        stamp(x, z, hd + (r() - 0.5) * 0.22 + side * 0.08, side < 0, dry, (dry ? 0.75 : 1) * age * (0.75 + r() * 0.3));
      }
    }
  };
  const wander = (a, b, amp, seg = 1.6) => {
    const out = [a];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.round(len / seg));
    const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
    const ph = r() * 6.28;
    for (let i = 1; i < n; i++) {
      const t = i / n, off = Math.sin(t * 5.1 + ph) * amp * 0.6 + (r() - 0.5) * amp * 0.5;
      out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + nz * off]);
    }
    out.push(b);
    return out;
  };
  // stair foot -> down to the water, a stroll along the damp sand, umbrella -> sea, an older crossing trail
  trail(wander([-10.2, 45.6], [-6.5, 53.5], 1.2));
  trail(wander([-6.4, 53.2], [4.5, 50.2], 0.8), { stride: 0.74 });
  trail(wander([-29.5, 46.4], [-7.5, 54.6], 1.0), { stride: 0.68 });
  trail(wander([-13.2, 50.4], [-15.2, 55.8], 0.5), { stride: 0.62 });
  trail(wander([-9.6, 45.4], [-21.4, 49.8], 0.9), { stride: 0.72, age: 0.55 });
  trail(wander([-3.6, 48.6], [-0.4, 54.2], 0.6), { stride: 0.6, gait: 0.08, age: 0.8 });
  // sandpiper / crow tracks close to the waterline
  for (let b = 0; b < 3; b++) {
    let x = -24 + b * 10 + r() * 4, z = 50, hd = r() * 6.28;
    for (let s = 0; s < 40; s++) {
      hd += (r() - 0.5) * 0.9;
      x += Math.cos(hd) * 0.09; z += Math.sin(hd) * 0.09;
      // keep near the damp band
      const h = height(x, z);
      if (h > 0.32) z += 0.12; else if (h < 0.12) z -= 0.12;
      if (h < 0.1 || h > 0.4) continue;
      const [cx, cz] = toTex(x, z);
      for (const da of [-0.5, 0, 0.5]) {
        for (let q = 0; q < 4; q++) {
          const i = Math.round(cx + Math.cos(hd + da) * q * 0.6), j = Math.round(cz + Math.sin(hd + da) * q * 0.6);
          if (i >= 0 && j >= 0 && i < W && j < Hh) rel[j * W + i] = Math.min(rel[j * W + i], -0.55);
        }
      }
    }
  }

  // ---- contact occlusion around rocks bedded in sand and around beach tree trunks
  const occl = (x, z, R, k) => {
    const [cx, cz] = toTex(x, z);
    const ext = R + 1.4;
    const rx = Math.ceil(ext / sx), rz = Math.ceil(ext / sz);
    if (cx + rx < 0 || cz + rz < 0 || cx - rx >= W || cz - rz >= Hh) return;
    for (let j = Math.max(0, Math.floor(cz - rz)); j <= Math.min(Hh - 1, cz + rz); j++) {
      for (let i = Math.max(0, Math.floor(cx - rx)); i <= Math.min(W - 1, cx + rx); i++) {
        const wx = x0 + (i + 0.5) * sx - x, wz = z0 + (j + 0.5) * sz - z;
        const d = Math.hypot(wx, wz) - R;
        const o = d < 0 ? k : k * Math.exp(-((d / (0.25 + R * 0.22)) ** 2));
        const kk = j * W + i;
        ao[kk] = Math.min(ao[kk], 1 - o);
      }
    }
  };
  for (const q of rocks) {
    const g = height(q.x, q.z);
    if (q.top < g + 0.05 || g < -0.4) continue;
    occl(q.x, q.z, q.Rg, 0.45);
  }
  for (const t of trees) occl(t.x, t.z, 0.22, 0.35);

  const d = new Uint8Array(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) {
    d[i * 4] = u8(0.5 + 0.5 * Math.max(-1, Math.min(1, rel[i])));
    d[i * 4 + 1] = u8(ao[i]); d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, W, Hh, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.flipY = false; t.needsUpdate = true;
  return t;
}

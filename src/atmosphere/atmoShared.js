import * as THREE from 'three';
import { makeRng } from './weather.js';

// ---------------------------------------------------------------------------
// Uniforms + GLSL shared by the sky dome, every lit surface (cloud shadows,
// height mist, wetness, lamp light) and the precipitation. The same cloud
// field is evaluated in the sky and projected along the light onto the ground,
// so shadows always belong to the clouds you can see.
// ---------------------------------------------------------------------------

export const atmoUniforms = {
  uAtmoTime: { value: 0 },
  uCloudTex: { value: null },
  uCloudOffset: { value: new THREE.Vector2() },
  uScudOffset: { value: new THREE.Vector2() },
  uCloudCover: { value: 0.3 },
  uCloudSoft: { value: 0.2 },
  uCloudAlt: { value: 520 },
  uCloudShadowK: { value: 0.75 },
  uLightDirW: { value: new THREE.Vector3(0, 1, 0) },
  // height mist
  uMistDensity: { value: 0 },
  uMistHeight: { value: 7 },
  uMistColor: { value: new THREE.Color() },
  // surface weather
  uWet: { value: 0 },
  uPuddle: { value: 0 },
  uRainNow: { value: 0 },
  uPuddleNoise: { value: null },
  uSkyZenW: { value: new THREE.Color() },
  uSkyHorW: { value: new THREE.Color() },
  // night lamps
  uLampMap: { value: null },
  uLampRect: { value: new THREE.Vector4(-70, -70, 70, 70) },
  uLampLevel: { value: 0 },
  uLampColor: { value: new THREE.Color('#ffc27a') },
};

export const CLOUD_GLSL = /* glsl */`
uniform sampler2D uCloudTex;
uniform vec2 uCloudOffset;
uniform vec2 uScudOffset;
uniform float uCloudCover;
uniform float uCloudSoft;
uniform float uCloudAlt;
uniform float uCloudShadowK;
uniform vec3 uLightDirW;
// Cloud density at a point of the cloud deck (world xz, metres). Returns density in .x
// and the raw billow value in .y (used to texture solid overcast).
vec2 cloudField(vec2 p) {
  vec2 q = (p + uCloudOffset) / 2600.0;
  float a = texture2D(uCloudTex, q).r;
  float b = texture2D(uCloudTex, q * 3.3 + vec2(0.37, 0.11)).g;
  float big = texture2D(uCloudTex, q * 0.23 + 0.5).a;
  // billows carry the shape, detail erodes the edges; large-scale field groups clouds into fields and gaps
  float n = a * 0.8 + b * 0.2 + (big - 0.5) * 0.22;
  float th = mix(0.97, -0.4, uCloudCover);      // full cover closes every gap
  return vec2(smoothstep(th, th + uCloudSoft, n), n);
}
float cloudShadowAt(vec3 wp) {
  vec3 L = uLightDirW;
  float ly = max(L.y, 0.08);
  vec2 p = wp.xz + L.xz / ly * (uCloudAlt - wp.y);
  return 1.0 - cloudField(p).x * uCloudShadowK;
}
`;

// ---- tileable cloud noise -------------------------------------------------------
function periodic(N, Px, Py, r) {
  const g = new Float32Array(Px * Py);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / N) * Px, fy = (y / N) * Py;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = sm(fx - x0), ty = sm(fy - y0);
    const xa = ((x0 % Px) + Px) % Px, xb = (xa + 1) % Px, ya = ((y0 % Py) + Py) % Py, yb = (ya + 1) % Py;
    const a = g[ya * Px + xa], b = g[ya * Px + xb], c = g[yb * Px + xa], d = g[yb * Px + xb];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  };
}
function fbm(N, periods, r, aniso = 1, gain = 0.5) {
  const f = periods.map((P) => periodic(N, P, Math.max(1, Math.round(P * aniso)), r));
  return (x, y) => { let v = 0, a = 1, t = 0; for (const fn of f) { v += fn(x, y) * a; t += a; a *= gain; } return v / t; };
}
function worley(N, cells, r) {
  const pts = new Float32Array(cells * cells * 2);
  for (let i = 0; i < pts.length; i++) pts[i] = r();
  const w = (i) => ((i % cells) + cells) % cells;
  return (x, y) => {
    const fx = (x / N) * cells, fy = (y / N) * cells, ix = Math.floor(fx), iy = Math.floor(fy);
    let d = 9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (w(iy + dy) * cells + w(ix + dx)) * 2;
      d = Math.min(d, Math.hypot(ix + dx + pts[k] - fx, iy + dy + pts[k + 1] - fy));
    }
    return Math.min(1, d);
  };
}
/** Histogram-equalise to a uniform distribution so coverage thresholds read as area fractions. */
function equalise(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const B = 2048, hist = new Float32Array(B + 1);
  for (const v of arr) hist[Math.floor(((v - lo) / (hi - lo)) * B)]++;
  for (let i = 1; i <= B; i++) hist[i] += hist[i - 1];
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = hist[Math.floor(((arr[i] - lo) / (hi - lo)) * B)] / arr.length;
  return out;
}

export function makeCloudTexture(N = 512) {
  const r = makeRng(9127);
  const base = fbm(N, [4, 8, 16, 32], r, 1, 0.55), wA = worley(N, 5, r), wB = worley(N, 11, r);
  const det = fbm(N, [16, 32, 64], r, 1, 0.6), wC = worley(N, 23, r);
  const cir = fbm(N, [3, 6, 12, 24], r, 9, 0.6), warp = fbm(N, [4, 8], r);
  const big = fbm(N, [2, 4], r, 1, 0.6);
  const R = new Float32Array(N * N), G = new Float32Array(N * N), B = new Float32Array(N * N), A = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    // cumulus: perlin-worley billows (rounded puffs with soft fbm edges)
    R[i] = base(x, y) * 0.5 + (1 - wA(x, y)) * 0.32 + (1 - wB(x, y)) * 0.18;
    G[i] = det(x, y) * 0.6 + (1 - wC(x, y)) * 0.4;
    // cirrus: long wind-combed streaks, gently warped
    const wy = y + (warp(x, y) - 0.5) * N * 0.08;
    B[i] = cir(x, wy);
    A[i] = big(x, y);
  }
  const ch = [equalise(R), equalise(G), equalise(B), equalise(A)];
  const d = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 4; c++) d[i * 4 + c] = Math.round(ch[c][i] * 255);
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

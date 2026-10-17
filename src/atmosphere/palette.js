import * as THREE from 'three';

// Time-of-day palette keyed by solar elevation (degrees). The 31° key is the
// island's original late-afternoon look, so the default time reproduces it.
// Sunrise and sunset share elevations but differ in hue: mornings are cooler,
// golden and slightly pink; evenings run deeper orange-red into a violet blue hour.
// zen/hor: sky zenith & horizon; glow: horizon colour towards the sun;
// sun: direct light colour (lux-ish intensity sunI); hemiSky/hemiGnd/hemiI: ambient;
// fog: aerial-perspective colour; cloudLit/cloudAmb: cloud light & shade.

const K = (e, o, evening = null) => ({ e, ...o, evening });
const KEYS = [
  // stylised moonlit night: deep sky, but a cool readable ambient so the island never goes black
  K(-90, { zen: '#02050d', hor: '#08111f', glow: '#08111f', sun: '#000000', sunI: 0, hemiSky: '#5a76b0', hemiGnd: '#1b1f2b', hemiI: 0.5, fog: '#0b1426', cloudLit: '#1a2236', cloudAmb: '#0c1424' }),
  K(-16, { zen: '#030713', hor: '#0c172d', glow: '#111d38', sun: '#000000', sunI: 0, hemiSky: '#5c78b2', hemiGnd: '#1c202c', hemiI: 0.52, fog: '#0d172a', cloudLit: '#1b2338', cloudAmb: '#0d1426' }),
  K(-9, { zen: '#0b1736', hor: '#253a63', glow: '#3e4572', sun: '#000000', sunI: 0, hemiSky: '#6a80b8', hemiGnd: '#1e2130', hemiI: 0.6, fog: '#24345a', cloudLit: '#3a4370', cloudAmb: '#1a2442' }),
  K(-4.5, { zen: '#1b3168', hor: '#64709f', glow: '#c27f78', sun: '#000000', sunI: 0, hemiSky: '#7a88b6', hemiGnd: '#2a2730', hemiI: 0.7, fog: '#5b6890', cloudLit: '#b07a86', cloudAmb: '#3f4a75' },
    { glow: '#c96a5a', hor: '#6e6c98', cloudLit: '#c26a6a' }),
  K(-0.8, { zen: '#3a5c99', hor: '#e2ac8a', glow: '#ff9c66', sun: '#ff9858', sunI: 0.35, hemiSky: '#9aa7c8', hemiGnd: '#5c4838', hemiI: 0.78, fog: '#d9ad92', cloudLit: '#ffae7c', cloudAmb: '#7883a8' },
    { hor: '#eea070', glow: '#ff7d3e', sun: '#ff7f3a', fog: '#e1a081', cloudLit: '#ff8f5a', cloudAmb: '#7d6f95' }),
  K(4, { zen: '#4776b8', hor: '#f1c497', glow: '#ffbb7c', sun: '#ffb877', sunI: 1.6, hemiSky: '#b8c6df', hemiGnd: '#6c5640', hemiI: 0.95, fog: '#efcaa5', cloudLit: '#ffd3a6', cloudAmb: '#98a6c4' },
    { hor: '#f5b783', glow: '#ffa55e', sun: '#ffa865', fog: '#f0be95', cloudLit: '#ffbf8a' }),
  K(14, { zen: '#4a85c8', hor: '#f1d3ab', glow: '#ffd59e', sun: '#ffcf98', sunI: 2.55, hemiSky: '#c8d9ef', hemiGnd: '#7e6a50', hemiI: 1.08, fog: '#f0d4b0', cloudLit: '#fff0dc', cloudAmb: '#a9b8d2' }),
  K(31, { zen: '#4f8fcf', hor: '#f1d9b8', glow: '#f7e2c4', sun: '#ffd6a4', sunI: 3.1, hemiSky: '#cfe4ff', hemiGnd: '#8a7656', hemiI: 1.15, fog: '#f1d9b8', cloudLit: '#fff7ec', cloudAmb: '#b6c6dc' }),
  K(55, { zen: '#3d85d3', hor: '#d3e2ee', glow: '#e9eff4', sun: '#fff0db', sunI: 3.3, hemiSky: '#d4e6ff', hemiGnd: '#8a7a60', hemiI: 1.2, fog: '#d9e4ec', cloudLit: '#ffffff', cloudAmb: '#bccbe0' }),
  K(90, { zen: '#3a82d2', hor: '#cfdfec', glow: '#e6eef4', sun: '#fff3e2', sunI: 3.35, hemiSky: '#d6e8ff', hemiGnd: '#8a7a60', hemiI: 1.22, fog: '#d6e2ea', cloudLit: '#ffffff', cloudAmb: '#bfcde2' }),
];
const COLOR_KEYS = ['zen', 'hor', 'glow', 'sun', 'hemiSky', 'hemiGnd', 'fog', 'cloudLit', 'cloudAmb'];
// pre-convert to linear THREE.Colors (morning & evening variants)
const prep = (o) => Object.fromEntries(COLOR_KEYS.map((k) => [k, new THREE.Color(o[k])]));
const MORNING = KEYS.map((k) => ({ e: k.e, sunI: k.sunI, hemiI: k.hemiI, c: prep(k) }));
const EVENING = KEYS.map((k) => ({ e: k.e, sunI: k.sunI, hemiI: k.hemiI, c: prep({ ...k, ...(k.evening || {}) }) }));

export function makePalette() {
  const out = { sunI: 0, hemiI: 0 };
  for (const k of COLOR_KEYS) out[k] = new THREE.Color();
  return out;
}

const tmpA = new THREE.Color(), tmpB = new THREE.Color();
/** Fill `out` for solar elevation `elevDeg`; `evening` 0..1 blends towards the sunset variant. */
export function samplePalette(out, elevDeg, evening) {
  const e = Math.max(-90, Math.min(90, elevDeg));
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].e < e) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  let t = (e - a.e) / (b.e - a.e);
  t = t * t * (3 - 2 * t);
  out.sunI = a.sunI + (b.sunI - a.sunI) * t;
  out.hemiI = a.hemiI + (b.hemiI - a.hemiI) * t;
  for (const k of COLOR_KEYS) {
    tmpA.copy(MORNING[i].c[k]).lerp(EVENING[i].c[k], evening);
    tmpB.copy(MORNING[i + 1].c[k]).lerp(EVENING[i + 1].c[k], evening);
    out[k].copy(tmpA).lerp(tmpB, t);
  }
  return out;
}

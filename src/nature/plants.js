import * as THREE from 'three';
import { GeoBuilder } from './builder.js';
import { rng } from './random.js';
import { uvRect, uvBand, barkStrip, PLAIN_UV, frondProfile } from './atlas.js';

// Procedural plant generators. Every generator draws ALL random parameters from
// its seed first (independent of LOD) and then builds the requested LOD, so a
// LOD swap changes density, never silhouette.
//   lod 0: near (geometric leaflets, twigs, cupped clusters)
//   lod 1: mid (textured ribbons / fewer, larger clusters)
//   lod 2: far (minimal shells)
// Integrity rules: every leaf cluster hangs from a twig/stem point of the
// skeleton, and every plant's lowest geometry starts at (or slightly below)
// its local ground (y = 0) so nothing floats.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const range = (r, [a, b]) => a + r() * (b - a);
const dirAE = (az, el) => V(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
const sideOf = (az) => V(-Math.sin(az), 0, Math.cos(az));
const plainStrip = { u0: PLAIN_UV[0], u1: PLAIN_UV[0] };
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function randUnit(r) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return V(s * Math.cos(a), z, s * Math.sin(a));
}
function pickWeighted(r, list) {
  const tot = list.reduce((s, [, w]) => s + w, 0);
  let x = r() * tot;
  for (const [n, w] of list) { if ((x -= w) <= 0) return n; }
  return list[list.length - 1][0];
}
/** Perpendicular frame for a direction (side horizontal where possible). */
function frameFor(dir) {
  let side = new THREE.Vector3().crossVectors(dir, UP);
  if (side.lengthSq() < 1e-4) side = V(1, 0, 0); else side.normalize();
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  if (up.y < 0) up.negate();
  return { side, up };
}

/** Gravity-bent midrib sampled into rows (shared by fronds, banana & strap leaves). */
function midrib(o, az, el, L, g, rows, minY = -Infinity) {
  const D = dirAE(az, el), side = sideOf(az);
  const out = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, s = t * L;
    const p = o.clone().addScaledVector(D, s).add(V(0, -g * s * s, 0));
    if (p.y < minY) p.y = minY;
    const T = D.clone().add(V(0, -2 * g * s, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, T).normalize();
    if (up.y < 0) up.negate();
    out.push({ t, p, T, up, side });
  }
  return out;
}
function sampleRib(rib, t) {
  const f = t * (rib.length - 1), i = Math.min(rib.length - 2, Math.floor(f)), k = f - i;
  const a = rib[i], b = rib[i + 1];
  return { p: a.p.clone().lerp(b.p, k), T: a.T.clone().lerp(b.T, k).normalize(), up: a.up.clone().lerp(b.up, k).normalize(), side: a.side };
}

/** Folded ribbon leaf (mid/far fronds, banana, strap leaves). */
function ribbonLeaf(b, rib, rect, wMax, widthFn, o) {
  const widen = o.widen || 1;
  b.ribbon(rib.map((rw) => ({
    p: rw.p, side: rw.side, up: rw.up, t: rw.t,
    w: wMax * widthFn(rw.t) * widen,
    fold: lerp(o.fold[0], o.fold[1], rw.t),
    color: mul(o.color, o.ao ? o.ao(rw.t) : 1),
    wind: o.wind(rw.t), flutter: (o.flutter || 0) * rw.t,
  })), rect, wMax * widen, o.upBias ?? 0.45);
}

// ---------------------------------------------------------------------------
// Palms
// ---------------------------------------------------------------------------
/**
 * Packs structural trunk/branch cantilever sway (`wTrunk` in 0..3.5) and foliar
 * frond/leaf whip (`wLeaf` in 0..0.95) + leaf translucency flag (`isLeaf` via sign)
 * into the single `wind` float attribute.
 */
export function packWind(wTrunk, wLeaf = 0, isLeaf = wLeaf > 0.0005) {
  const t = Math.round(Math.max(0, Math.min(3.5, wTrunk)) * 500);
  const l = Math.max(0, Math.min(0.95, wLeaf));
  const v = t + l;
  return isLeaf ? Math.max(0.001, v) : -v;
}

export const PALMS = {
  coconutTall: { height: [10.2, 13.0], lean: [0.06, 0.16], rBase: 0.21, rTop: 0.145, frondN: 20, frondL: 4.6, wMax: 0.95, elTop: 1.25, elBot: -0.58, g: [0.02, 0.105], dead: 0, nuts: true, leafletLen: 0.95, flex: 0.44 },
  coconutLean: { height: [8.4, 10.6], lean: [0.22, 0.38], rBase: 0.22, rTop: 0.145, frondN: 19, frondL: 4.4, wMax: 0.92, elTop: 1.22, elBot: -0.62, g: [0.02, 0.11], dead: 0, nuts: true, leafletLen: 0.92, flex: 0.42 },
  coconutMid: { height: [6.8, 8.8], lean: [0.08, 0.20], rBase: 0.22, rTop: 0.155, frondN: 20, frondL: 4.2, wMax: 0.9, elTop: 1.2, elBot: -0.52, g: [0.02, 0.1], dead: 0, nuts: true, leafletLen: 0.88, flex: 0.34 },
  coconutYoung: { height: [3.2, 4.6], lean: [0.05, 0.14], rBase: 0.26, rTop: 0.2, frondN: 16, frondL: 3.8, wMax: 0.85, elTop: 1.3, elBot: -0.22, g: [0.01, 0.07], dead: 0, nuts: false, leafletLen: 0.8, flex: 0.18 },
  areca: { height: [8.8, 12.2], lean: [0.02, 0.08], rBase: 0.11, rTop: 0.082, frondN: 11, frondL: 2.4, wMax: 0.55, elTop: 1.2, elBot: -0.1, g: [0.02, 0.06], dead: 0, nuts: 'areca', crownshaft: true, trunkTint: [0.95, 0.95, 0.88], leafletLen: 0.52, flex: 0.48 },
};

const FROND_Q = [{ density: 1, widthK: 1.4, segs: 2, rachis: 4 }, { density: 0.55, widthK: 2.1, segs: 1, rachis: 3 }, { density: 0.3, widthK: 2.9, segs: 1, rachis: 0 }];
const leafletProfile = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + 0.88 * t)), 0.6);

/** Near-LOD frond: real rachis + individually modelled, drooping leaflets + continuous core web. */
function geometricFrond(b, rib, f, P, rr, dry, q = { density: 1, widthK: 1.4, segs: 2, rachis: 4 }, crownFlex = 0.4) {
  const rect = uvRect('leaflet', 3);
  const frondRect = uvRect('frond', 6);
  const L = f.L;
  const trunkAt = (t) => crownFlex + 0.12 * t;
  const leafWhipAt = (t) => 0.03 * t + 0.34 * Math.pow(t, 1.55);
  // rachis (petiole thick at the base, whip-thin at the tip; welded to crownFlex at t = 0)
  const rachisBase = dry
    ? [0.62, 0.50, 0.24]
    : [lerp(0.50, 0.64, f.yellow), lerp(0.60, 0.56, f.yellow), lerp(0.30, 0.24, f.yellow)];
  if (q.rachis) b.tube(rib.map((x) => x.p), rib.map((x) => lerp(0.055, 0.01, Math.pow(x.t, 0.7))), {
    radial: q.rachis, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
    color: (t) => mul(rachisBase, 0.82 + 0.18 * t),
    wind: (t) => packWind(trunkAt(t), leafWhipAt(t), false),
  });
  // Natural frond coloration: fresh emerald on upper fronds, warm olive-gold on older lower fronds, and muted sun-cured bronze-amber on the rare senescent frond
  const base = dry
    ? [f.shade * 1.12, f.shade * 0.86, f.shade * 0.44]
    : [f.shade * lerp(0.90, 1.10, f.yellow), f.shade * lerp(1.0, 0.91, f.yellow * 0.65), f.shade * lerp(0.92, 0.56, f.yellow)];
  // continuous folded frond web along the rachis so crowns stay lush and full at all distances
  ribbonLeaf(b, rib, frondRect, P.wMax * (dry ? 0.48 : 0.62), frondProfile, {
    widen: 1, fold: [0.22, 0.48], color: base, ao: (t) => 0.78 + 0.22 * t,
    wind: (t) => packWind(trunkAt(t), leafWhipAt(t), true), flutter: 0.025, upBias: 0.55,
  });
  const N = Math.round(46 * (L / 4.4));
  const M = Math.max(6, Math.round(N * q.density));
  for (const sgn of [-1, 1]) {
    for (let m = 0; m < M; m++) {
      const i = Math.min(N - 1, Math.round((m + 0.5) * N / M - 0.5));
      const lq = rr[(sgn > 0 ? N : 0) + i];
      if (lq.miss && q.density > 0.5) continue;
      const t = 0.07 + 0.91 * (i + 0.5 + lq.j) / N;
      const s = sampleRib(rib, t);
      const ll = P.leafletLen * (L / P.frondL) * leafletProfile(t) * lq.len;
      if (ll < 0.06) continue;
      const fold = lerp(0.28, 0.72, t) + lq.fold + (dry ? 0.18 : 0);
      const out = s.side.clone().multiplyScalar(sgn * Math.cos(fold)).addScaledVector(s.up, -Math.sin(fold)).normalize();
      const fwd = 0.45 + 0.3 * t;
      const dir = out.clone().multiplyScalar(Math.cos(fwd)).addScaledVector(s.T, Math.sin(fwd)).normalize();
      const droop = ll * (0.08 + 0.28 * t + 0.2 * f.a + lq.droop + (dry ? 0.16 : 0));
      const B = s.p.clone().addScaledVector(out, 0.02);
      const pts = [B, B.clone().addScaledVector(dir, ll * 0.5).add(V(0, -droop * 0.3, 0)), B.clone().addScaledVector(dir, ll).add(V(0, -droop, 0))];
      const hw = (0.028 * (ll / 0.9) + 0.009) * q.widthK;
      const widths = q.segs === 1 ? [hw * 0.9, hw, hw * 0.35] : [hw * 0.78, hw, hw * 0.22];
      const tint = lq.amber
        ? mul([base[0] * 1.14, base[1] * 0.88, base[2] * 0.55], lq.tint)
        : mul(base, lq.tint);
      const tipC = (dry || f.yellow > 0.48)
        ? [tint[0] * 1.12, tint[1] * 0.94, tint[2] * 0.72]
        : mul(tint, 1.06);
      const ids = [];
      for (const k of (q.segs === 1 ? [0, 2] : [0, 1, 2])) {
        const seg = (k < 2 ? pts[k + 1].clone().sub(pts[k]) : pts[2].clone().sub(pts[1])).normalize();
        const leafUp = s.up.clone().addScaledVector(UP, 0.45).normalize();
        const wv = new THREE.Vector3().crossVectors(seg, leafUp).normalize();
        const nrm = new THREE.Vector3().crossVectors(wv, seg).normalize();
        if (nrm.y < 0) nrm.negate();
        nrm.addScaledVector(UP, 0.55).normalize();
        const col = k === 0 ? mul(tint, 0.76) : k === 1 ? tint : tipC;
        const w = packWind(trunkAt(t), leafWhipAt(t) + 0.08 * (k / 2), true);
        const u = rect.u0 + (rect.u1 - rect.u0) * (k / 2);
        ids.push(b.vert(pts[k].clone().addScaledVector(wv, widths[k]), nrm, u, rect.v0, col, w));
        ids.push(b.vert(pts[k].clone().addScaledVector(wv, -widths[k]), nrm, u, rect.v1, col, w));
      }
      for (let k = 0; k + 3 < ids.length; k += 2) b.quad(ids[k], ids[k + 2], ids[k + 3], ids[k + 1]);
    }
  }
}

export function palm(seed, lod, P) {
  const r = rng(seed);
  const H = range(r, P.height), lean = range(r, P.lean), leanAz = r() * Math.PI * 2;
  const curveStyle = seed % 4; // 0: classic S-curve, 1: sweeping coastal arc, 2: lower dogleg crook, 3: double wave
  const wob = (r() - 0.5) * 0.95, wobAz = leanAz + Math.PI / 2 + (r() - 0.5) * 0.4;
  const rBase = P.rBase * (0.9 + 0.2 * r()), rTop = P.rTop * (0.9 + 0.2 * r());
  const vOff = r();
  const palmFlex = (P.flex || 0.4) * (H / 10.5);
  const n = P.frondN + Math.floor(r() * 4);
  // Subtle natural leaf variation: ~40% of mature coconut palms have 1-2 sun-warmed/aging lower fronds (never overdone or on every tree)
  const isCoconut = Boolean(P.nuts && P.nuts !== 'areca');
  const hasAgingFronds = isCoconut && (seed % 5 === 1 || seed % 5 === 3);
  const hasSingleDryFrond = isCoconut && (seed % 5 === 3);
  const fronds = [];
  for (let k = 0; k < n; k++) {
    const a = k / (n - 1);
    const isDry = hasSingleDryFrond && k === n - 1;
    const isAging = hasAgingFronds && !isDry && k >= n - 3;
    const N = Math.round(46 * 1.25);
    const leaflets = [];
    for (let i = 0; i < 2 * N + 2; i++) {
      leaflets.push({
        miss: r() < (isDry ? 0.06 : 0.015),
        j: (r() - 0.5) * 0.4,
        len: 0.92 + r() * 0.16,
        fold: (r() - 0.5) * 0.14,
        droop: (r() - 0.5) * 0.08 + (isAging ? 0.06 : 0),
        tint: 0.92 + r() * 0.14,
        amber: isAging && r() < 0.28,
      });
    }
    const yellowAmt = isDry
      ? 0.85
      : isAging
        ? 0.48 + 0.28 * r()
        : Math.pow(a, 1.6) * 0.22 + r() * 0.06;
    fronds.push({
      a,
      az: k * 2.39996 + (r() - 0.5) * 0.48,
      el: (isDry ? P.elBot - 0.24 : lerp(P.elTop, P.elBot, Math.pow(a, 0.85))) + (r() - 0.5) * 0.22,
      L: P.frondL * (0.86 + 0.28 * r()) * (a < 0.25 ? 0.65 + 1.4 * a : isDry ? 0.88 : 1),
      g: lerp(P.g[0], P.g[1], a) * (0.82 + 0.36 * r()) * (isDry ? 1.22 : 1),
      shade: 0.9 + 0.14 * r(),
      yellow: yellowAmt,
      dry: isDry,
      leaflets,
    });
  }

  const b = new GeoBuilder();
  const segs = 24, radial = 12;
  const ld = V(Math.cos(leanAz), 0, Math.sin(leanAz)), wd = V(Math.cos(wobAz), 0, Math.sin(wobAz));
  const path = [], radii = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    let h;
    if (curveStyle === 0) {
      // Classic Kerala coastal S-curve: sweeps outward then curves back upright toward the sun
      h = lean * H * (Math.pow(t, 1.25) * 1.35 - 0.42 * Math.pow(t, 2.5));
    } else if (curveStyle === 1) {
      // Sweeping graceful coastal arc
      h = lean * H * Math.pow(t, 1.55) * 0.92;
    } else if (curveStyle === 2) {
      // Low crook near base then straighter upper trunk
      h = lean * H * Math.pow(t, 0.88) * (1 - 0.35 * t);
    } else {
      // Sinuous double inflection
      h = lean * H * (Math.pow(t, 1.35) * 0.8 + 0.14 * Math.sin(Math.PI * 1.8 * t));
    }
    const latSway = wob * (Math.sin(Math.PI * t) * 0.048 + 0.018 * Math.sin(Math.PI * 2 * t)) * H;
    path.push(V(0, H * t - 0.12, 0).addScaledVector(ld, h).addScaledVector(wd, latSway));
    radii.push(rTop + (rBase - rTop) * Math.pow(1 - t, 1.35) + rBase * 0.52 * Math.pow(Math.max(0, 1 - (t * H) / 0.75), 2));
  }
  const tint = P.trunkTint || [1, 1, 1];
  b.tube(path, radii, {
    radial, strip: barkStrip('palmBark'), vPerM: 1 / 4.2, vOff,
    color: (t) => mul([lerp(0.78, 0.96, Math.min(1, t * 1.8)) * tint[0], lerp(0.75, 0.92, Math.min(1, t * 1.8)) * tint[1], lerp(0.70, 0.85, Math.min(1, t * 1.8)) * tint[2]],
      0.72 + 0.28 * Math.min(1, (t * H) / 0.9)),
    wind: (t) => packWind(palmFlex * Math.pow(t, 1.75), 0, false),
  });
  const top = path[segs], T = path[segs].clone().sub(path[segs - 1]).normalize();
  let crown = top.clone();
  if (P.crownshaft) {
    const cs = [0, 0.4, 0.9, 1.3].map((s) => top.clone().addScaledVector(T, s));
    b.tube(cs, [rTop * 1.05, rTop * 1.45, rTop * 1.4, rTop * 1.05], {
      radial, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
      color: (t) => [0.36 + t * 0.08, 0.5 + t * 0.06, 0.26],
      wind: () => packWind(palmFlex, 0, false),
    });
    crown = cs[3];
  } else {
    const cs = [-0.15, 0.15, 0.45, 0.62].map((s) => top.clone().addScaledVector(T, s));
    b.tube(cs, [rTop * 1.05, rTop * 1.75, rTop * 1.45, rTop * 0.5], {
      radial, strip: barkStrip('palmBark'), vPerM: 0.8, vOff,
      color: () => [0.55, 0.46, 0.34],
      wind: () => packWind(palmFlex, 0, false),
    });
    crown = cs[2];
  }
  fronds.forEach((f) => {
    const o = crown.clone().add(V(Math.cos(f.az) * 0.1, -0.08, Math.sin(f.az) * 0.1));
    geometricFrond(b, midrib(o, f.az, f.el, f.L, f.g, 10), f, P, f.leaflets, Boolean(f.dry), FROND_Q[0], palmFlex);
  });

  // Realistic fruit clusters:
  // - Areca palms: fruiting spadix emerges AT the base of the green crownshaft (top of grey trunk `top`), never stuck along the middle of the green shaft
  // - Coconut palms: 2-3 tight peduncle stalks hanging directly under the woven crown (`crown`) with clustered ovoid tender green/golden coconuts
  if (P.nuts === 'areca') {
    const nBunches = 1 + (seed % 2);
    const bunchAz0 = r() * Math.PI * 2;
    for (let bi = 0; bi < nBunches; bi++) {
      const bAz = bunchAz0 + bi * Math.PI * (0.85 + r() * 0.3);
      const outDir = V(Math.cos(bAz), 0, Math.sin(bAz));
      const stalkStart = top.clone().addScaledVector(T, 0.04).addScaledVector(outDir, rTop * 0.95);
      const stalkMid = stalkStart.clone().addScaledVector(outDir, 0.12).add(V(0, -0.08, 0));
      const stalkEnd = stalkMid.clone().addScaledVector(outDir, 0.08).add(V(0, -0.16, 0));
      b.tube([stalkStart, stalkMid, stalkEnd], [0.022, 0.016, 0.010], {
        radial: 4, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
        color: () => [0.46, 0.54, 0.24],
        wind: () => packWind(palmFlex, 0.02, false),
      });
      const ripeBunch = (seed + bi) % 2 === 0;
      const nutBase = ripeBunch ? [0.68, 0.48, 0.16] : [0.44, 0.56, 0.22];
      for (let k = 0; k < 7; k++) {
        const t = k / 6;
        const p = stalkMid.clone().lerp(stalkEnd, t);
        const a = k * 2.399 + r() * 0.4;
        const rad = 0.032 + 0.022 * Math.sin(Math.PI * t);
        const c = p.add(V(Math.cos(a) * rad, (r() - 0.5) * 0.03, Math.sin(a) * rad));
        b.sphere(c, 0.028 + r() * 0.006, 6, 5, PLAIN_UV, mul(nutBase, 0.9 + r() * 0.2), packWind(palmFlex, 0.02, false), 1.25);
      }
    }
  } else if (P.nuts) {
    const nBunches = 2 + (seed % 2);
    const bunchAz0 = r() * Math.PI * 2;
    const isGoldenVar = seed % 3 === 1;
    const nutBase = isGoldenVar ? [0.62, 0.52, 0.18] : [0.40, 0.52, 0.18];
    for (let bi = 0; bi < nBunches; bi++) {
      const bAz = bunchAz0 + (bi / nBunches) * Math.PI * 2 + (r() - 0.5) * 0.45;
      const outDir = V(Math.cos(bAz), 0, Math.sin(bAz));
      const sideDir = V(-outDir.z, 0, outDir.x);
      const stalkStart = crown.clone().add(V(0, -0.06, 0)).addScaledVector(outDir, rTop * 0.9);
      const stalkMid = stalkStart.clone().addScaledVector(outDir, 0.16).add(V(0, -0.10, 0));
      const stalkEnd = stalkMid.clone().addScaledVector(outDir, 0.09).add(V(0, -0.18, 0));
      b.tube([stalkStart, stalkMid, stalkEnd], [0.032, 0.022, 0.014], {
        radial: 5, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
        color: () => [0.54, 0.48, 0.24],
        wind: () => packWind(palmFlex, 0.02, false),
      });
      const nNuts = 3 + Math.floor(r() * 3);
      for (let k = 0; k < nNuts; k++) {
        const ka = (k / nNuts) * Math.PI * 2 + r() * 0.35;
        const center = stalkMid.clone().lerp(stalkEnd, 0.35 + 0.55 * (k / nNuts))
          .addScaledVector(outDir, Math.cos(ka) * 0.075)
          .addScaledVector(sideDir, Math.sin(ka) * 0.075)
          .add(V(0, -0.03 * (k % 2), 0));
        const col = mul(nutBase, 0.88 + r() * 0.22);
        b.sphere(center, 0.095 + r() * 0.018, 8, 6, PLAIN_UV, col, packWind(palmFlex, 0.02, false), 1.24);
      }
    }
  }
  const g = b.build();
  g.userData.height = H;
  g.userData.leanAz = leanAz;
  g.userData.canopy = P.frondL * 0.8;
  return g;
}

// ---------------------------------------------------------------------------
// Broadleaf trees: diverse curved/forked trunks, crooked branches & lush canopies
// ---------------------------------------------------------------------------
export const TREES = {
  mango: { trunkH: 2.3, trunkR: 0.27, rx: 3.7, ry: 2.8, prim: [4, 7], incl: [0.46, 0.92], sec: [3, 4], twigs: [4, 5],
    card: [0.72, 0.92], tiles: [['mango', 0.55], ['mangoB', 0.45]], tint: [0.95, 1, 0.95], bark: [0.78, 0.73, 0.67] },
  rain: { trunkH: 2.7, trunkR: 0.31, rx: 5.1, ry: 2.3, prim: [5, 7], incl: [0.78, 1.15], sec: [3, 5], twigs: [4, 5],
    card: [0.84, 1.08], tiles: [['fine', 1]], tint: [0.97, 1, 0.94], bark: [0.75, 0.70, 0.64] },
  almond: { tiered: true, trunkH: 2.1, trunkR: 0.22, rx: 3.8, ry: 2.2, card: [0.78, 0.96], tiles: [['almond', 1]], tint: [0.96, 1, 0.95], bark: [0.82, 0.77, 0.71] },
};

function ellipsoidReach(start, d, C, rad, target) {
  let lo = 0, hi = 14;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const p = start.clone().addScaledVector(d, m).sub(C);
    const q = Math.hypot(p.x / rad.x, p.y / rad.y, p.z / rad.z);
    if (q < target) lo = m; else hi = m;
  }
  return lo;
}

/** Smoothly curved, crooked branch path with vertical arch and lateral sinuosity (never a stiff pipe). */
function sinuousBranchPts(s, e, bendUp, crookSide, crookAmp, crookFreq = 1, n = 7) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const arch = bendUp * Math.sin(Math.PI * t) * 0.55 + bendUp * t * t * 0.25;
    const crook = crookAmp * Math.sin(Math.PI * crookFreq * t);
    return s.clone().lerp(e, t).add(V(0, arch, 0)).addScaledVector(crookSide, crook);
  });
}

export function tree(seed, lod, S) {
  const r = rng(seed);
  const habit = seed % 4; // 0: sinuous curved trunk, 1: low-forking twin/triple boughs, 2: sweeping asymmetric crown, 3: gnarled spreading dome
  const trunkH = S.trunkH * (habit === 1 ? 0.68 + 0.18 * r() : 0.85 + 0.32 * r());
  const trunkR = S.trunkR * (0.88 + 0.26 * r());
  const asymX = 0.85 + 0.34 * r(), asymZ = 0.85 + 0.34 * r();
  const rad = V(S.rx * asymX, S.ry * (0.86 + 0.28 * r()), S.rx * asymZ);

  // Curved / leaning trunk parameters
  const leanAz = r() * Math.PI * 2;
  const leanMag = (habit === 0 || habit === 2 ? 0.55 + r() * 0.65 : 0.25 + r() * 0.45);
  const crookAz = leanAz + Math.PI * 0.5 + (r() - 0.5) * 0.6;
  const crookMag = (habit === 0 || habit === 3 ? 0.32 + r() * 0.38 : 0.16 + r() * 0.24) * (r() < 0.5 ? 1 : -1);
  const leanDir = V(Math.cos(leanAz), 0, Math.sin(leanAz));
  const crookDir = V(Math.cos(crookAz), 0, Math.sin(crookAz));

  const vOff = r();
  const branches = [];
  const clusters = [];
  const treeFlex = 0.09;
  let C;

  // Volumetric cluster emitter: places a 3D multi-angled foliage puff at `pos` with coupled branch wind flex
  const addPuff = (pos, baseNormal, baseSize, puffCount = 2, wBranch = treeFlex) => {
    const n0 = baseNormal.clone().normalize();
    const f0 = frameFor(n0);
    for (let m = 0; m < puffCount; m++) {
      let n = n0.clone();
      let p = pos.clone();
      if (m > 0) {
        const ang = (m / (puffCount - 1)) * Math.PI * 2 + r() * 0.8;
        const sideTilt = f0.side.clone().applyAxisAngle(n0, ang);
        n = n0.clone().multiplyScalar(0.68).addScaledVector(sideTilt, 0.58).add(V(0, 0.25, 0)).normalize();
        p.addScaledVector(sideTilt, baseSize * 0.24).add(V(0, (r() - 0.45) * baseSize * 0.18, 0));
      }
      const f = frameFor(n);
      const ay = f.side.clone().applyAxisAngle(n, r() * Math.PI * 2).normalize();
      clusters.push({
        a: p, ay, n,
        size: baseSize * (m === 0 ? 1.0 : 0.88 + r() * 0.16),
        tile: pickWeighted(r, S.tiles),
        flip: r() < 0.5,
        wBranch,
        tint: [S.tint[0] * (0.94 + r() * 0.09), S.tint[1] * (0.95 + r() * 0.08), S.tint[2] * (0.93 + r() * 0.09)],
      });
    }
  };

  // Smoothly curved 10-segment trunk helper
  const trunkPosAt = (t, totalH) => {
    const sCurve = habit === 0 ? Math.sin(Math.PI * 1.35 * t) * 0.85 : Math.pow(t, 1.25) - 0.22 * Math.pow(t, 2.4);
    const lat = Math.sin(Math.PI * (habit === 3 ? 1.8 : 1.1) * t);
    return V(0, totalH * t - (t === 0 ? 0.12 : 0), 0)
      .addScaledVector(leanDir, leanMag * sCurve)
      .addScaledVector(crookDir, crookMag * lat);
  };

  const trunkSegs = 10;
  let trunkPts, trunkRadii;

  if (S.tiered) {
    // Terminalia (Indian Almond): curved pagoda trunk with staggered, organic crooked whorls
    const tiers = 3 + (seed % 2);
    const tierStep = 1.1 + r() * 0.22;
    const topH = trunkH + (tiers - 1) * tierStep + 0.65;
    trunkPts = Array.from({ length: trunkSegs + 1 }, (_, i) => trunkPosAt(i / trunkSegs, topH - 0.12));
    trunkRadii = Array.from({ length: trunkSegs + 1 }, (_, i) => {
      const t = i / trunkSegs;
      const flare = trunkR * 0.38 * Math.pow(Math.max(0, 1 - t * 3.5), 2);
      return lerp(trunkR, trunkR * 0.28, Math.pow(t, 0.88)) + flare;
    });
    const midTrunk = trunkPosAt(0.55, topH);
    C = V(midTrunk.x, trunkH + 1.35, midTrunk.z);

    for (let k = 0; k < tiers; k++) {
      const hy = trunkH + k * tierStep;
      const tTrunk = Math.min(1, hy / topH);
      const wTier = treeFlex * Math.pow(tTrunk, 1.65);
      const s = trunkPosAt(tTrunk, topH);
      const nb = 4 + ((k + seed) % 3);
      const R = rad.x * (1 - 0.21 * k) * (0.9 + 0.2 * r());
      for (let i = 0; i < nb; i++) {
        const az = (i / nb) * Math.PI * 2 + k * 0.72 + (r() - 0.5) * 0.42;
        const len = R * (0.68 + r() * 0.28);
        const outDir = V(Math.cos(az), 0.16 + (r() - 0.5) * 0.12, Math.sin(az)).normalize();
        const sideDir = V(-Math.sin(az), 0, Math.cos(az));
        const e = s.clone().add(V(Math.cos(az) * len, (0.18 + r() * 0.22) * (k === 0 ? 0.6 : 1), Math.sin(az) * len));
        const branchEnd = s.clone().lerp(e, 0.76);
        const ppts = sinuousBranchPts(s, branchEnd, 0.14 + (r() - 0.5) * 0.12, sideDir, (r() - 0.5) * 0.28, 1.2, 6);
        branches.push({ pts: ppts, r0: trunkR * 0.42 * (1 - 0.16 * k), r1: 0.016, level: 1, w0: wTier, w1: wTier + 0.09 });
        const sz = range(r, S.card) * (1 - 0.06 * k);
        addPuff(e.clone().add(V(0, 0.08, 0)), V(outDir.x * 0.55, 0.82, outDir.z * 0.55), sz * 1.05, 3, wTier + 0.10);
        addPuff(s.clone().lerp(e, 0.52).add(V(0, 0.14, 0)), V(outDir.x * 0.4, 0.9, outDir.z * 0.4), sz * 0.92, 2, wTier + 0.06);
        for (const sideSgn of [-1, 1]) {
          const sp = ppts[Math.min(ppts.length - 2, 2 + Math.floor(r() * 2))].clone();
          const az2 = az + sideSgn * (0.55 + r() * 0.32);
          const l2 = len * (0.34 + r() * 0.16);
          const e2 = sp.clone().add(V(Math.cos(az2) * l2, 0.12 + (r() - 0.5) * 0.1, Math.sin(az2) * l2));
          const spts = sinuousBranchPts(sp, sp.clone().lerp(e2, 0.72), 0.08, V(-Math.sin(az2), 0, Math.cos(az2)), (r() - 0.5) * 0.14, 1, 4);
          branches.push({ pts: spts, r0: 0.032, r1: 0.012, level: 2, w0: wTier + 0.05, w1: wTier + 0.11 });
          addPuff(e2.clone().add(V(0, 0.06, 0)), V(Math.cos(az2) * 0.55, 0.82, Math.sin(az2) * 0.55), sz * 0.88, 2, wTier + 0.11);
        }
      }
      addPuff(s.clone().add(V(0, 0.22, 0)), UP, range(r, S.card) * 0.92, 2, wTier + 0.04);
    }
    const topPt = trunkPts[trunkPts.length - 1];
    addPuff(topPt.clone().add(V(0, 0.12, 0)), UP, range(r, S.card) * 0.96, 3, treeFlex + 0.08);
  } else {
    // Mango & Rain Tree: curved/sinuous trunk + crooked overarching boughs + concealed tips
    trunkPts = Array.from({ length: trunkSegs + 1 }, (_, i) => trunkPosAt(i / trunkSegs, trunkH));
    trunkRadii = Array.from({ length: trunkSegs + 1 }, (_, i) => {
      const t = i / trunkSegs;
      const flare = trunkR * 0.42 * Math.pow(Math.max(0, 1 - t * 3.2), 2);
      return lerp(trunkR, trunkR * 0.62, Math.pow(t, 0.85)) + flare;
    });
    const trunkTop = trunkPts[trunkSegs];
    const crownShift = V(leanDir.x * (habit === 2 ? 0.55 : 0.2), 0, leanDir.z * (habit === 2 ? 0.55 : 0.2));
    C = trunkTop.clone().add(V(crownShift.x, rad.y * 0.58, crownShift.z));

    const k = S.prim[0] + Math.floor(r() * (S.prim[1] - S.prim[0] + 1));
    for (let i = 0; i < k; i++) {
      const az = (i / k) * Math.PI * 2 + (r() - 0.5) * 0.55;
      const incl = clamp01(range(r, S.incl) / 1.35) * 1.15 + (habit === 2 ? 0.12 * Math.cos(az - leanAz) : 0);
      const d = V(Math.sin(incl) * Math.cos(az), Math.cos(incl), Math.sin(incl) * Math.sin(az)).normalize();
      // Start primary branches at varied heights along the upper trunk for natural staggered forks
      const forkIdx = Math.max(5, trunkSegs - Math.floor(r() * 3));
      const start = trunkPts[forkIdx].clone();
      const wStart = treeFlex * Math.pow(forkIdx / trunkSegs, 1.65);
      const Lp = ellipsoidReach(start, d, C, rad, 0.56 + r() * 0.14);
      const pe = start.clone().addScaledVector(d, Lp);
      const sideDir = V(-Math.sin(az), 0, Math.cos(az));
      const ppts = sinuousBranchPts(start, pe, Lp * (0.10 + (r() - 0.35) * 0.12), sideDir, (r() - 0.5) * Lp * 0.22, 1 + (i % 2) * 0.5, 7);
      const wPrimaryEnd = wStart + 0.08;
      // Taper primary branch smoothly and conceal its tip inside a lush interior foliage cushion
      branches.push({ pts: ppts, r0: trunkR * 0.50, r1: 0.024, level: 1, w0: wStart, w1: wPrimaryEnd });
      const outPrim = pe.clone().sub(C).divide(rad).normalize().add(V(0, 0.42, 0)).normalize();
      addPuff(pe.clone().add(V(0, 0.08, 0)), outPrim, range(r, S.card) * 1.04, 2, wPrimaryEnd);

      const ns = S.sec[0] + Math.floor(r() * (S.sec[1] - S.sec[0] + 1));
      for (let s = 0; s < ns; s++) {
        // Ensure the last secondary branch continues right from near the primary branch end (`t = 0.85..0.95`) so zero blunt stubs exist
        const tBranch = s === ns - 1 ? 0.84 + 0.12 * r() : 0.32 + 0.52 * (s / Math.max(1, ns - 1)) + (r() - 0.5) * 0.12;
        const pIdx = Math.min(ppts.length - 2, Math.max(1, Math.floor(tBranch * (ppts.length - 1))));
        const sp = ppts[pIdx].clone().lerp(ppts[pIdx + 1], r());
        const wSecStart = lerp(wStart, wPrimaryEnd, tBranch);
        const az2 = az + (s / Math.max(1, ns - 1) - 0.5) * 1.45 + (r() - 0.5) * 0.42;
        const incl2 = Math.max(0.28, Math.min(1.18, incl + (r() - 0.48) * 0.48));
        const d2 = V(Math.sin(incl2) * Math.cos(az2), Math.cos(incl2), Math.sin(incl2) * Math.sin(az2)).normalize();
        const Ls = ellipsoidReach(sp, d2, C, rad, 0.74 + r() * 0.10);
        const se = sp.clone().addScaledVector(d2, Ls);
        // Stop the visible woody secondary branch at 78% of `se` so the tip is buried deep inside the foliage cushion
        const secWoodEnd = sp.clone().lerp(se, 0.78);
        const spts = sinuousBranchPts(sp, secWoodEnd, Ls * (0.08 + (r() - 0.4) * 0.08), V(-Math.sin(az2), 0, Math.cos(az2)), (r() - 0.5) * Ls * 0.2, 1, 5);
        const wSecEnd = wSecStart + 0.08;
        branches.push({ pts: spts, r0: trunkR * 0.22 * (1 - 0.25 * tBranch), r1: 0.014, level: 2, w0: wSecStart, w1: wSecEnd });

        const outSec = se.clone().sub(C).divide(rad).normalize().add(V(0, 0.35, 0)).normalize();
        addPuff(sp.clone().lerp(se, 0.55), outSec, range(r, S.card) * 0.96, 2, lerp(wSecStart, wSecEnd, 0.55));
        addPuff(se.clone(), outSec, range(r, S.card) * 1.08, 3, wSecEnd);

        const nt = S.twigs[0] + Math.floor(r() * (S.twigs[1] - S.twigs[0] + 1));
        for (let tw = 0; tw < nt; tw++) {
          const tp = spts[1].clone().lerp(spts[spts.length - 1], r());
          const out = tp.clone().sub(C).divide(rad).normalize();
          const d3 = out.clone().add(randUnit(r).multiplyScalar(0.45)).add(V(0, 0.24, 0)).normalize();
          const Lt = Math.max(0.28, Math.min(1.05, ellipsoidReach(tp, d3, C, rad, 0.88 + r() * 0.08)));
          const te = tp.clone().addScaledVector(d3, Lt);
          const outTip = te.clone().sub(C).divide(rad).normalize().add(V(0, 0.35, 0)).normalize();
          addPuff(tp.clone().lerp(te, 0.62), outTip, range(r, S.card) * 0.96, 2, wSecEnd + 0.02);
          addPuff(te, outTip, range(r, S.card) * 1.02, 2, wSecEnd + 0.04);
        }
      }
    }
    // Central upper crown cushion concealing the main trunk fork from above and below
    addPuff(trunkTop.clone().add(V(0, 0.35, 0)), UP, range(r, S.card) * 1.08, 3, treeFlex);
  }

  const b = new GeoBuilder();
  const radial = 9;
  const bark = barkStrip('treeBark');
  b.tube(trunkPts, trunkRadii, {
    radial, strip: bark, vPerM: 0.16, vOff,
    color: (t) => mul(S.bark, 0.78 + 0.22 * t),
    wind: (t) => packWind(treeFlex * Math.pow(t, 1.65), 0, false),
  });
  for (const br of branches) {
    const rr = br.pts.map((_, i) => lerp(br.r0, br.r1, Math.pow(i / (br.pts.length - 1), 0.85)));
    const w0 = br.w0 ?? treeFlex, w1 = br.w1 ?? (treeFlex + 0.08);
    b.tube(br.pts, rr, {
      radial: Math.max(5, radial - br.level * 2), strip: bark, vPerM: 0.18, vOff,
      color: (t) => mul(S.bark, 0.84 + 0.12 * t),
      wind: (t) => packWind(lerp(w0, w1, t), 0, false),
    });
  }
  const nf = (cardN) => (p) => {
    const radialN = p.clone().sub(C).divide(rad).normalize();
    return radialN.multiplyScalar(0.76).addScaledVector(cardN, 0.16).add(V(0, 0.55, 0)).normalize();
  };
  const cf = (tint) => (p) => {
    const hr = clamp01((p.y - (C.y - rad.y)) / (2 * rad.y));
    const rho = clamp01(p.clone().sub(C).divide(rad).length());
    return mul(tint, 0.74 + 0.26 * clamp01(0.28 + 0.45 * hr + 0.32 * rho));
  };
  for (const cl of clusters) {
    const rect = uvRect(cl.tile, 10);
    const sz = cl.size;
    const side = new THREE.Vector3().crossVectors(cl.ay, cl.n).normalize();
    const ax = side.multiplyScalar(sz), ay = cl.ay.clone().multiplyScalar(sz);
    const wBr = cl.wBranch ?? (treeFlex + 0.08);
    const wf = (p, sy) => packWind(wBr, 0.05 + 0.08 * clamp01((sy + 1) / 2), true);
    b.cuppedCard(cl.a, ax, ay, cl.n, sz * 0.28, rect, nf(cl.n), cf(cl.tint), wf, cl.flip, 'center');
  }
  const g = b.build();
  g.userData.height = C.y + rad.y;
  g.userData.canopy = Math.max(rad.x, rad.z);
  return g;
}

// ---------------------------------------------------------------------------
// Banana clump (pure lush green arched blades, proper width/UV mapping)
// ---------------------------------------------------------------------------
export function banana(seed) {
  const r = rng(seed);
  const stems = [];
  const ns = 1 + Math.floor(r() * 3);
  for (let s = 0; s < ns; s++) {
    const off = s === 0 ? V() : V((r() - 0.5) * 0.85, 0, (r() - 0.5) * 0.85);
    const h = s === 0 ? 2.4 + r() * 0.45 : 1.4 + r() * 0.9;
    const leaves = [];
    const m = s === 0 ? 8 + Math.floor(r() * 2) : 5 + Math.floor(r() * 2);
    for (let i = 0; i < m; i++) {
      const a = i / (m - 1);
      leaves.push({ az: i * 2.35 + r() * 0.4, el: lerp(1.12, -0.18, a) + (r() - 0.5) * 0.16, L: (h / 2.6) * (1.55 + r() * 0.45), g: lerp(0.05, 0.18, a) });
    }
    stems.push({ off, h, leaves, lean: V((r() - 0.5) * 0.2, 0, (r() - 0.5) * 0.2) });
  }
  const b = new GeoBuilder();
  const rect = uvRect('banana', 8);
  const prof = (t) => Math.pow(Math.max(0, Math.sin(Math.PI * (0.03 + 0.95 * t))), 0.38);
  for (const st of stems) {
    const k = st.h / 2.6;
    const pts = [-0.06, 0.5, 1].map((t) => st.off.clone().add(V(st.lean.x * Math.max(0, t), st.h * t, st.lean.z * Math.max(0, t))));
    const stemFlex = 0.28 * k;
    b.tube(pts, [0.16 * k, 0.115 * k, 0.085 * k], {
      radial: 8, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
      color: (t) => [0.36 + 0.06 * t, 0.46 + 0.10 * t, 0.22],
      wind: (t) => packWind(stemFlex * Math.pow(Math.max(0, t), 1.6), 0, false),
    });
    const top = pts[2];
    for (const lf of st.leaves) {
      const D = dirAE(lf.az, Math.max(lf.el, 0.35) + 0.2);
      const pet = top.clone().addScaledVector(D, 0.32);
      b.tube([top, pet], [0.034, 0.022], {
        radial: 4, strip: plainStrip, vPerM: 0, vOff: PLAIN_UV[1],
        color: () => [0.42, 0.54, 0.25],
        wind: (t) => packWind(stemFlex + 0.04 * t, 0, false),
      });
      ribbonLeaf(b, midrib(pet, lf.az, lf.el, lf.L, lf.g, 8, 0.25), rect, 0.28, prof, {
        widen: 1, fold: [0.14, 0.28],
        color: [0.96, 1, 0.93], ao: (t) => 0.76 + 0.24 * t,
        wind: (t) => packWind(stemFlex + 0.04 + 0.26 * Math.pow(t, 1.35), 0.12 + 0.42 * Math.pow(t, 1.45), true),
        flutter: 0.04, upBias: 0.62,
      });
    }
  }
  const g = b.build();
  g.userData.height = 3.4;
  g.userData.canopy = 1.7;
  return g;
}

// ---------------------------------------------------------------------------
// Coastal Screw Pine / Beach Palm Clump (Pandanus odorifer) – lush multi-stem
// coastal foliage clump with ringed sandy-grey stems and dense, gracefully
// arching sword-leaf rosettes (no tripod stick roots or bare spindly twigs).
// ---------------------------------------------------------------------------
export function pandanus(seed) {
  const r = rng(seed);
  const b = new GeoBuilder();
  const bark = barkStrip('palmBark');
  const vOff = r();
  const panFlex = 0.22;

  // 3-4 gracefully curving coastal stems rising from a grounded basal clump
  const nStems = 3 + (seed % 2);
  const baseAz0 = r() * Math.PI * 2;
  const crowns = [];

  for (let s = 0; s < nStems; s++) {
    const isMain = s === 0;
    const az = baseAz0 + (s / nStems) * Math.PI * 2 + (r() - 0.5) * 0.45;
    const H = isMain ? 2.15 + r() * 0.45 : 1.25 + r() * 0.65;
    const lean = isMain ? 0.22 + r() * 0.14 : 0.36 + r() * 0.22;
    const baseOff = isMain ? 0.04 : 0.14 + r() * 0.08;
    const dir = V(Math.cos(az), 0, Math.sin(az));
    const side = V(-dir.z, 0, dir.x);
    const wob = (r() - 0.5) * 0.14;

    const pts = [0, 0.25, 0.55, 0.82, 1].map((t) => {
      const reach = baseOff + lean * H * Math.pow(t, 1.35);
      const lat = wob * H * Math.sin(Math.PI * t);
      const y = t === 0 ? -0.14 : H * t;
      return V(0, y, 0).addScaledVector(dir, reach).addScaledVector(side, lat);
    });
    const r0 = isMain ? 0.14 : 0.105;
    const r1 = isMain ? 0.085 : 0.068;
    const radii = [r0 * 1.28, r0, lerp(r0, r1, 0.5), lerp(r0, r1, 0.85), r1];
    b.tube(pts, radii, {
      radial: 8, strip: bark, vPerM: 0.22, vOff: vOff + s * 0.23,
      color: (t) => [lerp(0.72, 0.88, t), lerp(0.68, 0.84, t), lerp(0.60, 0.76, t)],
      wind: (t) => packWind(panFlex * (H / 2.2) * Math.pow(t, 1.5), 0, false),
    });

    const tip = pts[pts.length - 1];
    const T = tip.clone().sub(pts[pts.length - 2]).normalize();
    // Woven leaf-base collar beneath each rosette
    const collar = [-0.08, 0.06, 0.18].map((d) => tip.clone().addScaledVector(T, d));
    b.tube(collar, [r1 * 1.05, r1 * 1.38, r1 * 0.65], {
      radial: 7, strip: bark, vPerM: 0.35, vOff,
      color: () => [0.52, 0.48, 0.34],
      wind: () => packWind(panFlex * (H / 2.2), 0, false),
    });
    crowns.push({ p: collar[1], scale: isMain ? 1.0 : 0.78 + 0.16 * (H / 2.0), flex: panFlex * (H / 2.2) });
  }

  // Dense, layered spiral rosettes of wide, gracefully arching tropical sword leaves
  for (const cr of crowns) {
    const m = Math.round(28 * cr.scale);
    for (let i = 0; i < m; i++) {
      const a = i / (m - 1);
      const az = i * 2.39996 + (r() - 0.5) * 0.22;
      const el = lerp(1.22, -0.38, Math.pow(a, 0.82)) + (r() - 0.5) * 0.12;
      const L = (1.15 + r() * 0.38) * cr.scale * (a < 0.2 ? 0.68 + 1.6 * a : 1.0);
      const g = lerp(0.12, 0.34, a) * (0.88 + r() * 0.24);
      const band = r() < 0.55 ? 2 : 3; // lush green strap-leaf bands
      const origin = cr.p.clone().add(V(Math.cos(az) * 0.04, -0.04 * a, Math.sin(az) * 0.04));
      const leafShade = 0.88 + 0.16 * (1 - a * 0.5) + (r() - 0.5) * 0.06;
      const warm = a > 0.78 ? (a - 0.78) * 0.8 : 0;
      ribbonLeaf(
        b,
        midrib(origin, az, el, L, g, 8, 0.12),
        uvBand('strap', band, 4),
        0.095 * cr.scale,
        (t) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.05 + 0.92 * t)), 0.45) * (1 - 0.35 * t),
        {
          widen: 1,
          fold: [0.24, 0.42],
          color: [leafShade * (0.94 + 0.12 * warm), leafShade, leafShade * (0.90 - 0.15 * warm)],
          ao: (t) => 0.70 + 0.30 * t,
          wind: (t) => packWind(cr.flex + 0.12 * t, 0.06 + 0.26 * Math.pow(t, 1.45), true),
          flutter: 0.022,
          upBias: 0.55,
        }
      );
    }
  }

  // Lush basal skirt of arching sword leaves at sand level so the base blends naturally into the beach
  const nSkirt = 14;
  for (let i = 0; i < nSkirt; i++) {
    const a = i / (nSkirt - 1);
    const az = i * 2.39996 + r() * 0.3;
    const el = lerp(0.88, 0.28, a) + (r() - 0.5) * 0.12;
    const L = 0.65 + r() * 0.32;
    const g = 0.22 + r() * 0.14;
    ribbonLeaf(
      b,
      midrib(V(Math.cos(az) * 0.10, 0.02, Math.sin(az) * 0.10), az, el, L, g, 6, 0.06),
      uvBand('strap', 2 + (i % 2), 4),
      0.068,
      (t) => Math.pow(Math.sin(Math.PI * (0.05 + 0.92 * t)), 0.42),
      {
        widen: 1,
        fold: [0.22, 0.36],
        color: [0.92, 0.98, 0.88],
        ao: (t) => 0.65 + 0.35 * t,
        wind: (t) => packWind(0.04 * t, 0.04 + 0.14 * t * t, true),
        flutter: 0.015,
        upBias: 0.55,
      }
    );
  }

  const g = b.build();
  g.userData.height = 3.1;
  g.userData.canopy = 1.65;
  return g;
}

// ---------------------------------------------------------------------------
// Strap-leaf rosette (crinum / spider-lily foliage: compact arched green blades)
// ---------------------------------------------------------------------------
export function lily(seed) {
  const r = rng(seed);
  const m = 14 + Math.floor(r() * 4);
  const leaves = [];
  for (let i = 0; i < m; i++) {
    leaves.push({
      az: i * 2.4 + r() * 0.35,
      el: lerp(1.18, 0.48, i / (m - 1)) + (r() - 0.5) * 0.15,
      L: 0.42 + r() * 0.22,
      g: 0.28 + r() * 0.18,
      band: r() < 0.5 ? 2 : 3,
    });
  }
  const b = new GeoBuilder();
  for (const lf of leaves) {
    ribbonLeaf(b, midrib(V(0, 0.02, 0), lf.az, lf.el, lf.L, lf.g, 6, 0.04), uvBand('strap', lf.band, 4), 0.048,
      (t) => Math.pow(Math.sin(Math.PI * (0.04 + 0.92 * t)), 0.38), {
        widen: 1, fold: [0.22, 0.35], color: [0.96, 1, 0.94], ao: (t) => 0.68 + 0.32 * t,
        wind: (t) => packWind(0.03 * t, 0.04 + 0.14 * t * t, true), flutter: 0.015,
      });
  }
  const g = b.build();
  g.userData.height = 0.65;
  return g;
}

// ---------------------------------------------------------------------------
// Shrubs: dense hemispherical foliage domes with recessed internal woody stems
// ---------------------------------------------------------------------------
export const SHRUBS = {
  hedge: { R: 0.72, H: 0.98, tiles: [['shrub', 1]], card: [0.30, 0.38], tint: [0.95, 1, 0.94], count: 38 },
  box: { R: 0.48, H: 0.64, tiles: [['shrub', 1]], card: [0.23, 0.29], tint: [0.97, 1, 0.95], count: 32 },
  croton: { R: 0.46, H: 0.86, tiles: [['croton', 1]], card: [0.22, 0.28], tint: [0.98, 1, 0.96], count: 34 },
  coastal: { R: 0.76, H: 0.84, tiles: [['round', 1]], card: [0.31, 0.39], tint: [0.96, 1, 0.94], count: 36 },
};

export function shrub(seed, lod, T) {
  const r = rng(seed);
  const R = T.R * (0.92 + 0.16 * r()), H = T.H * (0.92 + 0.16 * r());
  const C = V(0, H * 0.48, 0), rad = V(R, H * 0.52, R);
  const clusters = [];
  // Golden-angle hemispherical distribution of cupped leaf clusters + inner core cushions (zero visible bare sticks)
  const total = T.count;
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1);
    const isCore = i < 7;
    const shellR = isCore ? (0.30 + r() * 0.24) : (0.70 + r() * 0.24);
    const u = isCore ? (0.25 + r() * 0.52) : (0.14 + 0.86 * t);
    const horiz = Math.sqrt(Math.max(0.04, 1 - (u * 2 - 1) * (u * 2 - 1) * 0.65));
    const az = i * 2.39996 + (r() - 0.5) * 0.28;
    const px = Math.cos(az) * R * horiz * shellR;
    const pz = Math.sin(az) * R * horiz * shellR;
    const sz = range(r, T.card) * (isCore ? 1.15 : 0.98 + 0.14 * (1 - u));
    const py = Math.max(sz * 0.46, H * (0.16 + 0.76 * u) + (r() - 0.5) * 0.04);
    const a = V(px, py, pz);
    const outw = a.clone().sub(C).divide(rad);
    outw.y = Math.max(0.22, outw.y + 0.28);
    const n2 = outw.normalize().add(randUnit(r).multiplyScalar(0.12)).normalize();
    const f = frameFor(n2);
    const ayc = f.side.clone().applyAxisAngle(n2, r() * Math.PI * 2).normalize();
    clusters.push({
      a, ay: ayc, n: n2, size: sz,
      tile: pickWeighted(r, T.tiles), flip: r() < 0.5,
      tint: [T.tint[0] * (0.95 + r() * 0.07), T.tint[1] * (0.96 + r() * 0.06), T.tint[2] * (0.94 + r() * 0.07)],
    });
  }

  const b = new GeoBuilder();
  const nf = (cardN) => (p) => p.clone().sub(C).divide(rad).normalize().multiplyScalar(0.78).addScaledVector(cardN, 0.14).add(V(0, 0.58, 0)).normalize();
  const cf = (tint) => (p) => mul(tint, 0.74 + 0.26 * clamp01(p.y / H * 0.85 + 0.18));
  for (const cl of clusters) {
    const rect = uvRect(cl.tile, 10);
    const sz = cl.size;
    const side = new THREE.Vector3().crossVectors(cl.ay, cl.n).normalize();
    b.cuppedCard(cl.a, side.multiplyScalar(sz), cl.ay.clone().multiplyScalar(sz), cl.n, sz * 0.28, rect, nf(cl.n), cf(cl.tint),
      (p, sy) => packWind(0.05 * clamp01(p.y / H), 0.03 + 0.06 * clamp01(p.y / H) * ((sy + 1) / 2), true), cl.flip, 'center');
  }
  const g = b.build();
  g.userData.height = H;
  g.userData.canopy = R;
  return g;
}

// ---------------------------------------------------------------------------
// Ground layer
// ---------------------------------------------------------------------------

/** Tropical grass clump patch made of multiple mini-tufts with varied blade height, direction, and low broadleaf groundcover. */
export function grassTuft(seed, lod, kind = 'lawn') {
  const r = rng(seed);
  const beach = kind === 'beach';
  const subClusters = beach ? 2 : 3 + (seed % 2);
  const centers = Array.from({ length: subClusters }, (_, i) => {
    const a = (i / subClusters) * Math.PI * 2 + r() * 0.9;
    const d = i === 0 ? 0.02 : (beach ? 0.08 : 0.11) + r() * 0.12;
    return [Math.cos(a) * d, Math.sin(a) * d, (r() - 0.5) * 0.5];
  });
  const nb = beach ? 14 : 22;
  const blades = [];
  for (let i = 0; i < nb; i++) {
    const [cx, cz, domAz] = centers[i % centers.length];
    const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * (beach ? 0.07 : 0.065);
    const heightVar = (i % 5 === 0) ? 1.22 : (0.72 + r() * 0.42);
    blades.push({
      base: V(cx + Math.cos(a) * rr, -0.015, cz + Math.sin(a) * rr),
      az: a + domAz + (r() - 0.5) * 1.1,
      lean: beach ? 0.22 + r() * 0.45 : 0.18 + r() * 0.48,
      len: (beach ? 0.28 + r() * 0.28 : 0.095 + r() * 0.10) * heightVar,
      w: beach ? 0.008 + r() * 0.004 : 0.0085 + r() * 0.0045,
      lush: r() < 0.45,
      shade: 0.88 + r() * 0.20,
    });
  }
  const b = new GeoBuilder();
  const segs = 2;
  for (const bl of blades) {
    const dir = V(Math.cos(bl.az), 0, Math.sin(bl.az));
    const side = V(-dir.z, 0, dir.x);
    const lo = beach ? [0.28, 0.38, 0.18] : [0.18, 0.29, 0.10];
    const hi = beach
      ? [0.46, 0.56, 0.28]
      : bl.lush
        ? [0.34, 0.48, 0.19]
        : [0.41, 0.52, 0.22];
    const ids = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const p = bl.base.clone()
        .add(V(0, bl.len * t * (1 - 0.22 * bl.lean * t), 0))
        .addScaledVector(dir, bl.len * Math.sin(bl.lean) * t * (0.45 + 0.55 * t));
      const w = bl.w * (1 - 0.78 * t * t) + 0.0012;
      const n = UP.clone().multiplyScalar(0.78).addScaledVector(dir, -0.22).normalize();
      const col = mul(mix3(lo, hi, t), bl.shade);
      const wnd = packWind((beach ? 0.10 : 0.03) * t * t, (beach ? 0.14 : 0.05) * t * t, true);
      ids.push(b.vert(p.clone().addScaledVector(side, w), n, PLAIN_UV[0], PLAIN_UV[1], col, wnd));
      ids.push(b.vert(p.clone().addScaledVector(side, -w), n, PLAIN_UV[0], PLAIN_UV[1], col, wnd));
    }
    for (let k = 0; k < segs; k++) b.quad(ids[k * 2], ids[k * 2 + 2], ids[k * 2 + 3], ids[k * 2 + 1]);
  }
  if (!beach && (seed % 2 === 0)) {
    const wc = centers[centers.length - 1];
    const nLeaves = 4;
    for (let k = 0; k < nLeaves; k++) {
      const a = (k / nLeaves) * Math.PI * 2 + r() * 0.6;
      const lw = 0.018 + r() * 0.008, ll = 0.042 + r() * 0.018;
      const dir = V(Math.cos(a), 0, Math.sin(a)), side = V(-dir.z, 0, dir.x);
      const p0 = V(wc[0], 0.008, wc[1]);
      const p1 = p0.clone().addScaledVector(dir, ll).add(V(0, 0.018 + r() * 0.012, 0));
      const c0 = [0.20, 0.32, 0.12], c1 = [0.33, 0.46, 0.19];
      const i0 = b.vert(p0.clone().addScaledVector(side, lw * 0.4), UP, PLAIN_UV[0], PLAIN_UV[1], c0, 0);
      const i1 = b.vert(p0.clone().addScaledVector(side, -lw * 0.4), UP, PLAIN_UV[0], PLAIN_UV[1], c0, 0);
      const i2 = b.vert(p1.clone().addScaledVector(side, lw), UP, PLAIN_UV[0], PLAIN_UV[1], c1, packWind(0.01, 0.02, true));
      const i3 = b.vert(p1.clone().addScaledVector(side, -lw), UP, PLAIN_UV[0], PLAIN_UV[1], c1, packWind(0.01, 0.02, true));
      b.quad(i0, i2, i3, i1);
    }
  }
  const g = b.build();
  g.userData.height = beach ? 0.5 : 0.22;
  return g;
}

/** Fern: compact volumetric rosette of arched fern pads above the soil (never dips below y = 0.04). */
export function fern(seed) {
  const r = rng(seed);
  const rect = uvRect('fern', 10);
  const n = 5;
  const h = 0.38 + r() * 0.12;
  const b = new GeoBuilder();
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + r() * 0.45;
    const out = V(Math.cos(az), 0, Math.sin(az));
    const tilt = 0.35 + r() * 0.25;
    const ay = UP.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(out, Math.sin(tilt)).multiplyScalar(h * 0.46);
    const ax = V(-out.z, 0, out.x).multiplyScalar(h * 0.46);
    const nrm = new THREE.Vector3().crossVectors(ax, ay).normalize(); if (nrm.y < 0) nrm.negate();
    const center = V(out.x * h * 0.22, h * 0.46, out.z * h * 0.22);
    b.cuppedCard(center, ax, ay, nrm, h * 0.14, rect, () => nrm.clone().add(V(0, 0.65, 0)).normalize(),
      (p) => mul([0.95, 1, 0.92], 0.68 + 0.32 * clamp01(p.y / h)), (p, sy) => packWind(0.03 * clamp01(p.y / h), 0.05 * ((sy + 1) / 2), true), r() < 0.5, 'center');
  }
  const g = b.build();
  g.userData.height = h;
  return g;
}

/** Unused placeholder kept for export compatibility. */
export function litter() {
  return new GeoBuilder().build();
}

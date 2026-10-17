import * as THREE from 'three';
import { rng } from './random.js';

// Shared 2048x2048 vegetation atlas (one material for every plant).
//  - Colour and coverage are painted on separate canvases and merged with
//    straight alpha; each tile is back-filled with its own mean leaf colour.
//  - Every tile is surrounded by a transparent gutter (>= 32px) and the opaque
//    bark strips sit 80px away from any foliage, so mip filtering can never
//    pull bark/neighbour texels into a leaf edge. The shader additionally clamps
//    the mip level (see materials.js).
//  - Leaves are painted large (no sub-pixel detail) so they stay clean when
//    minified instead of turning into aliasing noise.

export const ATLAS_W = 2048, ATLAS_H = 2048;
export const TILES = {
  frond: [0, 0, 1792, 128], frondDry: [0, 128, 1792, 128],
  palmBark: [1872, 0, 80, 2048], treeBark: [1968, 0, 80, 2048],
  mango: [0, 288, 512, 512], mangoB: [544, 288, 512, 512], fine: [1088, 288, 512, 512],
  strap: [1632, 288, 192, 192], leaflet: [1632, 512, 192, 48], leafletDry: [1632, 592, 192, 48], plain: [1680, 672, 64, 64],
  almond: [0, 832, 512, 512], shrub: [544, 832, 512, 512], round: [1088, 832, 512, 512], croton: [1632, 832, 192, 192],
  fern: [0, 1376, 512, 512], banana: [544, 1376, 1024, 256], litter: [544, 1664, 256, 256], grassCard: [832, 1664, 256, 256],
};

/** UV rectangle of a tile (v0 = top of the painted tile). */
export function uvRect(name, pad = 6) {
  const [x, y, w, h] = TILES[name];
  return { u0: (x + pad) / ATLAS_W, u1: (x + w - pad) / ATLAS_W, v0: (y + pad) / ATLAS_H, v1: (y + h - pad) / ATLAS_H };
}
/** Horizontal band i (of n) inside a tile. */
export function uvBand(name, i, n) {
  const [x, y, w, h] = TILES[name];
  const bh = h / n;
  return { u0: (x + 4) / ATLAS_W, u1: (x + w - 4) / ATLAS_W, v0: (y + bh * i + 3) / ATLAS_H, v1: (y + bh * (i + 1) - 3) / ATLAS_H };
}
export const PLAIN_UV = (() => { const [x, y, w, h] = TILES.plain; return [(x + w / 2) / ATLAS_W, (y + h / 2) / ATLAS_H]; })();
/** Bark strips wrap vertically (RepeatWrapping in T). */
export function barkStrip(name) { const [x, , w] = TILES[name]; return { u0: (x + 3) / ATLAS_W, u1: (x + w - 3) / ATLAS_W }; }
export const frondProfile = (t) => Math.max(0.06, Math.pow(Math.sin(Math.PI * (0.06 + 0.9 * t)), 0.65));

// ---------------------------------------------------------------------------
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const jit = (r, v, a) => v + (r() - 0.5) * 2 * a;
function both(P, fn) { fn(P.c, false); fn(P.a, true); }

function leafPath(c, len, wid, shape) {
  c.moveTo(0, 0);
  if (shape === 'obovate') {          // widest towards the tip (Terminalia)
    c.bezierCurveTo(len * 0.2, -wid * 0.45, len * 0.62, -wid * 1.2, len * 0.95, -wid * 0.5);
    c.quadraticCurveTo(len * 1.04, 0, len * 0.95, wid * 0.5);
    c.bezierCurveTo(len * 0.62, wid * 1.2, len * 0.2, wid * 0.45, 0, 0);
  } else if (shape === 'round') {
    c.bezierCurveTo(len * 0.05, -wid * 1.25, len * 0.98, -wid * 1.25, len, 0);
    c.bezierCurveTo(len * 0.98, wid * 1.25, len * 0.05, wid * 1.25, 0, 0);
  } else if (shape === 'oblong') {
    c.bezierCurveTo(len * 0.08, -wid * 1.05, len * 0.86, -wid * 1.05, len, 0);
    c.bezierCurveTo(len * 0.86, wid * 1.05, len * 0.08, wid * 1.05, 0, 0);
  } else if (shape === 'ovate') {
    c.bezierCurveTo(len * 0.12, -wid * 1.3, len * 0.62, -wid * 1.0, len, 0);
    c.bezierCurveTo(len * 0.62, wid * 1.0, len * 0.12, wid * 1.3, 0, 0);
  } else { // lance
    c.bezierCurveTo(len * 0.22, -wid * 1.12, len * 0.68, -wid * 0.82, len, 0);
    c.bezierCurveTo(len * 0.68, wid * 0.82, len * 0.22, wid * 1.12, 0, 0);
  }
  c.closePath();
}

/**
 * One leaf: base->tip gradient, darker shaded half (fold), soft highlight,
 * midrib and a few low-contrast secondary veins (large enough not to alias).
 */
function leaf(P, x, y, ang, len, wid, shape, col, o = {}) {
  const [h, s, l] = col;
  both(P, (c, isA) => {
    c.save(); c.translate(x, y); c.rotate(ang);
    if (o.petiole) {
      c.strokeStyle = isA ? '#fff' : hsl(h - 8, s * 0.75, l * 0.85); c.lineWidth = Math.max(2.5, wid * 0.14); c.lineCap = 'round';
      c.beginPath(); c.moveTo(-o.petiole, 0); c.lineTo(1, 0); c.stroke();
    }
    c.beginPath(); leafPath(c, len, wid, shape);
    if (isA) { c.fillStyle = '#fff'; c.fill(); c.restore(); return; }
    const g = c.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, hsl(h, s, l * 0.9)); g.addColorStop(0.55, hsl(h, s, l)); g.addColorStop(1, hsl(h - 2, s * 0.96, l * 1.05));
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    // gentle folded shading without harsh high-frequency vein lines
    const g2 = c.createLinearGradient(0, -wid, 0, wid);
    g2.addColorStop(0, 'rgba(0,0,0,0.08)'); g2.addColorStop(0.48, 'rgba(0,0,0,0.02)'); g2.addColorStop(0.52, 'rgba(255,255,230,0.02)'); g2.addColorStop(1, 'rgba(255,255,230,0.0)');
    c.fillStyle = g2; c.fillRect(-2, -wid * 1.4, len + 4, wid * 2.8);
    if (o.veins && o.veinColor) {
      c.strokeStyle = o.veinColor; c.lineWidth = o.veinWidth || 1.8;
      for (let k = 1; k <= o.veins; k++) {
        const t = k / (o.veins + 1);
        for (const sg of [-1, 1]) { c.beginPath(); c.moveTo(len * t, 0); c.quadraticCurveTo(len * t + wid * 0.3, sg * wid * 0.35, len * t + wid * 0.58, sg * wid * 0.68); c.stroke(); }
      }
    }
    c.restore();
    if (o.midrib !== 'rgba(0,0,0,0)') {
      c.strokeStyle = o.midrib || hsl(h - 10, s * 0.65, Math.min(48, l * 1.15), 0.25); c.lineWidth = Math.max(1.4, wid * 0.06);
      c.beginPath(); c.moveTo(2, 0); c.quadraticCurveTo(len * 0.45, wid * 0.02, len * 0.82, 0); c.stroke();
    }
    c.restore();
  });
}

function twig(P, pts, w0, w1, color) {
  both(P, (c, isA) => {
    c.strokeStyle = isA ? '#fff' : color; c.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      c.lineWidth = w0 + (w1 - w0) * (i / (pts.length - 1));
      c.beginPath(); c.moveTo(pts[i - 1][0], pts[i - 1][1]); c.lineTo(pts[i][0], pts[i][1]); c.stroke();
    }
  });
}
function blob(P, x, y, rx, ry, rot, color) {
  both(P, (c, isA) => { c.fillStyle = isA ? '#fff' : color; c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); c.fill(); });
}

function tile(P, name, bleed, draw, inset = 12, pad = 16) {
  const [x, y, w, h] = TILES[name];
  P.c.fillStyle = bleed; P.c.fillRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);   // bleed colour into half the gutter (alpha stays 0)
  for (const c of [P.c, P.a]) { c.save(); c.beginPath(); c.rect(x + inset, y + inset, w - 2 * inset, h - 2 * inset); c.clip(); c.translate(x, y); }
  draw(w, h);
  P.c.restore(); P.a.restore();
}

/**
 * Dense, self-contained 3D botanical leaf pad:
 * - Concentric rings of overlapping leaves (shaded outer/lower ring, lush mid ring, sunlit crown hub)
 * - Strictly bounded inside a safe margin from the tile border so zero leaves are ever guillotined
 * - Solid leaf coverage across the center and lower half so clusters never show empty gaps or floating twigs
 */
function cluster(P, name, o) {
  const r = rng(o.seed);
  tile(P, name, o.bleed, (w, h) => {
    const cx = w * 0.5, cy = h * 0.52;
    const maxR = Math.min(w, h) * 0.43; // safe radius inside tile so leaf tips never touch clip border
    const leaves = [];
    // Outer/lower ring (deep shaded under-leaves)
    const nOuter = Math.round(o.count * 0.48);
    for (let i = 0; i < nOuter; i++) {
      const ang = (i / nOuter) * Math.PI * 2 + (r() - 0.5) * 0.28;
      const baseOff = maxR * (0.06 + r() * 0.12);
      const len = Math.min(maxR - baseOff, o.len[0] + r() * (o.len[1] - o.len[0]));
      const wid = o.wid[0] + r() * (o.wid[1] - o.wid[0]);
      leaves.push({
        x: cx + Math.cos(ang) * baseOff,
        y: cy + Math.sin(ang) * baseOff,
        ang: ang + (r() - 0.5) * 0.22,
        len, wid, depth: 0.05 + r() * 0.35,
      });
    }
    // Mid ring (full overlapping body leaves)
    const nMid = Math.round(o.count * 0.36);
    for (let i = 0; i < nMid; i++) {
      const ang = ((i + 0.5) / nMid) * Math.PI * 2 + (r() - 0.5) * 0.32;
      const baseOff = maxR * (0.03 + r() * 0.09);
      const len = Math.min(maxR * 0.86 - baseOff, (o.len[0] + r() * (o.len[1] - o.len[0])) * 0.86);
      const wid = (o.wid[0] + r() * (o.wid[1] - o.wid[0])) * 0.94;
      leaves.push({
        x: cx + Math.cos(ang) * baseOff,
        y: cy + Math.sin(ang) * baseOff,
        ang: ang + (r() - 0.5) * 0.28,
        len, wid, depth: 0.42 + r() * 0.32,
      });
    }
    // Inner crown hub (sunlit top leaves sealing the center)
    const nInner = Math.max(6, o.count - nOuter - nMid);
    for (let i = 0; i < nInner; i++) {
      const ang = (i / nInner) * Math.PI * 2 + r() * 0.45;
      const len = Math.min(maxR * 0.62, o.len[0] * (0.62 + r() * 0.16));
      const wid = o.wid[0] * (0.85 + r() * 0.15);
      leaves.push({
        x: cx + (r() - 0.5) * 10,
        y: cy + (r() - 0.5) * 10,
        ang, len, wid, depth: 0.76 + r() * 0.24,
      });
    }
    leaves.sort((a, b) => a.depth - b.depth);
    for (const lf of leaves) {
      const c = o.color(r, lf.depth);
      leaf(P, lf.x, lf.y, lf.ang, lf.len, lf.wid, o.shape, c,
        { veins: o.veins, petiole: o.petiole, veinColor: o.veinColor, midrib: o.midrib });
    }
  }, 10, 16);
}

function speckle(c, x, y, w, h, n, colors, r) {
  for (let i = 0; i < n; i++) { c.fillStyle = colors[Math.floor(r() * colors.length)]; c.fillRect(x + r() * w, y + r() * h, 1 + r() * 2, 1 + r() * 2); }
}

// coconut frond strip for mid/far LOD: dense overlapping leaflets + solid inner pinnae web so distant palms stay full
function paintFrond(P, name, dry, seed) {
  const r = rng(seed);
  const [, , W, H] = TILES[name];
  tile(P, name, hsl(94, 40, 25), () => {
    const cy = H / 2, x0 = 12, x1 = W - 12;
    both(P, (c, isA) => {
      c.beginPath();
      for (let i = 0; i <= 48; i++) {
        const t = i / 48, x = x0 + t * (x1 - x0);
        const hw = (H / 2 - 14) * frondProfile(t) * 0.46;
        i ? c.lineTo(x, cy - hw) : c.moveTo(x, cy - hw);
      }
      for (let i = 48; i >= 0; i--) {
        const t = i / 48, x = x0 + t * (x1 - x0);
        const hw = (H / 2 - 14) * frondProfile(t) * 0.46;
        c.lineTo(x, cy + hw);
      }
      c.closePath();
      c.fillStyle = isA ? '#fff' : hsl(94, 42, 27);
      c.fill();
    });
    const n = 58;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.25 + r() * 0.35) / n;
      const xb = x0 + t * (x1 - x0) * 0.985;
      for (const s of [-1, 1]) {
        const reach = (H / 2 - 8) * frondProfile(t) * jit(r, 0.97, 0.03);
        const fwd = (210 + r() * 40) * (0.48 + 0.52 * frondProfile(t));
        const bw = 19 + r() * 5;
        const hue = jit(r, 94, 4), sat = jit(r, 42, 5);
        const lit = jit(r, 29, 3) + t * 4;
        both(P, (c, isA) => {
          c.beginPath();
          c.moveTo(xb - bw * 0.55, cy);
          c.quadraticCurveTo(xb + fwd * 0.42, cy + s * reach * 0.64, xb + fwd, cy + s * reach);
          c.quadraticCurveTo(xb + fwd * 0.5 + bw, cy + s * reach * 0.58, xb + bw * 0.85, cy);
          c.closePath();
          if (isA) { c.fillStyle = '#fff'; c.fill(); return; }
          const g = c.createLinearGradient(xb, cy, xb + fwd, cy + s * reach);
          g.addColorStop(0, hsl(hue, sat, lit * 0.86)); g.addColorStop(0.65, hsl(hue, sat, lit)); g.addColorStop(1, hsl(hue - 4, sat, lit * 1.06));
          c.fillStyle = g; c.fill();
        });
      }
    }
    both(P, (c, isA) => {
      for (let k = 0; k < 40; k++) {
        const t0 = k / 40;
        c.strokeStyle = isA ? '#fff' : hsl(74, 36, 35 - t0 * 5);
        c.lineWidth = 11 * (1 - t0) + 4;
        c.beginPath(); c.moveTo(x0 + t0 * (x1 - x0), cy); c.lineTo(x0 + (k + 1) / 40 * (x1 - x0), cy); c.stroke();
      }
    });
  }, 4, 12);
}

// single coconut leaflet for the near-LOD geometric fronds (pure lush green)
function paintLeaflet(P, name) {
  tile(P, name, hsl(94, 40, 28), (w, h) => {
    const cy = h / 2, x0 = 3, x1 = w - 3;
    const hw = (t) => (h / 2 - 3) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.92)), 0.45) * (t < 0.1 ? 0.72 + t * 2.8 : 1);
    both(P, (c, isA) => {
      c.beginPath();
      for (let i = 0; i <= 40; i++) { const t = i / 40; const x = x0 + t * (x1 - x0); i ? c.lineTo(x, cy - hw(t)) : c.moveTo(x, cy - hw(t)); }
      for (let i = 40; i >= 0; i--) { const t = i / 40; c.lineTo(x0 + t * (x1 - x0), cy + hw(t)); }
      c.closePath();
      if (isA) { c.fillStyle = '#fff'; c.fill(); return; }
      const g = c.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, hsl(96, 42, 25)); g.addColorStop(0.7, hsl(92, 42, 31)); g.addColorStop(1, hsl(84, 40, 35));
      c.fillStyle = g; c.fill();
      c.save(); c.clip();
      c.fillStyle = 'rgba(0,0,0,0.08)'; c.fillRect(0, 0, w, cy);
      c.restore();
    });
  }, 2);
}

function strapLeaf(P, y0, bandH, w, o) {
  const cy = y0 + bandH / 2;
  both(P, (c, isA) => {
    c.beginPath();
    const N = 40;
    for (let i = 0; i <= N; i++) { const t = i / N; const x = 6 + t * (w - 12); const hw = o.hw(t); i ? c.lineTo(x, cy - hw) : c.moveTo(x, cy - hw); }
    for (let i = N; i >= 0; i--) { const t = i / N; c.lineTo(6 + t * (w - 12), cy + o.hw(t)); }
    c.closePath();
    if (isA) { c.fillStyle = '#fff'; c.fill(); return; }
    const g = c.createLinearGradient(0, cy - bandH / 2, 0, cy + bandH / 2);
    g.addColorStop(0, o.edge); g.addColorStop(0.5, o.mid); g.addColorStop(1, o.edge);
    c.fillStyle = g; c.fill();
    c.strokeStyle = 'rgba(200,215,175,0.16)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(6, cy); c.lineTo(w - 12, cy); c.stroke();
  });
}

// ---------------------------------------------------------------------------
export function buildAtlas(maxAniso = 4) {
  const cc = document.createElement('canvas'), ac = document.createElement('canvas');
  cc.width = ac.width = ATLAS_W; cc.height = ac.height = ATLAS_H;
  const P = { c: cc.getContext('2d'), a: ac.getContext('2d') };
  P.a.fillStyle = '#000'; P.a.fillRect(0, 0, ATLAS_W, ATLAS_H);
  P.c.fillStyle = hsl(98, 34, 24); P.c.fillRect(0, 0, ATLAS_W, ATLAS_H);

  paintFrond(P, 'frond', false, 11);
  paintFrond(P, 'frondDry', false, 12);
  paintLeaflet(P, 'leaflet', false);
  paintLeaflet(P, 'leafletDry', false);

  // cohesive, pure tropical greens with rich 3D depth shading (zero brown/orange blotches)
  const green = (h0, h1, s0, l0, l1) => (r, d) => [h0 + r() * (h1 - h0), s0 + (r() - 0.5) * 5, (l0 + r() * (l1 - l0)) * (0.82 + 0.24 * d)];
  cluster(P, 'mango', { seed: 21, bleed: hsl(106, 38, 22), count: 38,
    len: [155, 195], wid: [48, 62], shape: 'lance',
    color: green(102, 112, 40, 21, 28) });
  cluster(P, 'mangoB', { seed: 22, bleed: hsl(100, 36, 23), count: 40,
    len: [150, 190], wid: [46, 60], shape: 'lance',
    color: green(96, 108, 40, 22, 30) });
  // rain tree: lush full compound-leaf rosette pad (no bare sticks or clipped edges)
  cluster(P, 'fine', { seed: 31, bleed: hsl(98, 38, 23), count: 44,
    len: [145, 185], wid: [52, 66], shape: 'ovate',
    color: green(94, 106, 40, 22, 30) });
  // Indian almond (Terminalia): lush rosette of large obovate green leaves (zero orange/brown spots)
  cluster(P, 'almond', { seed: 33, bleed: hsl(102, 38, 23), count: 32,
    len: [160, 198], wid: [64, 78], shape: 'obovate', petiole: 10,
    color: green(98, 108, 40, 23, 30) });
  cluster(P, 'shrub', { seed: 41, bleed: hsl(104, 38, 21), count: 42,
    len: [135, 175], wid: [52, 66], shape: 'ovate',
    color: green(100, 112, 38, 21, 28) });
  cluster(P, 'round', { seed: 42, bleed: hsl(96, 36, 24), count: 36,
    len: [140, 180], wid: [60, 74], shape: 'round', petiole: 8,
    color: green(90, 100, 38, 24, 31) });
  // croton: vibrant tropical emerald and warm lime-gold variegated foliage (no dead brown)
  cluster(P, 'croton', { seed: 43, bleed: hsl(90, 40, 24), count: 28,
    len: [54, 70], wid: [22, 28], shape: 'oblong', veins: 3, petiole: 4,
    veinColor: 'rgba(185,215,90,0.32)', veinWidth: 1.5, midrib: 'rgba(185,215,90,0.42)',
    color: (r, d) => (r() < 0.32 ? [jit(r, 76, 6), 46, 30 * (0.85 + 0.2 * d)] : [jit(r, 100, 5), 40, 24 * (0.85 + 0.2 * d)]) });
  // fern: full radial fern frond pad bounded strictly within the tile
  {
    const r = rng(45);
    tile(P, 'fern', hsl(98, 38, 24), (w, h) => {
      const cx = w / 2, cy = h * 0.56;
      const nFronds = 14;
      for (let k = 0; k < nFronds; k++) {
        const a = (k / nFronds) * Math.PI * 2 + (r() - 0.5) * 0.18;
        const len = 175 + r() * 35;
        const pairs = 12, hue = jit(r, 98, 4), lit = jit(r, 27, 3);
        twig(P, [[cx, cy], [cx + Math.cos(a) * len, cy + Math.sin(a) * len]], 4, 1.5, hsl(88, 34, 26));
        for (let i = 1; i <= pairs; i++) {
          const t = i / (pairs + 1), pl = 48 * (1 - t * 0.72) + 14;
          const px = cx + Math.cos(a) * len * t, py = cy + Math.sin(a) * len * t;
          for (const s of [-1, 1]) leaf(P, px, py, a + s * 1.05, pl, Math.max(9, pl * 0.42), 'lance', [hue, 42, lit], { midrib: 'rgba(0,0,0,0)' });
        }
      }
    }, 10, 16);
  }
  // banana leaf: lush continuous tropical blade (no harsh black cuts that create floating fragments)
  {
    tile(P, 'banana', hsl(88, 38, 30), (w, h) => {
      const cy = h / 2, x0 = 14, x1 = w - 14;
      const hw = (t) => (h / 2 - 14) * Math.pow(Math.max(0, Math.sin(Math.PI * (0.03 + 0.95 * t))), 0.35);
      both(P, (c, isA) => {
        c.beginPath();
        for (let i = 0; i <= 80; i++) { const t = i / 80; const x = x0 + t * (x1 - x0); i ? c.lineTo(x, cy - hw(t)) : c.moveTo(x, cy - hw(t)); }
        for (let i = 80; i >= 0; i--) { const t = i / 80; c.lineTo(x0 + t * (x1 - x0), cy + hw(t)); }
        c.closePath();
        if (isA) { c.fillStyle = '#fff'; c.fill(); return; }
        const g = c.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, hsl(92, 42, 26)); g.addColorStop(0.6, hsl(88, 42, 32)); g.addColorStop(1, hsl(82, 38, 35));
        c.fillStyle = g; c.fill();
        c.save(); c.clip();
        c.fillStyle = 'rgba(0,0,0,0.08)'; c.fillRect(0, 0, w, cy);
        c.restore();
      });
      both(P, (c, isA) => { c.strokeStyle = isA ? '#fff' : hsl(72, 36, 42); c.lineWidth = 8; c.beginPath(); c.moveTo(x0, cy); c.lineTo(x1, cy); c.stroke(); });
    });
  }
  // strap leaves: pandanus x2, lily x2
  tile(P, 'strap', hsl(116, 28, 25), (w, h) => {
    const bh = h / 4;
    strapLeaf(P, 0, bh, w, { hw: (t) => 16 * (1 - t * 0.82) + 3, edge: hsl(118, 32, 25), mid: hsl(110, 36, 33) });
    strapLeaf(P, bh, bh, w, { hw: (t) => 14 * (1 - t * 0.78) + 3, edge: hsl(112, 32, 25), mid: hsl(106, 36, 33) });
    strapLeaf(P, bh * 2, bh, w, { hw: (t) => 19 * Math.pow(Math.sin(Math.PI * (0.02 + 0.96 * t)), 0.35), edge: hsl(100, 38, 24), mid: hsl(96, 42, 32) });
    strapLeaf(P, bh * 3, bh, w, { hw: (t) => 16 * Math.pow(Math.sin(Math.PI * (0.02 + 0.96 * t)), 0.4), edge: hsl(104, 36, 23), mid: hsl(98, 38, 30) });
  }, 4);
  cluster(P, 'litter', { seed: 47, bleed: hsl(100, 36, 22), count: 24,
    len: [64, 88], wid: [28, 38], shape: 'ovate',
    color: green(96, 108, 38, 20, 26) });
  // far grass card
  {
    const r = rng(46);
    tile(P, 'grassCard', hsl(88, 32, 26), (w, h) => {
      for (let k = 0; k < 40; k++) {
        const bx = w / 2 + (r() - 0.5) * 120, len = 120 + r() * 110, lean = (r() - 0.5) * 110, bw = 5 + r() * 3;
        both(P, (c, isA) => {
          c.beginPath(); c.moveTo(bx - bw, h - 10); c.quadraticCurveTo(bx + lean * 0.3, h - len * 0.6, bx + lean, h - len);
          c.quadraticCurveTo(bx + lean * 0.3 + bw * 0.6, h - len * 0.6, bx + bw, h - 10); c.closePath();
          if (isA) { c.fillStyle = '#fff'; c.fill(); return; }
          const g = c.createLinearGradient(0, h, 0, h - len);
          g.addColorStop(0, hsl(95, 36, 18)); g.addColorStop(1, hsl(jit(r, 82, 5), 38, jit(r, 36, 4)));
          c.fillStyle = g; c.fill();
        });
      }
    });
  }
  // plain (solid geometry tinted by vertex colour: coconuts, stems, rachis, grass blades)
  {
    const [x, y, w, h] = TILES.plain;
    P.c.fillStyle = '#d8d8d4'; P.c.fillRect(x - 16, y - 16, w + 32, h + 32);
    P.a.fillStyle = '#fff'; P.a.fillRect(x, y, w, h);
  }

  // ---- bark strips (realistic fibrous coconut cortex & longitudinally fissured hardwood bark) ----
  {
    const r = rng(51);
    const [x, , w] = TILES.palmBark;
    const c = P.c;
    c.save(); c.beginPath(); c.rect(x - 4, 0, w + 8, ATLAS_H); c.clip();
    c.fillStyle = hsl(33, 14, 52); c.fillRect(x - 4, 0, w + 8, ATLAS_H);
    // Vertical fibrous cortex striations
    for (let k = 0; k < 340; k++) {
      const fx = x - 2 + r() * (w + 4), fy = r() * ATLAS_H, fl = 45 + r() * 110;
      c.strokeStyle = r() < 0.5 ? 'rgba(92,78,62,0.16)' : 'rgba(215,205,188,0.15)';
      c.lineWidth = 1.0 + r() * 1.4;
      c.beginPath();
      for (const dy of [-ATLAS_H, 0, ATLAS_H]) {
        c.moveTo(fx, fy + dy); c.lineTo(fx + (r() - 0.5) * 1.5, fy + dy + fl);
      }
      c.stroke();
    }
    // Subtle weathered patches along the trunk
    for (let k = 0; k < 75; k++) {
      const px = x + r() * w, py = r() * ATLAS_H, rw = 10 + r() * 18, rh = 28 + r() * 65;
      c.fillStyle = r() < 0.55 ? 'rgba(195,186,170,0.10)' : 'rgba(82,70,56,0.10)';
      for (const dy of [-ATLAS_H, 0, ATLAS_H]) {
        c.beginPath(); c.ellipse(px, py + dy, rw, rh, 0, 0, Math.PI * 2); c.fill();
      }
    }
    // Restrained, natural leaf-scar rings (26 thin weathered scars instead of heavy black snake bands)
    const rings = 26;
    for (let i = 0; i < rings; i++) {
      const y = ((i + 0.5) / rings) * ATLAS_H + (r() - 0.5) * 10;
      const g = c.createLinearGradient(0, y - 5, 0, y + 9);
      g.addColorStop(0, 'rgba(215,205,188,0.0)');
      g.addColorStop(0.28, 'rgba(218,208,192,0.22)');
      g.addColorStop(0.52, 'rgba(76,64,50,0.28)');
      g.addColorStop(0.75, 'rgba(95,82,66,0.14)');
      g.addColorStop(1, 'rgba(95,82,66,0.0)');
      c.fillStyle = g;
      c.beginPath(); c.moveTo(x - 4, y - 5);
      const ph = r() * Math.PI * 2;
      for (let dx = 0; dx <= w + 8; dx += 4) {
        c.lineTo(x - 4 + dx, y - 5 + Math.sin(((dx - 4) / w) * Math.PI * 2 + ph) * 1.4);
      }
      c.lineTo(x + w + 4, y + 9); c.lineTo(x - 4, y + 9); c.fill();
    }
    c.restore();
  }
  {
    const r = rng(52);
    const [x, , w] = TILES.treeBark;
    const c = P.c;
    c.save(); c.beginPath(); c.rect(x - 4, 0, w + 8, ATLAS_H); c.clip();
    c.fillStyle = hsl(28, 15, 38); c.fillRect(x - 4, 0, w + 8, ATLAS_H);
    // Longitudinal bark plates (soft vertical slabs, tiled seamlessly in Y)
    for (let k = 0; k < 180; k++) {
      const px = x - 2 + r() * (w + 4), py = r() * ATLAS_H, pw = 4 + r() * 9, ph = 55 + r() * 140;
      c.fillStyle = r() < 0.5 ? 'rgba(165,148,126,0.11)' : 'rgba(48,38,28,0.12)';
      for (const dy of [-ATLAS_H, 0, ATLAS_H]) {
        c.fillRect(px - pw * 0.5, py + dy, pw, ph);
      }
    }
    // Fine vertical wood/bark fibers
    for (let k = 0; k < 420; k++) {
      const fx = x + 2 + r() * (w - 4), fy = r() * ATLAS_H, fl = 35 + r() * 95;
      const drift = (r() - 0.5) * 2.2;
      const dark = r() < 0.58;
      c.strokeStyle = dark ? 'rgba(38,29,21,0.24)' : 'rgba(178,162,140,0.16)';
      c.lineWidth = dark ? 1.2 + r() * 1.3 : 1.0 + r() * 1.0;
      c.beginPath();
      for (const dy of [-ATLAS_H, 0, ATLAS_H]) {
        c.moveTo(fx, fy + dy);
        c.quadraticCurveTo(fx + drift * 0.5, fy + dy + fl * 0.5, fx + drift, fy + dy + fl);
      }
      c.stroke();
    }
    // Subtle vertical bark fissures with adjacent highlight ridge (strictly bounded inside strip so zero wrap slashes)
    for (let k = 0; k < 65; k++) {
      const fx = x + 5 + r() * (w - 10), fy = r() * ATLAS_H, fl = 70 + r() * 160;
      const midDrift = (r() - 0.5) * 3.0, endDrift = (r() - 0.5) * 3.0;
      for (const dy of [-ATLAS_H, 0, ATLAS_H]) {
        c.strokeStyle = 'rgba(28,21,15,0.34)';
        c.lineWidth = 1.6 + r() * 1.2;
        c.beginPath();
        c.moveTo(fx, fy + dy);
        c.quadraticCurveTo(fx + midDrift, fy + dy + fl * 0.5, fx + endDrift, fy + dy + fl);
        c.stroke();
        c.strokeStyle = 'rgba(182,166,144,0.14)';
        c.lineWidth = 1.0;
        c.beginPath();
        c.moveTo(fx + 1.5, fy + dy);
        c.quadraticCurveTo(fx + midDrift + 1.5, fy + dy + fl * 0.5, fx + endDrift + 1.5, fy + dy + fl);
        c.stroke();
      }
    }
    c.restore();
  }
  for (const k of ['palmBark', 'treeBark']) { const [x, , w] = TILES[k]; P.a.fillStyle = '#fff'; P.a.fillRect(x - 2, 0, w + 4, ATLAS_H); }

  // ---- merge + edge RGB dilation (prevents any border fringing at leaf cutouts) ----
  const col = P.c.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const alp = P.a.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const solid = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let p = 0, i = 0; i < data.length; p++, i += 4) {
    const a = alp[i];
    data[i] = col[i]; data[i + 1] = col[i + 1]; data[i + 2] = col[i + 2]; data[i + 3] = a;
    if (a >= 230) solid[p] = 1;
  }
  // Propagate interior opaque leaf RGB outward into semi-transparent/transparent border texels
  const nextSolid = new Uint8Array(solid);
  const dirs = [-1, 1, -ATLAS_W, ATLAS_W];
  for (let pass = 0; pass < 6; pass++) {
    nextSolid.set(solid);
    for (let y = 1; y < ATLAS_H - 1; y++) {
      const row = y * ATLAS_W;
      for (let x = 1; x < ATLAS_W - 1; x++) {
        const p = row + x;
        if (solid[p]) continue;
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let d = 0; d < 4; d++) {
          const np = p + dirs[d];
          if (solid[np]) {
            const ni = np * 4;
            sr += data[ni]; sg += data[ni + 1]; sb += data[ni + 2]; n++;
          }
        }
        if (n > 0) {
          const pi = p * 4;
          data[pi] = (sr / n) | 0; data[pi + 1] = (sg / n) | 0; data[pi + 2] = (sb / n) | 0;
          nextSolid[p] = 1;
        }
      }
    }
    solid.set(nextSolid);
  }

  const tex = new THREE.DataTexture(data, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

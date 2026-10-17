import * as THREE from 'three';
import { rng } from './geom.js';
import { makeSurfaces } from './surfaces.js';

// Procedural canvas textures. Small (256-1024px) and generated once at load so the
// scene needs no binary assets yet; swap for authored textures later.

let maxAniso = 4;
export const setMaxAnisotropy = (a) => { maxAniso = a; };

function tex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = maxAniso;
  return t;
}

function noise(ctx, w, h, n, colors, sizeMin, sizeMax, seed) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = sizeMin + r() * (sizeMax - sizeMin);
    ctx.globalAlpha = 0.25 + r() * 0.5;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
  ctx.globalAlpha = 1;
}

export function makeTextures() {
  const T = {};

  T.planks = tex(512, 512, (c, w, h) => {
    const r = rng(11);
    const ph = 32;
    for (let y = 0; y < h; y += ph) {
      const l = 0.8 + r() * 0.3;
      c.fillStyle = `rgb(${Math.floor(140 * l)},${Math.floor(98 * l)},${Math.floor(62 * l)})`;
      c.fillRect(0, y, w, ph);
      c.fillStyle = 'rgba(40,25,15,0.7)'; c.fillRect(0, y, w, 2);
      for (let k = 0; k < 6; k++) {
        c.fillStyle = 'rgba(60,40,25,0.25)';
        c.fillRect(0, y + 4 + r() * (ph - 8), w, 1);
      }
      const jx = r() * w; c.fillStyle = 'rgba(40,25,15,0.7)'; c.fillRect(jx, y, 2, ph);
    }
  });

  T.roofTiles = tex(256, 256, (c, w, h) => {
    c.fillStyle = '#8e3b26'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      for (let x = 0; x < w; x += 16) {
        const g = c.createLinearGradient(x, y, x + 16, y);
        g.addColorStop(0, '#a8492c'); g.addColorStop(0.5, '#c25f3a'); g.addColorStop(1, '#7a3020');
        c.fillStyle = g; c.fillRect(x + ((y / 16) % 2) * 8, y, 15, 14);
      }
    }
  });

  T.trackBed = tex(256, 256, (c, w, h) => {
    c.fillStyle = '#77736c'; c.fillRect(0, 0, w, h);
    noise(c, w, h, 3000, ['#5f5b55', '#8b867e'], 1, 3, 12);
    c.fillStyle = '#9c968c';
    for (let x = 0; x < w; x += 32) c.fillRect(x + 4, 0, 14, h);
  });

  T.solar = tex(256, 256, (c, w, h) => {
    c.fillStyle = '#c8ccd0'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 64) for (let x = 0; x < w; x += 128) {
      const g = c.createLinearGradient(x, y, x + 120, y + 60);
      g.addColorStop(0, '#1d3a6b'); g.addColorStop(1, '#2f5b96');
      c.fillStyle = g; c.fillRect(x + 3, y + 3, 122, 58);
      c.strokeStyle = 'rgba(180,200,230,0.35)'; c.lineWidth = 1;
      for (let k = 1; k < 6; k++) { c.beginPath(); c.moveTo(x + 3 + k * 20, y + 3); c.lineTo(x + 3 + k * 20, y + 61); c.stroke(); }
      c.beginPath(); c.moveTo(x + 3, y + 32); c.lineTo(x + 125, y + 32); c.stroke();
    }
  });

  // Facade tile: one bay (u) x one floor (v).
  const windowTile = (wall, glassTop, glassBot, frame, seed, opts = {}) => tex(256, 256, (c, w, h) => {
    c.fillStyle = wall; c.fillRect(0, 0, w, h);
    noise(c, w, h, 700, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)'], 1, 3, seed);
    const x0 = opts.x0 ?? 40, x1 = opts.x1 ?? 216, y0 = opts.y0 ?? 50, y1 = opts.y1 ?? 200;
    c.fillStyle = frame; c.fillRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
    const g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, glassTop); g.addColorStop(1, glassBot);
    c.fillStyle = g; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.fillStyle = frame; c.fillRect((x0 + x1) / 2 - 3, y0, 6, y1 - y0);
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.beginPath(); c.moveTo(x0, y1); c.lineTo(x0 + 50, y0); c.lineTo(x0 + 80, y0); c.lineTo(x0 + 30, y1); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x0 - 8, y1 + 6, x1 - x0 + 16, 6);
  });
  T.aptFacade = windowTile('#e9dcc4', '#5f8aa0', '#2c4656', '#6b4a33', 13);
  T.grafFacade = windowTile('#d9d6cf', '#7d97a6', '#33434d', '#4a4a4a', 14, { x0: 60, x1: 196 });
  T.whiteWall = windowTile('#efe9dc', '#efe9dc', '#efe9dc', '#efe9dc', 15, { x0: 0, x1: 0, y0: 0, y1: 0 });

  T.glass = tex(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#9fd3d8'); g.addColorStop(0.5, '#4f8e9e'); g.addColorStop(1, '#2d5f72');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.beginPath(); c.moveTo(0, h); c.lineTo(90, 0); c.lineTo(140, 0); c.lineTo(50, h); c.fill();
    c.strokeStyle = '#d7dde0'; c.lineWidth = 8; c.strokeRect(0, 0, w, h);
    c.lineWidth = 4; c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
  });
  T.glassClear = tex(128, 256, (c, w, h) => {
    c.fillStyle = 'rgba(160,215,220,0.35)'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(225,232,235,1)'; c.lineWidth = 6; c.strokeRect(0, 0, w, h);
  });

  T.shopfront = tex(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f6cf8a'); g.addColorStop(1, '#a8682e');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(70,40,20,0.55)';
    for (let i = 0; i < 4; i++) c.fillRect(20 + i * 60, 150, 40, 50);   // tables/chairs silhouettes
    c.fillStyle = 'rgba(255,240,200,0.8)';
    for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(45 + i * 80, 30, 8, 0, 7); c.fill(); }
    c.strokeStyle = '#2b2622'; c.lineWidth = 10; c.strokeRect(0, 0, w, h);
    c.lineWidth = 6; c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
  });

  T.mural = tex(1024, 1536, (c, w, h) => {
    c.fillStyle = '#ecebe6'; c.fillRect(0, 0, w, h);
    // background brush texture
    const r = rng(31);
    c.globalAlpha = 0.08;
    for (let i = 0; i < 260; i++) {
      c.strokeStyle = r() > 0.5 ? '#000' : '#666'; c.lineWidth = 2 + r() * 10;
      c.beginPath(); const x = r() * w, y = r() * h; c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 200, y + (r() - 0.5) * 200); c.stroke();
    }
    c.globalAlpha = 1;
    // stylised portrait (graphic black & white stencil)
    c.save(); c.translate(430, 820);
    c.fillStyle = '#111';
    c.beginPath(); c.ellipse(0, -80, 330, 420, 0, 0, 7); c.fill();           // hair mass
    c.beginPath(); c.ellipse(-20, -330, 170, 110, 0.1, 0, 7); c.fill();        // bun
    c.fillStyle = '#d9d6cf';
    c.beginPath(); c.ellipse(10, 20, 230, 300, 0.05, 0, 7); c.fill();          // face
    c.fillStyle = '#7d7a73';
    c.beginPath(); c.ellipse(120, 60, 110, 230, 0.05, 0, 7); c.fill();         // cheek shadow
    c.fillStyle = '#111';
    c.beginPath(); c.moveTo(-230, -120); c.quadraticCurveTo(0, -260, 240, -110); c.quadraticCurveTo(0, -190, -230, -120); c.fill(); // hairline
    for (const ex of [-90, 100]) {                                             // eyes & brows
      c.beginPath(); c.ellipse(ex, -30, 58, 22, 0, 0, 7); c.fill();
      c.fillStyle = '#ecebe6'; c.beginPath(); c.ellipse(ex - 8, -34, 12, 8, 0, 0, 7); c.fill(); c.fillStyle = '#111';
      c.fillRect(ex - 70, -92, 140, 16);
    }
    c.lineWidth = 12; c.strokeStyle = '#111';
    c.beginPath(); c.moveTo(10, -20); c.lineTo(-10, 110); c.lineTo(30, 120); c.stroke();     // nose
    c.beginPath(); c.moveTo(-70, 190); c.quadraticCurveTo(10, 230, 90, 190); c.quadraticCurveTo(10, 205, -70, 190); c.fill(); // lips
    c.beginPath(); c.arc(10, -150, 14, 0, 7); c.fill();                                     // pottu
    c.fillStyle = '#111'; c.beginPath(); c.moveTo(-200, 260); c.quadraticCurveTo(10, 420, 220, 260); c.lineTo(300, 700); c.lineTo(-300, 700); c.fill(); // neck & shoulders
    c.fillStyle = '#d9d6cf'; c.beginPath(); c.moveTo(-110, 330); c.lineTo(110, 330); c.lineTo(150, 700); c.lineTo(-150, 700); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 8;
    for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(0, 380 + i * 12, 120 + i * 6, 0.2, Math.PI - 0.2); c.stroke(); } // necklace
    c.restore();
    // lettering
    c.fillStyle = '#111';
    c.font = '900 170px Impact, "Arial Black", sans-serif';
    c.textAlign = 'right';
    c.fillText('KOCHI', w - 40, 200);
    c.fillText('VIBES', w - 40, 370);
    c.strokeStyle = '#111'; c.lineWidth = 3; c.strokeRect(14, 14, w - 28, h - 28);
  }, { repeat: false });

  T.signTea = tex(1024, 128, (c, w, h) => {
    c.fillStyle = '#26221f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f3e7d0'; c.font = '700 78px "Trebuchet MS", Arial, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('TEA  &  SNACKS', w / 2, h / 2 + 4);
  }, { repeat: false });

  T.signMetro = tex(256, 256, (c, w, h) => {
    c.fillStyle = '#1aa6a6'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.font = '900 200px Arial, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('M', w / 2, h / 2 + 12);
  }, { repeat: false });

  T.busSide = tex(512, 128, (c, w, h) => {
    c.fillStyle = '#f2f2ee'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f6fb5'; c.fillRect(0, 78, w, 50);
    c.fillStyle = '#1b2733';
    for (let x = 18; x < w - 20; x += 62) c.fillRect(x, 16, 54, 46);
    c.fillStyle = '#7fc1e8'; c.fillRect(0, 70, w, 6);
  }, { repeat: false });

  T.trainSide = tex(512, 128, (c, w, h) => {
    c.fillStyle = '#e8edf1'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1f4e9a'; c.fillRect(0, 84, w, 44);
    c.fillStyle = '#2bb3b1'; c.fillRect(0, 78, w, 6);
    c.fillStyle = '#18222e';
    for (let x = 14; x < w; x += 84) c.fillRect(x, 20, 60, 46);
    c.fillStyle = '#3a4a5a';
    for (const x of [96, 330]) c.fillRect(x, 16, 40, 100);
  }, { repeat: false });

  // high-quality height-field surfaces (albedo + normal) replace the simple ground textures
  Object.assign(T, makeSurfaces(maxAniso));
  return T;
}

import * as THREE from 'three';
import { pointInPolys } from '../geom.js';
import { G, WALK, GREEN_TOP, APARTMENT, GRAFFITI, CAFE, SHOP, PAVILION } from '../layout.js';
import { fbm } from '../world/coastField.js';
import { atmoUniforms } from './atmoShared.js';
import { makeRng } from './weather.js';

// ---------------------------------------------------------------------------
// Urban flood: a shallow-water "virtual pipe" simulation on a grid sampled from
// the island's real walkable surfaces (roads 1.60, pavements 1.75, lawns 2.05,
// planters, plinths), with buildings and the seawall as walls. Roads carry a
// small virtual camber, gutters and drain sumps, so rain first gathers along
// curbs and at inlets, puddles merge into pools, drains choke and surcharge,
// and water spreads along the carriageway and over curbs only once deep
// enough. The surface is rendered at the simulated level with the real curbs
// and walls occluding it (crisp edges, nothing passes through obstacles).
// ---------------------------------------------------------------------------

const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const RECT = [-62, -56, 62, 48];

export class FloodEvent {
  constructor(scene, { walkMesh, data, lowQuality = false, waterN, coastTex }) {
    Object.assign(this, { scene, walkMesh, D: data, low: lowQuality, waterN, coastTex });
    this.settings = { depth: 0.3, rain: 0.85, flow: 1.0, recession: 1.0 };
    this.phase = 'idle';
    this.running = false;
    this.paused = false;
    this.w = 0;
    this.stats = { mean: 0, max: 0, area: 0 };
    this.grid = null;
    this.acc = 0;
  }

  // ---- controls --------------------------------------------------------------------
  start() { this.ensure(); this.running = true; this.paused = false; this.phase = 'rising'; }
  pause(on = !this.paused) { this.paused = on; }
  recede() { if (this.running) this.phase = 'receding'; }
  reset() {
    this.running = false; this.phase = 'idle'; this.w = 0;
    if (this.grid) { for (const a of [this.grid.d, this.grid.fl, this.grid.fr, this.grid.ft, this.grid.fb, this.grid.vx, this.grid.vz, this.grid.foam]) a.fill(0); this.upload(); }
    if (this.mesh) this.mesh.visible = false;
    if (this.floaters) this.floaters.mesh.visible = false;
  }

  // ---- grid ---------------------------------------------------------------------------
  ensure() {
    if (this.grid) return;
    const cs = this.low ? 0.75 : 0.5;
    const [x0, z0, x1, z1] = RECT;
    const nx = Math.round((x1 - x0) / cs), nz = Math.round((z1 - z0) / cs), N = nx * nz;
    const h = new Float32Array(N), g = new Float32Array(N), kind = new Uint8Array(N);
    const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
    const o = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
    const D = this.D;
    const inRect = (x, z, b, pad = 0) => Math.abs(x - b.x) < b.w / 2 + pad && Math.abs(z - b.z) < b.d / 2 + pad;
    const blds = [APARTMENT, GRAFFITI, CAFE, SHOP];
    const station = D.stationFootprint || [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, x = x0 + (i + 0.5) * cs, z = z0 + (j + 0.5) * cs;
      if (D.coast.wallDist(x, z) > -0.35 || blds.some((b) => inRect(x, z, b)) || pointInPolys(x, z, station)) { kind[k] = 0; continue; }
      o.set(x, 40, z); ray.set(o, down); ray.far = 60;
      const hit = ray.intersectObject(this.walkMesh, false)[0];
      if (!hit || hit.point.y < 1.2) { kind[k] = 0; continue; }
      let y = hit.point.y;
      if (Math.abs(x - PAVILION.x) < PAVILION.size / 2 && Math.abs(z - PAVILION.z) < PAVILION.size / 2) y = Math.max(y, WALK + 0.32);
      if ((D.palmSpots || []).some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 0.85)) y = Math.max(y, WALK + 0.35);
      h[k] = y;
      kind[k] = Math.abs(y - G) < 0.06 ? 1 : y > GREEN_TOP - 0.06 ? 3 : 2;
    }
    // distance (m) from road cells to the carriageway edge -> gutters & camber
    const de = new Float32Array(N).fill(1e9);
    for (let k = 0; k < N; k++) if (kind[k] !== 1) de[k] = 0;
    const pass = (k, n, w) => { if (de[n] + w < de[k]) de[k] = de[n] + w; };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; if (i) pass(k, k - 1, 1); if (j) pass(k, k - nx, 1); if (i && j) pass(k, k - nx - 1, 1.414); if (j && i < nx - 1) pass(k, k - nx + 1, 1.414); }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) { const k = j * nx + i; if (i < nx - 1) pass(k, k + 1, 1); if (j < nz - 1) pass(k, k + nx, 1); if (i < nx - 1 && j < nz - 1) pass(k, k + nx + 1, 1.414); if (j < nz - 1 && i) pass(k, k + nx - 1, 1.414); }
    for (let k = 0; k < N; k++) {
      if (!kind[k]) continue;
      const i = k % nx, j = (k / nx) | 0, x = x0 + (i + 0.5) * cs, z = z0 + (j + 0.5) * cs;
      const dm = de[k] * cs;
      let rel = 0;
      if (kind[k] === 1) rel = -0.045 * Math.exp(-dm / 0.9) + 0.02 * (1 - Math.exp(-dm / 3));      // gutter + crown
      if (kind[k] <= 2) rel += 0.03 * (fbm(x * 0.045, z * 0.045, 71, 2) - 0.5) * 2;                 // low spots
      g[k] = h[k] + rel;
    }
    // storm-drain inlets along the gutters, ~11 m apart
    const r = makeRng(5150);
    const cand = [];
    for (let k = 0; k < N; k++) if (kind[k] === 1 && de[k] * cs < 0.8) cand.push(k);
    for (let i = cand.length - 1; i > 0; i--) { const q = Math.floor(r() * (i + 1)); [cand[i], cand[q]] = [cand[q], cand[i]]; }
    const drains = [];
    const pos = (k) => [x0 + ((k % nx) + 0.5) * cs, z0 + (((k / nx) | 0) + 0.5) * cs];
    for (const k of cand) {
      const [x, z] = pos(k);
      if (drains.every((q) => Math.hypot(q.x - x, q.z - z) > 11)) drains.push({ k, x, z, q: 0 });
    }
    for (const dr of drains) {
      const ri = Math.ceil(1.6 / cs), ci = dr.k % nx, cj = (dr.k / nx) | 0;
      for (let j = cj - ri; j <= cj + ri; j++) for (let i = ci - ri; i <= ci + ri; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
        const k = j * nx + i; if (kind[k] !== 1) continue;
        const rr = ((i - ci) ** 2 + (j - cj) ** 2) * cs * cs;
        g[k] -= 0.035 * Math.exp(-rr / 1.2);
      }
    }
    let nRoad = 0;
    for (let k = 0; k < N; k++) if (kind[k] === 1) nRoad++;
    const Z = () => new Float32Array(N);
    this.grid = { cs, nx, nz, N, x0, z0, h, g, kind, d: Z(), fl: Z(), fr: Z(), ft: Z(), fb: Z(), vx: Z(), vz: Z(), foam: Z(), drains, nRoad, wet: [] };
    this.tex = new THREE.DataTexture(new Float32Array(N * 4), nx, nz, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter; this.tex.generateMipmaps = false;
    this.foamTex = new THREE.DataTexture(new Float32Array(N), nx, nz, THREE.RedFormat, THREE.FloatType);
    this.foamTex.magFilter = this.foamTex.minFilter = THREE.NearestFilter; this.foamTex.generateMipmaps = false;
    this.buildMesh();
    this.floaters = this.buildFloaters(this.low ? 80 : 200);
    this.upload();
  }

  // ---- simulation -----------------------------------------------------------------------
  step(dt) {
    const S = this.grid, s = this.settings;
    const { nx, nz, N, cs, g, d, kind, fl, fr, ft, fb } = S;
    const area = cs * cs;
    const C = 9.81 * Math.max(0.15, s.flow) * cs * 0.5, damp = 0.985;

    // ---- sources & sinks
    const rising = this.phase === 'rising' || this.phase === 'peak';
    const rain = rising ? s.rain * 0.0011 : s.rain * 0.0001;
    const runoff = [0, 1, 0.95, 0.35];
    for (let k = 0; k < N; k++) if (kind[k]) d[k] += rain * dt * runoff[kind[k]];
    let sumRoad = 0;
    for (let k = 0; k < N; k++) if (kind[k] === 1) sumRoad += d[k];
    const mean = sumRoad / S.nRoad;
    const roadArea = S.nRoad * area;
    let Q = 0;                                     // total drain exchange (m^3/s): + surcharge, - intake
    if (this.phase === 'rising') {
      // inlets keep up at first, then choke and start to overflow once the street is waterlogged
      const intake = -0.0009 * roadArea * (1 - ss(0.005, 0.04, mean));
      const surch = Math.min(0.0045, Math.max(0, s.depth - mean) * 0.03) * roadArea * ss(0.015, 0.05, mean);
      Q = intake + surch;
      if (mean >= s.depth * 0.97) this.phase = 'peak';
    } else if (this.phase === 'peak') {
      Q = (s.depth - mean) * roadArea * 0.08 - rain * roadArea * 0.9;
    } else if (this.phase === 'receding') {
      Q = -0.0035 * s.recession * roadArea;
      const seep = 0.0006 * s.recession * dt;    // countless small inlets + infiltration
      for (let k = 0; k < N; k++) if (d[k] > 0) d[k] = Math.max(0, d[k] - seep * (kind[k] === 3 ? 3 : 1));
    }
    const per = Q / Math.max(1, S.drains.length);
    for (const dr of S.drains) {
      dr.q = per;
      if (per > 0) d[dr.k] += (per * dt) / area;
      else d[dr.k] = Math.max(0, d[dr.k] + (per * dt) / area);
    }

    // ---- outflow fluxes (virtual pipes) with walls
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        if (!kind[k]) { fl[k] = fr[k] = ft[k] = fb[k] = 0; continue; }
        const H = g[k] + d[k];
        let n;
        n = k - 1; fl[k] = i > 0 && kind[n] ? Math.max(0, fl[k] * damp + dt * C * (H - g[n] - d[n])) : 0;
        n = k + 1; fr[k] = i < nx - 1 && kind[n] ? Math.max(0, fr[k] * damp + dt * C * (H - g[n] - d[n])) : 0;
        n = k - nx; ft[k] = j > 0 && kind[n] ? Math.max(0, ft[k] * damp + dt * C * (H - g[n] - d[n])) : 0;
        n = k + nx; fb[k] = j < nz - 1 && kind[n] ? Math.max(0, fb[k] * damp + dt * C * (H - g[n] - d[n])) : 0;
        const sum = fl[k] + fr[k] + ft[k] + fb[k];
        if (sum > 0) {
          const K = Math.min(1, (d[k] * area) / (sum * dt));
          fl[k] *= K; fr[k] *= K; ft[k] *= K; fb[k] *= K;
        }
      }
    }
    // ---- volume update + velocity
    let mx = 0, wetN = 0;
    const vx = S.vx, vz = S.vz, foam = S.foam;
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        if (!kind[k]) continue;
        const inL = i > 0 ? fr[k - 1] : 0, inR = i < nx - 1 ? fl[k + 1] : 0;
        const inT = j > 0 ? fb[k - nx] : 0, inB = j < nz - 1 ? ft[k + nx] : 0;
        const out = fl[k] + fr[k] + ft[k] + fb[k];
        const dn = Math.max(0, d[k] + (dt * (inL + inR + inT + inB - out)) / area);
        d[k] = dn;
        const dd = Math.max(dn, 0.02) * cs;
        const ux = (inL - fl[k] + fr[k] - inR) * 0.5 / dd, uz = (inT - ft[k] + fb[k] - inB) * 0.5 / dd;
        vx[k] = Math.max(-2, Math.min(2, ux)); vz[k] = Math.max(-2, Math.min(2, uz));
        foam[k] *= 0.96;
        if (dn > mx) mx = dn;
        if (dn > 0.01) wetN++;
      }
    }
    for (const dr of S.drains) {          // churning inlets: surcharge boils up, intake swirls down
      const f = Math.min(1, Math.abs(dr.q) * 6);
      for (const n of [dr.k, dr.k - 1, dr.k + 1, dr.k - nx, dr.k + nx]) if (n >= 0 && n < N) foam[n] = Math.max(foam[n], f * (dr.q > 0 ? 1 : 0.5));
    }
    this.stats = { mean, max: mx, area: wetN * area };
    if (this.phase === 'receding' && mx < 0.004) {
      this.phase = 'idle'; this.running = false;
      d.fill(0);
    }
  }

  /** Render state: surface height (dilated under curbs/walls), depth, velocity; foam separately. */
  upload() {
    const S = this.grid;
    const { nx, nz, N, h, d, kind, vx, vz } = S;
    const out = this.tex.image.data, fo = this.foamTex.image.data;
    S.wet.length = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, o = k * 4;
      fo[k] = S.foam[k];
      if (kind[k] && d[k] > 0.002) {
        out[o] = h[k] + d[k]; out[o + 1] = d[k]; out[o + 2] = vx[k]; out[o + 3] = vz[k];
        if (d[k] > 0.05 && (k & 3) === 0) S.wet.push(k);
        continue;
      }
      // dry: continue the neighbouring water surface underneath raised curbs and walls
      let best = -1e9, bd = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const n = jj * nx + ii;
        if (kind[n] && d[n] > 0.002 && h[n] + d[n] > best) { best = h[n] + d[n]; bd = d[n]; }
      }
      const ground = kind[k] ? h[k] : 1e9;
      if (best > -1e8) {
        out[o] = best; out[o + 1] = ground >= best - 0.002 ? bd : 0;   // raised obstacle hides it; flat ground: fade out
      } else { out[o] = (kind[k] ? h[k] : WALK) - 0.4; out[o + 1] = 0; }
      out[o + 2] = 0; out[o + 3] = 0;
    }
    this.tex.needsUpdate = true; this.foamTex.needsUpdate = true;
  }

  sample(x, z) {
    const S = this.grid;
    const i = Math.floor((x - S.x0) / S.cs), j = Math.floor((z - S.z0) / S.cs);
    if (i < 0 || j < 0 || i >= S.nx || j >= S.nz) return null;
    const k = j * S.nx + i;
    return { d: S.d[k], y: S.h[k] + S.d[k], vx: S.vx[k], vz: S.vz[k], kind: S.kind[k] };
  }

  // ---- per frame ----------------------------------------------------------------------------
  update(dt, camera, env) {
    const active = this.running || (this.grid && this.stats.max > 0.003);
    this.w += ((this.running && this.phase !== 'receding' ? 1 : 0) - this.w) * Math.min(1, dt / (this.running ? 6 : 10));
    if (!this.grid || (!active && this.w < 0.002)) return this.w > 0.002 ? this.override() : null;
    if (this.running && !this.paused) {
      this.acc += Math.min(dt, 0.1);
      const step = 1 / 20;
      let n = 0;
      while (this.acc >= step && n < 3) { this.step(step); this.acc -= step; n++; }
      if (n) this.upload();
    }
    const vis = this.stats.max > 0.003;
    this.mesh.visible = vis;
    const U = this.mesh.material.uniforms;
    U.uTime.value += dt;
    U.uAmb.value.copy(env.ambient);
    U.uSunCol.value.copy(env.sunColor);
    U.uRain.value = env.rain;
    U.uFlow.value = this.settings.flow;
    U.uFogCol.value.copy(env.fog.color); U.uFogNear.value = env.fog.near; U.uFogFar.value = env.fog.far;
    this.updateFloaters(dt, env);
    return this.override();
  }

  override() {
    const s = this.settings, rec = this.phase === 'receding';
    return {
      weight: this.w,
      params: { cover: 1, dark: 0.74, rain: rec ? 0.15 : s.rain, storm: 0.12, wind: 1.8, gust: 1.0, haze: 0.85, fog: 0.4, mist: 0.15, scud: 0.85, cirrus: 0 },
      surfaces: this.w,
    };
  }

  // ---- rendering ------------------------------------------------------------------------------
  buildMesh() {
    const S = this.grid;
    const { nx, nz, cs, x0, z0 } = S;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      pos[k] = x0 + (i + 0.5) * cs; pos[k + 1] = 0; pos[k + 2] = z0 + (j + 0.5) * cs;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let o = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = e;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uState: { value: this.tex }, uFoam: { value: this.foamTex }, uX0: { value: x0 }, uZ0: { value: z0 }, uCs: { value: cs },
        uTime: { value: 0 }, uWaterN: { value: this.waterN }, uLace: { value: this.coastTex },
        uAmb: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() }, uRain: { value: 0 }, uFlow: { value: 1 },
        uSkyZen: atmoUniforms.uSkyZenW, uSkyHor: atmoUniforms.uSkyHorW, uLightDir: atmoUniforms.uLightDirW,
        uFogCol: { value: new THREE.Color() }, uFogNear: { value: 200 }, uFogFar: { value: 900 },
      },
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        uniform sampler2D uState, uFoam;
        uniform float uX0, uZ0, uCs;
        varying vec3 vW; varying float vDepth, vFoam; varying vec2 vVel;
        void main() {
          ivec2 c = ivec2(int(floor((position.x - uX0) / uCs)), int(floor((position.z - uZ0) / uCs)));
          vec4 s = texelFetch(uState, c, 0);
          vFoam = texelFetch(uFoam, c, 0).r;
          vDepth = s.g; vVel = s.ba;
          vec3 wp = vec3(position.x, s.r + 0.004, position.z);
          vW = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uRain, uFlow, uFogNear, uFogFar;
        uniform sampler2D uWaterN, uLace;
        uniform vec3 uAmb, uSunCol, uSkyZen, uSkyHor, uLightDir, uFogCol;
        varying vec3 vW; varying float vDepth, vFoam; varying vec2 vVel;
        vec2 ring(vec2 p, float t, float seed) {
          vec2 g = p * 3.0 + seed;
          vec2 cell = floor(g), f = fract(g) - 0.5;
          float h = fract(sin(dot(cell, vec2(12.9898, 78.233)) + seed) * 43758.5453);
          float ph = fract(t * (1.1 + h * 0.7) + h);
          vec2 d = f - (vec2(h, fract(h * 7.13)) - 0.5) * 0.5;
          float r = length(d), R = ph * 0.4;
          return d / max(r, 1e-3) * sin((r - R) * 70.0) * smoothstep(0.06, 0.0, abs(r - R)) * (1.0 - ph);
        }
        void main() {
          float depth = vDepth;
          if (depth < 0.0015) discard;
          vec2 vel = vVel * uFlow;
          float spd = length(vel);
          // flow-mapped ripples (two offset phases) + rain rings
          float p0 = fract(uTime * 0.3), p1 = fract(uTime * 0.3 + 0.5);
          float w0 = 1.0 - abs(p0 * 2.0 - 1.0);
          vec2 nA = texture2D(uWaterN, vW.xz * 0.42 - vel * p0 * 1.4).rg * 2.0 - 1.0;
          vec2 nB = texture2D(uWaterN, vW.xz * 0.42 - vel * p1 * 1.4 + 0.5).rg * 2.0 - 1.0;
          vec2 n = mix(nB, nA, w0) * (0.05 + 0.22 * min(spd, 1.5));
          n += (ring(vW.xz, uTime, 0.0) + ring(vW.xz * 1.31, uTime * 1.07, 4.1)) * 0.11 * uRain;
          vec3 N = normalize(vec3(n.x, 1.0, n.y));
          vec3 V = normalize(cameraPosition - vW);
          float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec3 R = reflect(-V, N);
          vec3 sky = mix(uSkyHor, uSkyZen, pow(max(R.y, 0.0), 0.5));
          float spec = pow(max(dot(R, uLightDir), 0.0), 220.0);
          // muddy Kerala floodwater: tea-brown when shallow, olive-brown and opaque when deep
          vec3 body = mix(vec3(0.42, 0.33, 0.19), vec3(0.2, 0.2, 0.1), smoothstep(0.03, 0.45, depth)) * uAmb;
          F *= 0.6;
          sky *= 0.72;                                           // silt-laden water: muted, broken reflections
          float a = 1.0 - exp(-depth * 7.5);
          // foam, scum lines at the edges, churn at inlets and in fast runoff
          vec2 fuv = vW.xz * 0.55 - vel * uTime * 0.5;
          float lace = texture2D(uLace, fuv).r;
          float amt = clamp(vFoam * 0.8 + smoothstep(0.35, 1.4, spd) * 0.5 + smoothstep(0.035, 0.008, depth) * 0.25, 0.0, 0.85);
          float foam = smoothstep(1.0 - amt, 1.12 - amt, lace);
          vec3 col = mix(body, sky, F) + uSunCol * spec * 0.6;
          col = mix(col, vec3(0.78, 0.74, 0.64) * uAmb * 1.15, foam * 0.85);
          float alpha = clamp(a * 0.94 + F * 0.35 + foam * 0.6, 0.0, 1.0) * smoothstep(0.0015, 0.012, depth);
          col = mix(col, uFogCol, smoothstep(uFogNear, uFogFar, length(cameraPosition - vW)));
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  buildFloaters(count) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    const inst = new Float32Array(count * 4), kind = new Float32Array(count * 2);
    const r = makeRng(808);
    for (let i = 0; i < count; i++) { kind[i * 2] = r(); kind[i * 2 + 1] = 0.08 + r() * r() * 0.22; }
    const aI = new THREE.InstancedBufferAttribute(inst, 4); aI.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aI', aI);
    geo.setAttribute('aK', new THREE.InstancedBufferAttribute(kind, 2));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAmb: { value: new THREE.Color() } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec4 aI; attribute vec2 aK;
        varying vec2 vQ; varying float vT, vA;
        void main() {
          float c = cos(aI.w), s = sin(aI.w);
          vec2 q = position.xz * vec2(1.0, aK.x < 0.7 ? 0.45 : 0.18);
          vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * aK.y;
          vQ = position.xz; vT = aK.x; vA = step(-50.0, aI.y);
          gl_Position = projectionMatrix * viewMatrix * vec4(aI.x + r.x, aI.y, aI.z + r.y, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uAmb;
        varying vec2 vQ; varying float vT, vA;
        void main() {
          float leaf = 1.0 - dot(vQ, vQ);
          if (vT < 0.7 && leaf < 0.0) discard;
          vec3 col = vT < 0.35 ? vec3(0.22, 0.3, 0.1) : vT < 0.7 ? vec3(0.42, 0.3, 0.14) : vec3(0.3, 0.22, 0.15);
          col *= 0.8 + 0.2 * smoothstep(0.08, 0.0, abs(vQ.y));
          gl_FragColor = vec4(col * uAmb * 1.2, vA);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.visible = false;
    this.scene.add(mesh);
    const P = Array.from({ length: count }, () => ({ x: 0, z: 0, a: r() * 6.28, spin: (r() - 0.5) * 0.8, alive: false }));
    return { mesh, P, inst, attr: aI, r };
  }

  updateFloaters(dt, env) {
    const F = this.floaters, S = this.grid;
    F.mesh.visible = this.stats.mean > 0.03 || this.stats.max > 0.1;
    if (!F.mesh.visible) return;
    F.mesh.material.uniforms.uAmb.value.copy(env.ambient);
    const target = Math.round(F.P.length * ss(0.03, 0.2, this.stats.mean));
    F.P.forEach((p, i) => {
      let s = p.alive ? this.sample(p.x, p.z) : null;
      if (i >= target || !S.wet.length) { p.alive = false; F.inst[i * 4 + 1] = -100; return; }
      if (!s || s.d < 0.025) {
        const k = S.wet[Math.floor(F.r() * S.wet.length)];
        p.x = S.x0 + ((k % S.nx) + F.r()) * S.cs; p.z = S.z0 + (((k / S.nx) | 0) + F.r()) * S.cs;
        p.alive = true;
        s = this.sample(p.x, p.z);
        if (!s) return;
      }
      const flow = this.settings.flow;
      p.x += (s.vx * flow * 0.9 + env.windX * 0.06 + (F.r() - 0.5) * 0.08) * dt;
      p.z += (s.vz * flow * 0.9 + env.windZ * 0.06 + (F.r() - 0.5) * 0.08) * dt;
      p.a += (p.spin + (s.vx - s.vz) * 0.3) * dt;
      F.inst[i * 4] = p.x; F.inst[i * 4 + 1] = s.y + 0.006; F.inst[i * 4 + 2] = p.z; F.inst[i * 4 + 3] = p.a;
    });
    F.attr.needsUpdate = true;
  }
}

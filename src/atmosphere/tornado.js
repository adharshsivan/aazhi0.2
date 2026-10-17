import * as THREE from 'three';
import { atmoUniforms } from './atmoShared.js';
import { makeRng } from './weather.js';

// ---------------------------------------------------------------------------
// Tornado event over the island.
//
// Rendering: the funnel, its swirling debris cloud and the rain curtain that
// wraps the rear flank are ONE volumetric density field (rotating 3D noise in
// the vortex frame, bent centre line, cone/rope profile). It is rendered with
// view-aligned slices (instanced quads, back to front): every slice is depth-
// tested against the scene, so buildings and palms in front correctly occlude
// it without a depth pre-pass, and the cost scales with the slice count
// (40 desktop / 16 mobile). A lowered rotating wall cloud caps it, and sparse
// debris specks + wind-blown leaves add near-field motion.
//
// Life cycle: build-up -> funnel lowers from the wall cloud -> touchdown on the
// west side -> wanders across parks and streets -> rope-out -> recovery.
// ---------------------------------------------------------------------------

export const TORNADO_LEVELS = [
  null,
  { name: 'EF1 · weak', width: 7, shift: 16, rot: 0.8, dust: 0.55, wind: 0.6 },
  { name: 'EF2', width: 11, shift: 9, rot: 1.0, dust: 0.75, wind: 0.85 },
  { name: 'EF3', width: 16, shift: 4, rot: 1.2, dust: 0.9, wind: 1.05 },
  { name: 'EF4 · violent', width: 23, shift: 0, rot: 1.4, dust: 1.0, wind: 1.3 },
];
// waypoints over land: touch down on the west side, cross parks and streets, lift off in the east
const PATH = [[-46, 22], [-30, 4], [-12, -6], [6, 8], [24, -2], [44, 10]];
const T = { form: 30, touch: 54, mature: 64, rope: 132, lift: 150, end: 190 };
export const TORNADO_DURATION = T.end;
const CLOUD_BASE = 250;
const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const MOTION = new THREE.Vector2(0.93, -0.36).normalize();      // parent storm drifts towards the ENE

const FOG_GLSL = /* glsl */`
uniform vec3 uFogCol; uniform float uFogNear, uFogFar;
// big storm structures stay silhouetted: only gentle aerial perspective
vec3 tFog(vec3 c, float d) { return mix(c, uFogCol, smoothstep(uFogNear, uFogFar * 2.4, d) * 0.55); }
`;

/** Tileable 3D noise: billowy perlin-worley (R channel). */
function makeNoise3D(N) {
  const r = makeRng(4242);
  const grid = (P) => { const g = new Float32Array(P * P * P); for (let i = 0; i < g.length; i++) g[i] = r(); return g; };
  const octs = [[4, 0.5], [8, 0.3], [16, 0.2]].map(([P, w]) => ({ P, w, g: grid(P) }));
  const sm = (t) => t * t * (3 - 2 * t);
  const C = 6, pts = new Float32Array(C * C * C * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = r();
  const data = new Float32Array(N * N * N);
  let lo = Infinity, hi = -Infinity;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (const o of octs) {
      const fx = (x / N) * o.P, fy = (y / N) * o.P, fz = (z / N) * o.P;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
      const tx = sm(fx - x0), ty = sm(fy - y0), tz = sm(fz - z0), P = o.P;
      const at = (a, b, c) => o.g[((c % P) * P + (b % P)) * P + (a % P)];
      const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
      const c00 = at(x0, y0, z0) + (at(x1, y0, z0) - at(x0, y0, z0)) * tx;
      const c10 = at(x0, y1, z0) + (at(x1, y1, z0) - at(x0, y1, z0)) * tx;
      const c01 = at(x0, y0, z1) + (at(x1, y0, z1) - at(x0, y0, z1)) * tx;
      const c11 = at(x0, y1, z1) + (at(x1, y1, z1) - at(x0, y1, z1)) * tx;
      v += ((c00 + (c10 - c00) * ty) * (1 - tz) + (c01 + (c11 - c01) * ty) * tz) * o.w;
    }
    const fx = (x / N) * C, fy = (y / N) * C, fz = (z / N) * C;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let f1 = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const k = ((((cz % C) + C) % C) * C * C + (((cy % C) + C) % C) * C + (((cx % C) + C) % C)) * 3;
      const d = Math.hypot(cx + pts[k] - fx, cy + pts[k + 1] - fy, cz + pts[k + 2] - fz);
      if (d < f1) f1 = d;
    }
    const val = v * 0.6 + (1 - Math.min(1, f1)) * 0.4;
    data[(z * N + y) * N + x] = val;
    lo = Math.min(lo, val); hi = Math.max(hi, val);
  }
  const u8 = new Uint8Array(N * N * N);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.round(((data[i] - lo) / (hi - lo)) * 255);
  const t = new THREE.Data3DTexture(u8, N, N, N);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

export class TornadoEvent {
  constructor(scene, { lowQuality = false } = {}) {
    this.scene = scene;
    this.low = lowQuality;
    this.level = 3;
    this.t = 0;
    this.running = false;
    this.paused = false;
    this.w = 0;
    this.slices = lowQuality ? 18 : 42;
    this.state = { prox: 0, dist: 1e4, phase: 'idle', base: new THREE.Vector3(1e5, 0, 0), wind: new THREE.Vector2(), roar: 0 };
    this.u = {
      uTime: { value: 0 }, uBase: { value: new THREE.Vector3() }, uTop: { value: new THREE.Vector3() },
      uBendA: { value: new THREE.Vector3() }, uBendB: { value: new THREE.Vector3() },
      uExtent: { value: 0 }, uWidth: { value: 16 }, uRot: { value: 1 }, uLift: { value: 0 }, uAlpha: { value: 0 },
      uDust: { value: 0 }, uLand: { value: 1 }, uRain: { value: 0 }, uRear: { value: new THREE.Vector2(-1, 0) },
      uAmb: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uLightDir: atmoUniforms.uLightDirW,
      uFlash: { value: 0 }, uWall: { value: 0 },
      uFogCol: { value: new THREE.Color() }, uFogNear: { value: 200 }, uFogFar: { value: 900 },
      uNoise3: { value: null }, uCloudTex: atmoUniforms.uCloudTex,
    };
    this.volume = this.makeVolume();
    this.wall = this.makeWallCloud();
    this.debris = this.makeDebris(lowQuality ? 60 : 160);
    this.leaves = this.makeLeaves(lowQuality ? 60 : 150);
    this.setVisible(false);
    // build the 3D noise off the critical path
    setTimeout(() => this.ensureNoise(), 1500);
  }

  ensureNoise() { if (!this.u.uNoise3.value) this.u.uNoise3.value = makeNoise3D(this.low ? 48 : 64); }

  // ---- controls --------------------------------------------------------------------
  start(level = this.level) { this.ensureNoise(); this.level = level; this.t = 0; this.running = true; this.paused = false; this.setVisible(true); }
  pause(on = !this.paused) { this.paused = on; }
  /** End early: a formed funnel ropes out; otherwise skip to recovery. */
  stop() { if (!this.running) return; this.t = this.t > T.form && this.t < T.rope ? T.rope : Math.max(this.t, T.lift); }
  reset() { this.running = false; this.t = 0; this.w = 0; this.setVisible(false); this.state.prox = 0; this.state.roar = 0; this.state.phase = 'idle'; }
  seek(f) { if (!this.running) this.start(this.level); this.t = f * T.end; }
  get progress() { return this.t / T.end; }
  setVisible(v) { for (const m of [this.volume, this.wall, this.debris.mesh, this.leaves.mesh]) m.visible = v; }

  phaseName() {
    const t = this.t;
    if (!this.running) return 'idle';
    if (t < T.form) return 'storm building';
    if (t < T.touch) return 'funnel lowering';
    if (t < T.mature) return 'touchdown';
    if (t < T.rope) return 'mature';
    if (t < T.lift) return 'roping out';
    return 'recovery';
  }

  /** Ground position of the vortex at event time t (analytic, so scrubbing is exact). */
  trackAt(t, out = new THREE.Vector3()) {
    const L = TORNADO_LEVELS[this.level];
    let u = Math.min(1, Math.max(0, (t - T.form) / (T.lift - T.form)));
    u = Math.min(1, Math.max(0, u + 0.03 * Math.sin(t * 0.11)));          // stalls and surges
    const f = u * (PATH.length - 1), i = Math.min(PATH.length - 2, Math.floor(f)), k = f - i;
    const P = (j) => PATH[Math.max(0, Math.min(PATH.length - 1, j))];
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * k + (2 * a - 5 * b + 4 * c - d) * k * k + (-a + 3 * b - 3 * c + d) * k * k * k);
    const x = cr(p0[0], p1[0], p2[0], p3[0]) + 4 * Math.sin(t * 0.23) + 1.8 * Math.sin(t * 0.61);
    const z = cr(p0[1], p1[1], p2[1], p3[1]) - L.shift + 4 * Math.cos(t * 0.19 + 1) + 1.8 * Math.sin(t * 0.53);
    return out.set(x, 0, z);
  }

  // ---- per frame ------------------------------------------------------------------------
  update(dt, camera, focus, env) {
    if (this.running && !this.paused) this.t += dt;
    if (this.running && this.t >= T.end) this.reset();
    const t = this.t, L = TORNADO_LEVELS[this.level], u = this.u, S = this.state;
    if (!this.running) { S.prox = 0; S.roar = 0; return null; }
    S.phase = this.phaseName();

    // ---- life-cycle curves
    const storm = ss(0, 24, t) * (1 - ss(T.lift + 4, T.end - 6, t));
    const wall = ss(8, T.form + 6, t) * (1 - 0.5 * ss(T.rope, T.lift, t)) * (1 - ss(T.lift, T.lift + 14, t));
    const extent = Math.max(0, Math.min(1, ss(T.form, T.touch - 4, t) * 0.62 + ss(T.touch - 4, T.mature - 2, t) * 0.38 - ss(T.rope + 6, T.lift, t)));
    const dust = (ss(T.touch - 8, T.mature + 6, t) * (1 - ss(T.rope + 2, T.lift - 2, t)) + 0.25 * ss(T.form + 8, T.touch, t) * (1 - ss(T.touch, T.mature, t))) * L.dust;
    const rope = ss(T.rope - 4, T.lift, t);
    const breathe = 0.86 + 0.14 * Math.sin(t * 0.13) + 0.08 * Math.sin(t * 0.37 + 1.1);
    const width = L.width * breathe * (0.4 + 0.6 * ss(T.form, T.mature, t)) * (1 - 0.7 * rope);
    this.w = storm;

    const base = this.trackAt(t, S.base);
    const lag = 30 + 120 * rope;
    const top = new THREE.Vector3(base.x - MOTION.x * lag, CLOUD_BASE, base.z - MOTION.y * lag);
    if (!this.paused) u.uTime.value += dt;
    u.uBase.value.copy(base);
    u.uTop.value.copy(top);
    const side = new THREE.Vector3(-MOTION.y, 0, MOTION.x);
    u.uBendA.value.copy(side).multiplyScalar(10 * Math.sin(t * 0.09) + 55 * rope * Math.sin(t * 0.21));
    u.uBendB.value.copy(side).multiplyScalar(6 * Math.sin(t * 0.17 + 2) + 35 * rope);
    u.uExtent.value = extent;
    u.uWidth.value = width;
    u.uRot.value = L.rot;
    u.uLift.value = rope;
    u.uAlpha.value = Math.min(1, storm * 1.2);
    u.uDust.value = dust;
    u.uRain.value = storm * (0.5 + 0.5 * ss(T.form, T.mature, t)) * (1 - rope * 0.5);
    u.uRear.value.set(-MOTION.x, -MOTION.y);
    u.uWall.value = wall;
    u.uAmb.value.copy(env.ambient);
    u.uSun.value.copy(env.sunColor);
    u.uFlash.value = env.flash;
    u.uFogCol.value.copy(env.fog.color); u.uFogNear.value = env.fog.near; u.uFogFar.value = env.fog.far;
    const overLand = env.isLand(base.x, base.z) ? 1 : 0;
    this.overLand = (this.overLand ?? overLand) + (overLand - (this.overLand ?? overLand)) * Math.min(1, dt * 0.8);
    u.uLand.value = this.overLand;
    this.debris.mesh.material.uniforms.uAmount.value = dust * (0.4 + 0.6 * this.overLand);

    this.layoutSlices(camera, base, top, width);

    // ---- proximity & winds at the player's location
    const dx = focus.x - base.x, dz = focus.z - base.z;
    const dist = Math.hypot(dx, dz);
    S.dist = dist;
    const core = Math.max(0, dist - width * 1.5);
    const near = Math.pow(Math.max(0, 1 - core / 450), 1.4);
    S.prox = near * Math.max(dust, extent * 0.35) * storm;
    const inv = 1 / Math.max(dist, 1);
    const tx = -dz * inv, tz = dx * inv;                 // cyclonic rotation + inflow
    S.wind.set(tx * 0.8 - dx * inv * 0.6, tz * 0.8 - dz * inv * 0.6).normalize();
    S.roar = S.prox * (0.6 + 0.4 * L.wind) + storm * 0.08;
    const LV = this.leaves.mesh.material.uniforms;
    LV.uAmount.value = ss(0.2, 0.7, S.prox) * (0.4 + 0.6 * L.wind);
    LV.uFocus.value.copy(focus);
    LV.uWind.value.set(S.wind.x, S.wind.y).multiplyScalar(8 + 9 * S.prox * L.wind);
    for (const m of [this.debris, this.leaves]) {
      const U = m.mesh.material.uniforms;
      U.uLight.value.copy(env.ambient).addScalar(env.flash * 0.4);
      U.uFogCol.value.copy(env.fog.color); U.uFogNear.value = env.fog.near; U.uFogFar.value = env.fog.far;
    }

    const p = S.prox;
    return {
      weight: storm,
      params: {
        cover: 1, dark: 0.8 + 0.15 * p, rain: 0.45 + 0.25 * (1 - p) * storm, storm: 0.55 + 0.35 * storm, scud: 1,
        wind: Math.min(3.3, 1.5 + (0.9 + 1.1 * p) * L.wind), gust: 1.0 + 0.35 * p, haze: 0.8, fog: 0.22 + 0.3 * p, mist: 0.15, cirrus: 0,
      },
      windDir: S.wind, windWeight: Math.min(1, 0.35 + p),
    };
  }

  /** Fit the view-aligned slice stack to the volume's bounding box as seen from this camera. */
  layoutSlices(camera, base, top, width) {
    camera.updateMatrixWorld();
    const U = this.volume.material.uniforms;
    const e = camera.matrixWorld.elements;
    const R = U.uCamR.value.set(e[0], e[1], e[2]).normalize();
    const Up = U.uCamU.value.set(e[4], e[5], e[6]).normalize();
    const F = U.uCamF.value.set(-e[8], -e[9], -e[10]).normalize();
    const reach = Math.max(width * 8.8, width * 2.6 + 14) + 8;           // flared top, debris cloud, rain curtain
    const lo = new THREE.Vector3(Math.min(base.x, top.x) - reach - 60, 0, Math.min(base.z, top.z) - reach - 60);
    const hi = new THREE.Vector3(Math.max(base.x, top.x) + reach + 60, CLOUD_BASE + 20, Math.max(base.z, top.z) + reach + 60);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, d0 = Infinity, d1 = -Infinity, behind = false;
    const c = new THREE.Vector3(), cam = camera.position;
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z).sub(cam);
      const z = c.dot(F);
      if (z < 1) { behind = true; d1 = Math.max(d1, z); continue; }
      x0 = Math.min(x0, c.dot(R) / z); x1 = Math.max(x1, c.dot(R) / z);
      y0 = Math.min(y0, c.dot(Up) / z); y1 = Math.max(y1, c.dot(Up) / z);
      d0 = Math.min(d0, z); d1 = Math.max(d1, z);
    }
    const ty = Math.tan((camera.fov * Math.PI) / 360) * 1.05, tx = ty * camera.aspect;
    if (behind) { x0 = -tx; x1 = tx; y0 = -ty; y1 = ty; d0 = 0.6; }
    x0 = Math.max(x0, -tx); x1 = Math.min(x1, tx); y0 = Math.max(y0, -ty); y1 = Math.min(y1, ty);
    const ok = x1 > x0 && y1 > y0 && d1 > d0;
    this.volume.visible = ok && this.running;
    U.uRect.value.set(x0, x1, y0, y1);
    U.uDmin.value = Math.max(0.6, d0);
    U.uDmax.value = Math.max(U.uDmin.value + 1, d1);
    U.uDelta.value = (U.uDmax.value - U.uDmin.value) / this.slices;
  }

  // ---- meshes --------------------------------------------------------------------------
  makeVolume() {
    const N = this.slices;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aSlice', new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: N }, (_, i) => i)), 1));
    geo.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.u,
        uCamR: { value: new THREE.Vector3() }, uCamU: { value: new THREE.Vector3() }, uCamF: { value: new THREE.Vector3() },
        uRect: { value: new THREE.Vector4() }, uDmin: { value: 1 }, uDmax: { value: 2 }, uDelta: { value: 1 }, uN: { value: N },
      },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute float aSlice;
        uniform vec3 uCamR, uCamU, uCamF;
        uniform vec4 uRect;
        uniform float uDmin, uDmax, uN;
        varying vec3 vW;
        void main() {
          float d = mix(uDmax, uDmin, (aSlice + 0.5) / uN);           // far slices first
          vec2 q = vec2(mix(uRect.x, uRect.y, position.x), mix(uRect.z, uRect.w, position.y));
          vec3 wp = cameraPosition + (uCamF + uCamR * q.x + uCamU * q.y) * d;
          vW = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp sampler3D;
        ${FOG_GLSL}
        uniform sampler3D uNoise3;
        uniform vec3 uBase, uTop, uBendA, uBendB, uAmb, uSun, uLightDir;
        uniform vec2 uRear;
        uniform float uTime, uExtent, uWidth, uRot, uLift, uAlpha, uDust, uLand, uRain, uFlash, uDelta;
        varying vec3 vW;
        float n3(vec3 p) { return texture(uNoise3, p).r; }
        vec3 centre(float h) {
          vec3 c = mix(uBase, uTop, h);
          return c + uBendA * sin(3.14159 * h) + uBendB * sin(6.28318 * h) * (1.0 - h);
        }
        void main() {
          vec3 p = vW;
          float H = uTop.y - uBase.y;
          float h = clamp((p.y - uBase.y) / H, 0.0, 1.0);
          if (p.y < uBase.y - 1.0 || p.y > uTop.y + 25.0) discard;
          vec3 c = centre(h);
          vec2 rel = p.xz - c.xz;
          float r = length(rel);
          float Rb = uWidth;
          // cone that widens into the cloud base; a rope-out thins the lower part
          float R = Rb * (0.42 + 2.7 * pow(h, 1.2)) + Rb * 2.6 * pow(smoothstep(0.78, 1.0, h), 2.0);
          R *= 1.0 - 0.45 * uLift * (1.0 - h);
          float lo = 1.0 - uExtent;
          float tip = smoothstep(lo, lo + 0.12, h);
          float yD = p.y - uBase.y;
          float Hd = 6.0 + Rb * 0.8;
          float Rd = Rb * 1.6 + 8.0;
          float RdOut = Rd * (1.0 + max(yD, 0.0) / Hd * 0.4);
          // early out only where every density term is already exactly zero
          if (r > max(R * 1.25, yD < Hd * 4.0 ? RdOut : 0.0)) discard;

          // rigid spin (two layers, faster low down, blended by VALUE); time terms wrapped
          const float TAU = 6.2831853;
          float a = atan(rel.y, rel.x);
          float wLow = 1.0 - smoothstep(0.15, 0.65, h);
          float s1 = mod(uTime * uRot * 1.3, TAU), s2 = mod(uTime * uRot * 0.5 + 1.7, TAU);
          vec2 rot1 = vec2(cos(a - s1), sin(a - s1)) * r, rot2 = vec2(cos(a - s2), sin(a - s2)) * r;
          float k = 0.6 / max(R, 4.0);
          float lift = p.y * 0.005;
          float n = mix(n3(vec3(rot2 * k, lift - fract(uTime * 0.03))), n3(vec3(rot1 * k, lift - fract(uTime * 0.05))), wLow);

          // ---- funnel: soft edge displaced by the rotating noise
          float edge = R * (0.8 + 0.35 * (n - 0.5)) * tip;
          float dF = smoothstep(edge * 1.05, edge * 0.55, r) * step(lo - 0.02, h);
          // ---- debris cloud: soft churning skirt at the base
          float spinD = mod(uTime * uRot * 2.0, TAU);
          vec2 rotD = vec2(cos(a - spinD), sin(a - spinD)) * r;
          float nd = n3(vec3(rotD * 0.025, yD * 0.03 - fract(uTime * 0.15)) + 0.21);
          float prof = exp(-max(yD, 0.0) / Hd) * smoothstep(RdOut, Rd * 0.15, r);
          float dD = uDust * prof * (0.45 + 0.55 * nd);

          float sF = dF * 0.35, sD = dD * 0.08;
          float sig = sF + sD;
          if (sig < 1e-4) discard;
          float alpha = (1.0 - exp(-sig * uDelta * 1.15)) * uAlpha;

          // ---- lighting: lit vs shadowed flank (fades to neutral at the core, no centre singularity)
          vec2 L2 = normalize(uLightDir.xz + vec2(1e-4));
          float lit = 0.5 + 0.5 * dot(rel / max(r, max(edge, 1.0)), L2);
          vec3 cond = uAmb * (0.13 + 0.14 * lit) * (0.85 + 0.3 * n)
                    + uSun * 0.08 * lit * smoothstep(0.0, 0.25, uLightDir.y);
          cond *= mix(vec3(0.86, 0.88, 0.92), vec3(0.7, 0.58, 0.46), smoothstep(0.35, 0.0, h) * uDust);   // soil-stained lower funnel
          vec3 soil = mix(vec3(0.7, 0.72, 0.74), vec3(0.4, 0.31, 0.21), uLand) * uAmb * (0.3 + 0.2 * lit);
          vec3 col = (cond * sF + soil * sD) / sig;
          vec3 col = (cond * sF + soil * sD + rain * sR) / sig;
          col += vec3(0.75, 0.8, 1.0) * uFlash * 0.45;
          col = tFog(col, length(p - cameraPosition));
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 5;
    this.scene.add(m);
    return m;
  }

  makeWallCloud() {
    // rotating, lowered wall cloud under the storm base that the funnel hangs from
    const rings = 24, segs = this.low ? 48 : 80;
    const pos = [], idx = [];
    for (let j = 0; j <= rings; j++) for (let i = 0; i <= segs; i++) pos.push(i / segs, j / rings, 0);
    for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        uniform vec3 uTop; uniform float uWall, uTime, uRot, uWidth;
        varying vec2 vP; varying float vR; varying vec3 vW;
        void main() {
          float ang = position.x * 6.28318, r = position.y;
          float R = 420.0 * r;
          float sag = (38.0 + uWidth) * exp(-r * r / 0.05) * uWall;
          vec3 wp = vec3(uTop.x + cos(ang) * R, uTop.y + 18.0 - sag + 70.0 * r * r, uTop.z + sin(ang) * R);
          vW = wp; vR = r;
          float spin = mod(uTime * uRot * 0.12, 6.2831853);   // rigid: radius-dependent spin would wind into rings
          vP = vec2(cos(ang - spin), sin(ang - spin)) * r;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        ${FOG_GLSL}
        uniform float uWall, uFlash;
        uniform vec3 uAmb;
        uniform sampler2D uCloudTex;
        varying vec2 vP; varying float vR; varying vec3 vW;
        void main() {
          float n = texture2D(uCloudTex, vP * 1.4 + 0.2).r * 0.55 + texture2D(uCloudTex, vP * 4.1).g * 0.45;
          float a = uWall * smoothstep(1.0, 0.35, vR) * smoothstep(0.2, 0.62, n + 0.3 * (1.0 - vR));
          vec3 col = uAmb * mix(0.28, 0.5, n) + vec3(0.7, 0.75, 1.0) * uFlash * 0.4;
          col = tFog(col, length(cameraPosition - vW) * 0.55);
          if (a < 0.005) discard;
          gl_FragColor = vec4(col, a * 0.95);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false; m.renderOrder = 4;
    this.scene.add(m);
    return m;
  }

  particleMesh(count, vertex, fragment, extra = {}) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const r = makeRng(count * 7 + 11);
    const s = new Float32Array(count * 4);
    for (let i = 0; i < s.length; i++) s[i] = r();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s, 4));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.u.uTime, uBase: this.u.uBase, uWidth: this.u.uWidth, uRot: this.u.uRot,
        uAmount: { value: 0 }, uLight: { value: new THREE.Color() },
        uFogCol: { value: new THREE.Color() }, uFogNear: { value: 200 }, uFogFar: { value: 900 }, ...extra,
      },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: vertex, fragmentShader: `${FOG_GLSL}\n${fragment}`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = 6;
    this.scene.add(mesh);
    return { mesh };
  }

  makeDebris(count) {
    // sparse tumbling fragments (palm fronds, sheet scraps, branches) orbiting and lofted in the vortex
    return this.particleMesh(count, /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uWidth, uRot, uAmount;
      uniform vec3 uBase;
      varying vec2 vQ; varying float vA; varying vec3 vW; varying float vK;
      void main() {
        if (aSeed.w > uAmount) { gl_Position = vec4(2.0); return; }
        float life = fract(aSeed.y + uTime * (0.025 + 0.04 * aSeed.z));
        float r = uWidth * mix(0.9, 3.2, aSeed.x) * (0.8 + life * 0.8);
        float ang = aSeed.w * 51.0 + uTime * uRot * 22.0 / max(r, 6.0);
        float y = life * (12.0 + uWidth * 3.5) * aSeed.z + 0.5;
        vec3 c = uBase + vec3(cos(ang) * r, y, sin(ang) * r);
        float size = mix(0.15, 0.7, aSeed.x * aSeed.x);
        float spin = uTime * (3.0 + aSeed.z * 9.0);
        vec3 ax = normalize(vec3(sin(spin + aSeed.x * 9.0), cos(spin * 0.7), sin(spin * 1.3 + 2.0)));
        vec3 bx = normalize(cross(ax, vec3(0.3, 0.9, 0.2)));
        vec3 wp = c + (ax * position.x * 1.6 + bx * position.y * 0.5) * size;
        vQ = position.xy; vW = wp; vK = aSeed.z;
        vA = smoothstep(0.0, 0.1, life) * (1.0 - smoothstep(0.85, 1.0, life));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`, /* glsl */`
      uniform vec3 uLight;
      varying vec2 vQ; varying float vA; varying vec3 vW; varying float vK;
      void main() {
        if (abs(vQ.x) > 0.95 || abs(vQ.y) > 0.9) discard;
        vec3 col = mix(vec3(0.14, 0.12, 0.09), vec3(0.22, 0.25, 0.12), vK) * uLight * 1.3;
        col = tFog(col, length(cameraPosition - vW));
        gl_FragColor = vec4(col, vA * 0.9);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`);
  }

  makeLeaves(count) {
    // leaves and twigs streaming past the player in the inflow winds
    return this.particleMesh(count, /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uAmount;
      uniform vec3 uFocus;
      uniform vec2 uWind;
      varying vec2 vQ; varying float vA; varying vec3 vW; varying float vK;
      void main() {
        if (aSeed.w > uAmount) { gl_Position = vec4(2.0); return; }
        vec3 size = vec3(44.0, 9.0, 44.0);
        vec3 vel = vec3(uWind.x, -0.6 + sin(uTime * 2.0 + aSeed.x * 20.0) * 1.4, uWind.y) * (0.75 + 0.5 * aSeed.z);
        vec3 p = aSeed.xyz * size + vel * uTime;
        p.x += sin(uTime * 1.7 + aSeed.y * 30.0) * 1.2;
        p.z += cos(uTime * 1.3 + aSeed.x * 30.0) * 1.2;
        vec3 bmin = uFocus - vec3(22.0, -0.4, 22.0);
        p = bmin + mod(p - bmin, size);
        float spin = uTime * (4.0 + aSeed.z * 8.0) + aSeed.w * 30.0;
        vec3 ax = normalize(vec3(cos(spin), sin(spin * 0.7) * 0.6, sin(spin)));
        vec3 bx = normalize(cross(ax, vec3(0.0, 1.0, 0.3)));
        vec3 wp = p + (ax * position.x * 0.16 + bx * position.y * 0.08) * (0.8 + aSeed.x);
        vQ = position.xy; vW = wp; vK = aSeed.y;
        vec3 q = abs(p - uFocus - vec3(0.0, 4.1, 0.0)) / (size * 0.5);
        vA = 1.0 - smoothstep(0.75, 1.0, max(max(q.x, q.y), q.z));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`, /* glsl */`
      uniform vec3 uLight;
      varying vec2 vQ; varying float vA; varying vec3 vW; varying float vK;
      void main() {
        if (vQ.x * vQ.x + vQ.y * vQ.y * 1.6 > 1.0) discard;
        vec3 col = mix(vec3(0.24, 0.32, 0.12), vec3(0.42, 0.3, 0.14), vK) * uLight * 1.3;
        col = tFog(col, length(cameraPosition - vW));
        gl_FragColor = vec4(col, vA);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`, { uFocus: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2() } });
  }
}

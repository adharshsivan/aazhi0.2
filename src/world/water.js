import * as THREE from 'three';
import { signedDistance, boxBlur, axisSamples, vnoise, fbm } from './coastField.js';
import { coastUniforms, COAST_GLSL, makeWaterHeight } from './coastShading.js';

// ---------------------------------------------------------------------------
// Arabian Sea water surface.
// One graded-density mesh (fine over the beach, coarse offshore, out to the
// horizon) displaced by broad swells and refracted shore waves; shading is
// depth-aware from the baked coast field (no depth pre-pass): sky reflection
// with Fresnel, restrained sun glints, a water-body colour that only takes over
// where the bed is too deep to see, and thin, broken, dissipating foam.
// The seabed itself carries absorption, in-scattering and caustics
// (see coastShading.underwater), so shallow water stays truly translucent.
// ---------------------------------------------------------------------------

/** Bake bed height (+rocks), signed shore distance, beachness and phase wobble. */
function buildCoastFieldTexture(D) {
  const C = D.coast, N = C.N, ext = C.ext, cell = C.cell;
  const bed = Float32Array.from(C.H);
  const rockCov = new Float32Array(N * N);
  const toCell = (x, z) => [(x + ext) / cell - 0.5, (z + ext) / cell - 0.5];
  // rocks raise the bed (submerged stones read as shallower, emergent ones become shore)
  for (const q of D.rocks || []) {
    if (q.role === 'pebble' || q.R < 0.3) continue;      // too small to shape the surface
    const R = q.R * 0.82, cy = (q.top + q.bottom) / 2, hh = (q.top - q.bottom) / 2;
    const [ci, cj] = toCell(q.x, q.z);
    const rr = Math.ceil(R / cell) + 1;
    for (let j = Math.max(0, Math.floor(cj - rr)); j <= Math.min(N - 1, cj + rr); j++) {
      for (let i = Math.max(0, Math.floor(ci - rr)); i <= Math.min(N - 1, ci + rr); i++) {
        const dx = (i - ci) * cell, dz = (j - cj) * cell;
        const q2 = (dx * dx + dz * dz) / (R * R);
        if (q2 >= 1) continue;
        const k = j * N + i;
        bed[k] = Math.max(bed[k], cy + hh * Math.sqrt(1 - q2));
        if (q.top > -0.35) rockCov[k] = 1;
      }
    }
  }
  // shore = anything that breaks the surface: sand, rocks, seawall plate, pier piles
  const obst = new Uint8Array(N * N);
  for (let k = 0; k < N * N; k++) obst[k] = bed[k] > 0.0 || C.plate[k] ? 1 : 0;
  for (const [x, z] of D.pier?.piles || []) {
    const [ci, cj] = toCell(x, z);
    for (let j = Math.round(cj) - 1; j <= Math.round(cj) + 1; j++) for (let i = Math.round(ci) - 1; i <= Math.round(ci) + 1; i++) {
      if (Math.hypot((i - ci) * cell, (j - cj) * cell) < 0.36) obst[j * N + i] = 1;
    }
  }
  const G = boxBlur(signedDistance(obst, N, cell), N, 1, 1);
  const rc = boxBlur(rockCov, N, 4, 2);
  // low-res phase wobble, bilinearly expanded (bends crests so they never march in lockstep)
  const PN = 256, pc = (2 * ext) / PN, P = new Float32Array(PN * PN);
  for (let j = 0; j < PN; j++) for (let i = 0; i < PN; i++) {
    const x = -ext + (i + 0.5) * pc, z = -ext + (j + 0.5) * pc;
    P[j * PN + i] = 2.6 * (fbm(x * 0.03, z * 0.03, 61, 2) - 0.5) * 2 + 0.9 * (vnoise(x * 0.11, z * 0.11, 67) - 0.5) * 2;
  }
  const data = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const pj = Math.min(PN - 1.001, Math.max(0, ((j + 0.5) / N) * PN - 0.5));
    const j0 = Math.floor(pj), tj = pj - j0;
    for (let i = 0; i < N; i++) {
      const pi = Math.min(PN - 1.001, Math.max(0, ((i + 0.5) / N) * PN - 0.5));
      const i0 = Math.floor(pi), ti = pi - i0, b = j0 * PN + i0;
      const ph = (P[b] * (1 - ti) + P[b + 1] * ti) * (1 - tj) + (P[b + PN] * (1 - ti) + P[b + PN + 1] * ti) * tj;
      const k = j * N + i;
      data[k * 4] = bed[k];
      data[k * 4 + 1] = G[k];
      data[k * 4 + 2] = C.BI[k] * (1 - 0.92 * Math.min(1, rc[k] * 1.6));
      data[k * 4 + 3] = ph;
    }
  }
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, data, N, ext };
}

function waterGeometry() {
  const xs = axisSamples(-2600, 2600, -52, 28, 0.5, -82, 82, 1.5, 320, 1.22);
  const zs = axisSamples(-2600, 2600, 30, 76, 0.5, -74, 84, 1.5, 320, 1.22);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = (j * nx + i) * 3;
    pos[k] = xs[i]; pos[k + 1] = 0; pos[k + 2] = zs[j];
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let o = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3700);
  return g;
}

export function buildWater(scene, D, T, fog) {
  const field = buildCoastFieldTexture(D);
  coastUniforms.uCoast.value = field.tex;
  coastUniforms.uCoastExt.value = field.ext;
  const heightAt = makeWaterHeight(field.data, field.N, field.ext);

  const uniforms = {
    ...coastUniforms,
    uWaterN: { value: T.waterN },
    uFoamCol: { value: new THREE.Color('#f4f5f0') },
    uFogColor: { value: fog.color },
    uFogNear: { value: fog.near },
    uFogFar: { value: fog.far },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */`
      ${COAST_GLSL}
      varying vec3 vW;
      varying vec3 vNw;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec2 p = w.xz;
        float fade = 1.0 - smoothstep(150.0, 195.0, max(abs(p.x), abs(p.y)));
        vec3 n = vec3(0.0, 1.0, 0.0);
        float h0 = 0.0;
        if (fade > 0.0) {
          float e = 0.45;
          h0 = waterEta(p, uWTime, coastAt(p)) * fade;
          float hx = waterEta(p + vec2(e, 0.0), uWTime, coastAt(p + vec2(e, 0.0))) * fade;
          float hz = waterEta(p + vec2(0.0, e), uWTime, coastAt(p + vec2(0.0, e))) * fade;
          n = normalize(vec3(h0 - hx, e, h0 - hz));
        }
        w.y += h0;
        vW = w.xyz;
        vNw = n;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      ${COAST_GLSL}
      uniform sampler2D uWaterN;
      uniform vec3 uFoamCol;
      uniform vec3 uFogColor;
      uniform float uFogNear, uFogFar;
      varying vec3 vW;
      varying vec3 vNw;
      vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
      vec3 toDisplay(vec3 c) {
        #ifdef TONE_MAPPING
          c = toneMapping(c);
        #endif
        return linearToOutputTexel(vec4(c, 1.0)).rgb;
      }
      void main() {
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec4 c = coastAt(vW.xz);
        float depth = vW.y - c.r;
        if (depth < -0.04) discard;
        float t = uWTime;

        // ---- micro surface: two wind-ripple layers, drifting gust patches, calmer in the shallows
        float cat = texture2D(uNoiseTex, vW.xz * 0.0045 + vec2(t * 0.0016, -t * 0.0009)).g;
        float gust = smoothstep(0.3, 0.8, cat);
        float calm = 0.4 + 0.6 * smoothstep(0.05, 1.5, depth);
        float far = 1.0 - smoothstep(50.0, 480.0, dist);
        float rip = (0.13 + 0.2 * gust) * calm * (0.3 + 0.7 * far);
        vec4 r1 = texture2D(uWaterN, rot2(vW.xz, 0.369) * 0.083 - vec2(t * 0.042, 0.0));
        vec4 r2 = texture2D(uWaterN, rot2(vW.xz, -0.35) * 0.21 - vec2(t * 0.066, t * 0.012));
        vec2 slope = rot2(r1.rg * 2.0 - 1.0, -0.369) * 0.62 + rot2(r2.rg * 2.0 - 1.0, 0.35) * 0.38;
        vec3 N = normalize(vec3(vNw.x + slope.x * rip, vNw.y, vNw.z + slope.y * rip));

        // ---- reflection: sky + restrained sun
        float NdV = max(dot(N, V), 0.0);
        float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
        F *= 0.92;
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 refl = skyColor(R) * F;
        vec3 Hh = normalize(uSunDirW + V);
        float NdH = max(dot(N, Hh), 0.0);
        vec3 specC = uSunColW * (pow(NdH, 1600.0) * 2.2 + pow(NdH, 180.0) * 0.09) * smoothstep(0.0, 0.08, depth);

        // ---- water body: only where the bed is too deep to see (shallows are lit by the bed shader)
        float deepF = smoothstep(4.0, 11.0, depth);
        float lit = 0.88 + 0.12 * max(dot(N, uSunDirW), 0.0);
        vec3 body = uInscatter * lit;

        // ---- foam
        float G = c.g, beach = c.b;
        float env = shoreEnv(G);
        float grp = shoreGroup(vW.xz, t);
        float ph = mod(shorePsi1(c, t) - 1.5707963, 6.2831853);      // 0 as a crest passes, grows behind it
        float l1 = texture2D(uCoastTex, vW.xz * 0.19 + vec2(t * 0.011, -t * 0.006)).r;
        float l2 = texture2D(uCoastTex, rot2(vW.xz, 1.1) * 0.47 - vec2(t * 0.017, t * 0.009)).r;
        float lace = l1 * 0.62 + l2 * 0.38;
        // spilling breakers over the sandy shallows (thin, broken, trailing behind the crest)
        float surf = beach * smoothstep(0.012, 0.06, depth) * (1.0 - smoothstep(0.45, 0.95, depth)) * smoothstep(-1.0, 1.0, G);
        // crest line: a crisp leading edge, then foam thinning out behind it
        float brk = exp(-ph * 1.05) * (1.0 - smoothstep(5.95, 6.28, ph)) * mix(0.5, 1.0, smoothstep(0.55, 0.95, grp));
        float ph2 = mod(shorePsi2(c, t) - 1.5707963, 6.2831853);
        brk = max(brk, exp(-ph2 * 1.6) * (1.0 - smoothstep(6.0, 6.28, ph2)) * 0.45);
        // wash against rocks, wall and piles: a burst as each wave arrives, then fizzing out
        float coastPatch = smoothstep(0.2, 0.75, texture2D(uNoiseTex, vW.xz * 0.017 + 0.6).r);   // wash varies along the coast
        float rocky = (1.0 - beach) * (1.0 - smoothstep(0.1, 1.2 + 1.6 * l1 * coastPatch, G)) * (0.35 + 0.65 * coastPatch);
        float hit = exp(-ph * 1.3) * mix(0.5, 1.0, grp);
        // faint streaks dissipating seaward of the surf zone
        float drift = env * (1.0 - smoothstep(0.5, 7.0, G)) * (0.05 + 0.1 * beach);
        float amt = max(max(surf * brk * 0.8, rocky * (0.05 + 0.5 * hit)), drift);
        float foam = smoothstep(1.0 - amt, 1.12 - amt, lace);
        // thin contact line where the water meets sand, stone or timber
        float contact = smoothstep(-0.005, 0.012, depth) * (1.0 - smoothstep(0.02, 0.05 + 0.05 * l2, depth));
        foam = max(foam, contact * (0.35 + 0.5 * lace));
        foam *= 1.0 - 0.75 * smoothstep(120.0, 420.0, dist);

        // ---- compose (premultiplied)
        vec3 foamC = uFoamCol * (0.62 + 0.38 * max(dot(N, uSunDirW), 0.0)) * mix(vec3(1.0), uSunColW, 0.25) + uSkyTop * 0.06;
        vec3 col = refl + (1.0 - F) * body * deepF;
        float a = F + (1.0 - F) * deepF;
        col = col * (1.0 - foam) + foamC * foam;
        a = a * (1.0 - foam) + foam;
        specC *= 1.0 - foam;
        float edge = smoothstep(-0.03, 0.02, depth);
        col *= edge; a *= edge; specC *= edge;
        float fogK = smoothstep(uFogNear, uFogFar, dist);
        col = col * (1.0 - fogK) + uFogColor * fogK;
        a = a * (1.0 - fogK) + fogK;
        specC *= 1.0 - fogK;
        a = clamp(a, 0.0, 1.0);
        vec3 disp = a > 1e-4 ? toDisplay(col / a) * a : vec3(0.0);
        gl_FragColor = vec4(disp + toDisplay(specC), a);
      }`,
  });
  const water = new THREE.Mesh(waterGeometry(), mat);
  water.renderOrder = 1;
  water.frustumCulled = false;
  scene.add(water);

  return {
    heightAt,
    field,
    mesh: water,
    update(time) { coastUniforms.uWTime.value = time; },
  };
}

export function buildSky(scene, sunDir, horizon) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color('#4f8fcf') },
      uHorizon: { value: horizon },
      uSun: { value: sunDir.clone().normalize() },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uTop, uHorizon, uSun;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
        float s = max(dot(normalize(vDir), uSun), 0.0);
        col += vec3(1.0, 0.75, 0.45) * pow(s, 12.0) * 0.35 + vec3(1.0, 0.9, 0.7) * pow(s, 400.0) * 2.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), mat);
  sky.renderOrder = -1;
  scene.add(sky);
  return sky;
}

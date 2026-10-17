import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared coastal shading: one wave model (GLSL + an exact JS twin for floating
// props), a depth-aware underwater term applied by every submerged surface
// (seabed, rocks, seawall, piles, hulls), and the sand / seabed material.
//
// Coast field texture (half float, world [-ext, ext]^2):
//   R = bed height incl. rocks (m)   G = signed distance to shore (m, + seaward)
//   B = beachness (0 rocky .. 1 sand) A = wave phase offset (rad, refraction wobble)
// ---------------------------------------------------------------------------

const placeholder = (() => {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

export const coastUniforms = {
  uWTime: { value: 0 },
  uCoast: { value: placeholder },
  uCoastExt: { value: 160 },
  uSunDirW: { value: new THREE.Vector3(-0.78, 0.52, 0.36).normalize() },
  uSunColW: { value: new THREE.Color(1.0, 0.84, 0.64) },
  uSkyTop: { value: new THREE.Color('#4f8fcf') },
  uSkyHorizon: { value: new THREE.Color('#f1d9b8') },
  // seawater optics (per metre, linear RGB): strong red absorption, mild green/blue,
  // single-scattering colour of the water body (muted teal / blue-green)
  uAbsorb: { value: new THREE.Vector3(0.46, 0.085, 0.068) },
  uInscatter: { value: new THREE.Color('#235e6d') },
  uScatterK: { value: 0.14 },
  uCoastTex: { value: placeholder },
  uNoiseTex: { value: placeholder },
};

// Directional swell components [dirX, dirZ, wavelength, amplitude, phase] (travel direction).
export const SWELLS = [
  [0.932, -0.362, 36, 0.05, 0.0],
  [0.78, -0.626, 22, 0.032, 1.7],
  [0.992, -0.124, 14, 0.018, 4.1],
  [0.574, 0.819, 8.5, 0.008, 2.3],
];
// Shore-following (refracted) components: psi = w t + k G + m A + p
export const SHORE = { w1: 0.84, k1: 0.70, a1: 0.060, w2: 1.03, k2: 0.95, m2: 1.6, p2: 2.1, a2: 0.024 };

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const swellGlsl = SWELLS.map(([dx, dz, L, A, ph]) => {
  const k = (2 * Math.PI) / L, w = Math.sqrt(9.81 * k);
  return `h += ${f(A)} * sin(${f(k)} * dot(vec2(${f(dx)}, ${f(dz)}), p) - ${f(w)} * t + ${f(ph)});`;
}).join('\n    ');

export const COAST_GLSL = /* glsl */`
uniform float uWTime;
uniform sampler2D uCoast;
uniform float uCoastExt;
uniform vec3 uSunDirW;
uniform vec3 uSunColW;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uAbsorb;
uniform vec3 uInscatter;
uniform float uScatterK;
uniform sampler2D uCoastTex;
uniform sampler2D uNoiseTex;

vec4 coastAt(vec2 xz) {
  vec2 uv = (xz + uCoastExt) / (2.0 * uCoastExt);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(-16.0, 300.0, 0.0, 0.0);
  return texture2D(uCoast, uv);
}
float swellH(vec2 p, float t) {
  float h = 0.0;
  ${swellGlsl}
  return h;
}
float shoreEnv(float G) { return 1.0 - smoothstep(6.0, 30.0, G); }
float shoreGroup(vec2 p, float t) { return 0.72 + 0.28 * sin(t * 0.083 + p.x * 0.021 - p.y * 0.017); }
float shorePsi1(vec4 c, float t) { return ${f(SHORE.w1)} * t + ${f(SHORE.k1)} * c.g + c.a; }
float shorePsi2(vec4 c, float t) { return ${f(SHORE.w2)} * t + ${f(SHORE.k2)} * c.g + c.a * ${f(SHORE.m2)} + ${f(SHORE.p2)}; }
// Water surface height: open swell (damped in the shallows) + refracted shore waves
float waterEta(vec2 p, float t, vec4 c) {
  float depth = max(-c.r, 0.0);
  float env = shoreEnv(c.g);
  float sw = swellH(p, t) * smoothstep(0.0, 2.5, depth) * (1.0 - 0.65 * env);
  return sw + env * (${f(SHORE.a1)} * shoreGroup(p, t) * sin(shorePsi1(c, t)) + ${f(SHORE.a2)} * sin(shorePsi2(c, t)));
}
vec3 skyColor(vec3 R) {
  float h = max(R.y, 0.0);
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(h, 0.55));
  float s = max(dot(R, uSunDirW), 0.0);
  return col + vec3(1.0, 0.75, 0.45) * pow(s, 12.0) * 0.35;
}
// Light reaching a submerged surface and travelling back up through the water:
// two-way Beer-Lambert absorption, in-scattering towards the water body colour,
// and animated caustics fading with depth.
vec3 underwater(vec3 col, vec3 wp, float sunFacing) {
  if (wp.y > 0.3) return col;                    // above the highest wave: skip the lookups
  vec4 c = coastAt(wp.xz);
  float d = waterEta(wp.xz, uWTime, c) - wp.y;
  if (d <= 0.0) return col;
  vec3 V = normalize(cameraPosition - wp);
  float cv = sqrt(1.0 - (1.0 - V.y * V.y) * 0.5625);
  float cl = sqrt(1.0 - (1.0 - uSunDirW.y * uSunDirW.y) * 0.5625);
  float path = d / max(cv, 0.25) + d / max(cl, 0.25);
  vec2 cp = wp.xz;
  float c1 = texture2D(uCoastTex, cp * 0.17 + vec2(uWTime * 0.019, uWTime * 0.011)).g;
  float c2 = texture2D(uCoastTex, mat2(0.8, -0.6, 0.6, 0.8) * cp * 0.21 - vec2(uWTime * 0.014, -uWTime * 0.017)).g;
  float caus = min(c1, c2) * 2.2 + c1 * c2 * 1.2;
  float patchy = texture2D(uNoiseTex, cp * 0.031 + vec2(uWTime * 0.004, 0.0)).b;
  float cAmt = smoothstep(0.0, 0.35, d) * exp(-d * 0.5) * sunFacing * (0.35 + 0.9 * smoothstep(0.3, 0.75, patchy));
  col *= 1.0 + caus * cAmt * 0.85;
  float soft = smoothstep(0.0, 0.12, d);
  col = col * mix(vec3(1.0), exp(-uAbsorb * path), soft) + uInscatter * (1.0 - exp(-uScatterK * path)) * soft;
  // suspended sediment of a monsoon coast: mild greying with optical depth (keeps the shallows off neon)
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum) * vec3(0.92, 1.0, 1.0), 0.2 * (1.0 - exp(-path * 0.35)) * soft);
  return col;
}
`;

/** Patch a built-in lit material so fragments below the waterline get the underwater term. */
export function patchUnderwater(mat, key) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, coastUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUWPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 uwp = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            uwp = batchingMatrix * uwp;
          #endif
          #ifdef USE_INSTANCING
            uwp = instanceMatrix * uwp;
          #endif
          vUWPos = (modelMatrix * uwp).xyz;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vUWPos;\n${COAST_GLSL}`)
      .replace('#include <opaque_fragment>', `outgoingLight = underwater(outgoingLight, vUWPos, 0.6);\n#include <opaque_fragment>`);
  };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => `${prevKey()}|uw-${key}`;
  return mat;
}

// ---------------------------------------------------------------------------
// JS twin of the GLSL wave model (boats, buoys and wakes ride the same surface)
// ---------------------------------------------------------------------------
export function makeWaterHeight(fieldData, N, ext) {
  const cell = (2 * ext) / N;
  const sample = (x, z, out) => {
    let fx = (x + ext) / cell - 0.5, fz = (z + ext) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) { out[0] = -16; out[1] = 300; out[2] = 0; out[3] = 0; return out; }
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = (j * N + i) * 4, k2 = k + N * 4;
    for (let c = 0; c < 4; c++) {
      const a = fieldData[k + c], b = fieldData[k + 4 + c], cc = fieldData[k2 + c], d = fieldData[k2 + 4 + c];
      out[c] = (a + (b - a) * tx) * (1 - tz) + (cc + (d - cc) * tx) * tz;
    }
    return out;
  };
  const tmp = [0, 0, 0, 0];
  const sw = SWELLS.map(([dx, dz, L, A, ph]) => { const k = (2 * Math.PI) / L; return { dx, dz, k, w: Math.sqrt(9.81 * k), A, ph }; });
  const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  return (x, z, t) => {
    const c = sample(x, z, tmp);
    let h = 0;
    for (const s of sw) h += s.A * Math.sin(s.k * (s.dx * x + s.dz * z) - s.w * t + s.ph);
    const depth = Math.max(-c[0], 0), env = 1 - ss(6, 30, c[1]);
    h *= ss(0, 2.5, depth) * (1 - 0.65 * env);
    const grp = 0.72 + 0.28 * Math.sin(t * 0.083 + x * 0.021 - z * 0.017);
    const p1 = SHORE.w1 * t + SHORE.k1 * c[1] + c[3];
    const p2 = SHORE.w2 * t + SHORE.k2 * c[1] + c[3] * SHORE.m2 + SHORE.p2;
    return h + env * (SHORE.a1 * grp * Math.sin(p1) + SHORE.a2 * Math.sin(p2));
  };
}

// ---------------------------------------------------------------------------
// Sand + seabed material (single terrain mesh from dry berm to offshore floor)
// ---------------------------------------------------------------------------
export function makeCoastGroundMaterial(T) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const U = {
    uSandA: { value: T.sandA },
    uSandN: { value: T.sandN },
    uBeachDetail: { value: placeholder },
    uBeachRect: { value: new THREE.Vector4(-42, 34, 18, 64) },
    uBeachTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
    uDryCol: { value: new THREE.Color('#dccaa6') },
    uDampCol: { value: new THREE.Color('#b29a77') },
    uWetCol: { value: new THREE.Color('#917c60') },
    uBedCol: { value: new THREE.Color('#cbbfa0') },
    uRubbleCol: { value: new THREE.Color('#7a7062') },
    uWeedCol: { value: new THREE.Color('#4a5531') },
    uMineralCol: { value: new THREE.Color('#463f38') },
    uFoamCol: { value: new THREE.Color('#f3f4ef') },
  };
  m.userData.uniforms = U;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, coastUniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;\nvarying vec3 vGN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGN = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGW;
        varying vec3 vGN;
        ${COAST_GLSL}
        uniform sampler2D uSandA;
        uniform sampler2D uSandN;
        uniform sampler2D uBeachDetail;
        uniform vec4 uBeachRect;
        uniform vec2 uBeachTexel;
        uniform vec3 uDryCol, uDampCol, uWetCol, uBedCol, uRubbleCol, uWeedCol, uMineralCol, uFoamCol;
        vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
        // Swash: when did the shore wave last leave this patch of sand?
        //  returns wetness (1 = inside swash zone), gloss (fresh water film), residue (fading foam)
        float swashState(vec3 wp, vec4 c, out float gloss, out float residue) {
          float t = uWTime;
          float env = shoreEnv(c.g);
          float a1 = 0.060 * shoreGroup(wp.xz, t) * env;
          float y = wp.y - 0.024 * env * sin(shorePsi2(c, t));
          gloss = 0.0; residue = 0.0;
          if (a1 < 1e-3) return 0.0;
          float s = y / a1;
          // saturation fades up the beach face: soaked low down, merely damp near the top of the run-up
          float soak = 1.0 - smoothstep(-0.6, 1.5, s) * 0.55;
          if (s >= 1.0) return soak * (1.0 - smoothstep(1.0, 1.9, s));
          if (s <= -1.0) return 1.0;
          float as = asin(s);
          float since = mod(shorePsi1(c, t) - (3.14159265 - as), 6.2831853);
          float window = 3.14159265 + 2.0 * as;            // phase span the sand stays uncovered
          if (since >= window) return 1.0;                 // under water right now
          float tau = since / ${f(SHORE.w1)};
          gloss = exp(-tau * 0.5) * (1.0 - smoothstep(0.4, 1.0, s) * 0.5);
          residue = exp(-tau * 0.38) * smoothstep(-0.4, 0.8, s);
          return max(soak, gloss);
        }`)
      .replace('#include <map_fragment>', `
        vec2 gxz = vGW.xz;
        float gy = vGW.y;
        float gCam = length(cameraPosition - vGW);
        vec4 gC = coastAt(gxz);
        float gBeach = gC.b;
        vec4 nM = texture2D(uNoiseTex, gxz * 0.012);
        vec4 nS = texture2D(uNoiseTex, gxz * 0.067 + 0.31);
        // ---- moisture zones: dry berm, damp backshore, saturated swash zone, seabed
        float gGloss, gResidue;
        float gSwash = swashState(vGW, gC, gGloss, gResidue);
        float wetTop = 0.06 + 0.05 * nS.b;
        float dampTop = 0.32 + 0.1 * nS.r;
        float gDamp = 1.0 - smoothstep(wetTop, dampTop, gy);
        float gWet = max((1.0 - smoothstep(wetTop - 0.08, wetTop + 0.05, gy)) * 0.8, gSwash);
        float gSub = smoothstep(0.03, -0.3, gy);
        // ---- colours
        vec3 dryC = uDryCol * (0.9 + 0.2 * nM.r) * mix(vec3(1.0), vec3(1.03, 1.0, 0.92), nS.g);
        vec3 dampC = uDampCol * (0.92 + 0.16 * nM.g);
        vec3 wetC = uWetCol * (0.9 + 0.2 * nM.g);
        float rubble = (1.0 - gBeach * 0.9) * (1.0 - smoothstep(1.5, 7.0 + 5.0 * nS.a, gC.g));
        float weed = smoothstep(0.66, 0.82, nS.a * 0.6 + nM.a * 0.4) * smoothstep(-1.4, -3.0, gy) * (1.0 - rubble) * 0.6;
        vec3 bedC = uBedCol * (0.86 + 0.26 * nM.b);
        bedC = mix(bedC, uRubbleCol * (0.75 + 0.5 * nS.b), rubble);
        bedC = mix(bedC, uWeedCol * (0.8 + 0.4 * nS.g), weed * 0.4);
        vec3 gCol = mix(dryC, dampC, gDamp);
        gCol = mix(gCol, wetC, gWet);
        gCol = mix(gCol, bedC, gSub);
        // dark heavy-mineral streaks (as on the Kerala coast) stretched along the swash zone
        float stk = texture2D(uNoiseTex, vec2(gxz.x * 0.011, gxz.y * 0.085) + 0.5).a;
        stk = smoothstep(0.6, 0.8, stk) * smoothstep(0.48, 0.1, gy) * smoothstep(-0.35, 0.02, gy) * gBeach;
        gCol = mix(gCol, uMineralCol, stk * 0.26 * smoothstep(0.3, 0.7, texture2D(uSandA, gxz * 0.05).r));
        // wrack line: the last high-water mark of seaweed, husks and shell grit
        float wrack = exp(-pow((gy - dampTop + 0.03) / 0.028, 2.0)) * smoothstep(0.42, 0.62, nS.g) * gBeach;
        float wrackFine = texture2D(uCoastTex, gxz * 0.9).r;
        gCol *= 1.0 - wrack * 0.45 * smoothstep(0.25, 0.6, wrackFine);
        // grain detail (two rotated scales, calmer on wet sand and at distance)
        vec3 det = texture2D(uSandA, gxz * 0.31).rgb;
        vec3 det2 = texture2D(uSandA, rot2(gxz, 0.52) * 0.093).rgb;
        vec3 gDet = mix(det, det2, 0.4) * 2.0;
        gCol *= mix(vec3(1.0), gDet, mix(1.0, 0.6, gWet) * (1.0 - 0.6 * smoothstep(60.0, 180.0, gCam)));
        // ---- footprints + contact occlusion
        vec2 gSlope = vec2(0.0);
        vec2 fuv = (gxz - uBeachRect.xy) / (uBeachRect.zw - uBeachRect.xy);
        if (fuv.x > 0.0 && fuv.y > 0.0 && fuv.x < 1.0 && fuv.y < 1.0) {
          vec4 f0 = texture2D(uBeachDetail, fuv);
          float fpk = 1.0 - smoothstep(22.0, 55.0, gCam);
          if (fpk > 0.0) {
            float fx = texture2D(uBeachDetail, fuv + vec2(uBeachTexel.x, 0.0)).r - texture2D(uBeachDetail, fuv - vec2(uBeachTexel.x, 0.0)).r;
            float fz = texture2D(uBeachDetail, fuv + vec2(0.0, uBeachTexel.y)).r - texture2D(uBeachDetail, fuv - vec2(0.0, uBeachTexel.y)).r;
            gSlope -= vec2(fx, fz) * 0.85 * fpk;
            gCol *= 1.0 + (f0.r - 0.5) * 0.5 * fpk;
          }
          gCol *= mix(0.5, 1.0, f0.g);
        }
        // ---- fading foam lace left on freshly washed sand
        float lace = texture2D(uCoastTex, gxz * 0.36 + vec2(0.0, uWTime * 0.004)).r;
        float gRes = gResidue * (1.0 - gSub);
        float resF = smoothstep(1.02 - gRes, 1.22 - gRes, lace) * gRes;
        gCol = mix(gCol, uFoamCol, resF * 0.85);
        diffuseColor.rgb = gCol;
        // ---- relief: wind ripples on dry sand, smoothed swash face, wave ripples underwater
        float ripFade = 1.0 - smoothstep(30.0, 130.0, gCam);
        vec4 rA = texture2D(uSandN, rot2(gxz, 0.6) * 0.42);
        vec2 sA = rot2(rA.rg * 2.0 - 1.0, -0.6);
        vec4 rB = texture2D(uSandN, gxz * vec2(0.24, 0.36) + 0.17);
        vec2 sB = (rB.rg * 2.0 - 1.0) * vec2(0.24, 0.36) / 0.3;
        float ripK = mix(mix(0.85, 0.22, gWet), 0.75, gSub) * ripFade;
        gSlope += mix(sA, sB, gSub) * ripK * 0.32;
        float ripH = mix(rA.b, rB.b, gSub);
        diffuseColor.rgb *= 1.0 - (0.5 - ripH) * 0.12 * ripK;
        vec3 gN = normalize(vGN);
        vec3 gNw = normalize(vec3(gN.x + gSlope.x * gN.y, gN.y, gN.z + gSlope.y * gN.y));
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(0.97, 0.86, gDamp), 0.5, gWet);
        roughnessFactor = mix(roughnessFactor, 0.14, gGloss * (1.0 - gSub));
        roughnessFactor = mix(roughnessFactor, 0.7, gSub);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(gNw, 0.0)).xyz);`)
      .replace('#include <opaque_fragment>', `
        {
          // glossy wet sand mirrors the sky; the draining water film is brighter still
          vec3 Vw = normalize(cameraPosition - vGW);
          vec3 Rw = reflect(-Vw, gNw);
          float fr = 0.02 + 0.98 * pow(1.0 - max(dot(gNw, Vw), 0.0), 5.0);
          outgoingLight += skyColor(Rw) * fr * (gWet * 0.28 + gGloss * 0.72) * (1.0 - gSub);
          outgoingLight = underwater(outgoingLight, vGW, max(dot(gNw, uSunDirW), 0.0));
        }
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'aazhi-coast-ground-v1';
  return m;
}

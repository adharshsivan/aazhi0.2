import * as THREE from 'three';
import { atmoUniforms, CLOUD_GLSL } from './atmoShared.js';

// ---------------------------------------------------------------------------
// Weather on existing surfaces, injected into every lit material's shader (no
// geometry changes):
//  - moving cloud shadows on the sun / moon light (same field as the sky)
//  - ground-hugging height mist folded into the scene fog
//  - wetness: darker albedo, glossier roughness, sky sheen (profile per material)
//  - puddles on roads & pavements with raindrop rings while it rains
//  - warm pools of street-lamp light at night (baked lamp map, one texture tap)
// ---------------------------------------------------------------------------

const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= atmoShadow;',
);

const FRAG_PARS = /* glsl */`
varying vec3 vAtmoW;
${CLOUD_GLSL}
uniform float uAtmoTime;
uniform float uMistDensity, uMistHeight;
uniform float uWet, uPuddle, uRainNow;
uniform sampler2D uPuddleNoise;
uniform vec3 uSkyZenW, uSkyHorW;
uniform sampler2D uLampMap;
uniform vec4 uLampRect;
uniform float uLampLevel;
uniform vec3 uLampColor;
vec2 atmoRipple(vec2 p, float t, float seed) {
  vec2 g = p * 3.2 + seed;
  vec2 cell = floor(g), f = fract(g) - 0.5;
  float h = fract(sin(dot(cell, vec2(12.9898, 78.233)) + seed) * 43758.5453);
  vec2 off = (vec2(h, fract(h * 7.13)) - 0.5) * 0.5;
  float ph = fract(t * (0.9 + h * 0.6) + h);
  vec2 d = f - off;
  float r = length(d), R = ph * 0.42;
  float ring = sin((r - R) * 70.0) * smoothstep(0.07, 0.0, abs(r - R)) * (1.0 - ph);
  return d / max(r, 1e-3) * ring;
}
`;

function wetDefines({ dark = 0.18, rough = 0.4, side = 0.35, refl = 0.25, puddle = 0 } = {}) {
  return `#define ATMO_WET\n#define WET_DARK ${dark.toFixed(3)}\n#define WET_ROUGH ${rough.toFixed(3)}\n#define WET_SIDE ${side.toFixed(3)}\n#define WET_REFL ${refl.toFixed(3)}\n`
    + (puddle > 0 ? `#define WET_PUDDLE\n#define PUDDLE_AMT ${puddle.toFixed(3)}\n` : '');
}

const WET_PRELUDE = /* glsl */`
float atmoShadow = cloudShadowAt(vAtmoW);
float atmoPuddle = 0.0;
float atmoUp = 0.0;
#if defined( ATMO_WET ) && defined( STANDARD )
{
  vec3 wN = inverseTransformDirection(normal, viewMatrix);
  atmoUp = smoothstep(0.25, 0.9, wN.y);
  float w = uWet * mix(WET_SIDE, 1.0, atmoUp);
  material.diffuseColor *= 1.0 - WET_DARK * w;
  material.roughness = mix(material.roughness, max(WET_ROUGH, 0.06), w);
  #ifdef WET_PUDDLE
    float pn = texture2D(uPuddleNoise, vAtmoW.xz * 0.061).r * 0.62 + texture2D(uPuddleNoise, vAtmoW.xz * 0.21 + 0.4).g * 0.38;
    float th = 1.0 - uPuddle * PUDDLE_AMT * 0.3;
    atmoPuddle = smoothstep(th, th + 0.03, pn) * smoothstep(0.94, 0.995, wN.y) * step(0.02, uPuddle);
    float damp = smoothstep(th - 0.07, th, pn) * (1.0 - atmoPuddle) * step(0.02, uPuddle);
    material.diffuseColor *= 1.0 - 0.2 * damp;
    if (atmoPuddle > 0.0) {
      material.diffuseColor *= mix(1.0, 0.42, atmoPuddle);
      material.roughness = mix(material.roughness, 0.06, atmoPuddle);
      vec2 rip = (atmoRipple(vAtmoW.xz, uAtmoTime, 0.0) + atmoRipple(vAtmoW.xz * 1.37, uAtmoTime * 1.1, 3.7)) * 0.09 * uRainNow;
      vec3 pN = normalize(vec3(rip.x, 1.0, rip.y));
      normal = normalize(mix(normal, (viewMatrix * vec4(pN, 0.0)).xyz, atmoPuddle));
    }
  #endif
}
#endif
`;

const OPAQUE_PRELUDE = /* glsl */`
#if defined( ATMO_WET ) && defined( STANDARD )
{
  vec3 aV = normalize(cameraPosition - vAtmoW);
  vec3 aN = inverseTransformDirection(normal, viewMatrix);
  vec3 aR = reflect(-aV, aN);
  float aF = 0.02 + 0.98 * pow(1.0 - max(dot(aN, aV), 0.0), 5.0);
  vec3 skyR = mix(uSkyHorW, uSkyZenW, pow(max(aR.y, 0.0), 0.5));
  outgoingLight += skyR * aF * (atmoPuddle * 0.85 + uWet * WET_REFL * atmoUp);
}
#endif
if (uLampLevel > 0.001) {
  vec2 luv = (vAtmoW.xz - uLampRect.xy) / (uLampRect.zw - uLampRect.xy);
  if (luv.x > 0.0 && luv.y > 0.0 && luv.x < 1.0 && luv.y < 1.0) {
    float lm = texture2D(uLampMap, luv).r;
    float hf = 1.0 - smoothstep(2.4, 8.5, vAtmoW.y);
    outgoingLight += diffuseColor.rgb * uLampColor * lm * uLampLevel * hf * 1.7;
  }
}
`;

const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  float aFog = smoothstep(fogNear, fogFar, vFogDepth);
  if (uMistDensity > 0.0) {
    // exponential height mist integrated along the view ray (thick in hollows and over the sea, thin from above)
    float H = uMistHeight;
    float hp = max(vAtmoW.y, 0.0), hc = max(cameraPosition.y, 0.0);
    float ea = exp(-hp / H), eb = exp(-hc / H), dh = hc - hp;
    float avg = abs(dh) > 0.05 ? (ea - eb) * H / dh : ea;
    float mist = 1.0 - exp(-uMistDensity * vFogDepth * avg);
    aFog = 1.0 - (1.0 - aFog) * (1.0 - mist);
  }
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, aFog);
#endif
`;

/** Patch one material. `wet`: wetness profile or null (shadows, mist and lamps only). */
export function patchMaterial(m, wet) {
  if (m.userData.atmoPatched) return;
  m.userData.atmoPatched = true;
  const prev = m.onBeforeCompile;
  const defs = wet ? wetDefines(wet) : '';
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(m, sh, r);
    Object.assign(sh.uniforms, atmoUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vAtmoW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvAtmoW = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);');
    sh.fragmentShader = defs + sh.fragmentShader
      .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${FRAG_PARS}`)
      .replace('#include <lights_fragment_begin>', `${WET_PRELUDE}\n${LIGHTS_BEGIN}`)
      .replace('#include <opaque_fragment>', `${OPAQUE_PRELUDE}\n#include <opaque_fragment>`)
      .replace('#include <fog_fragment>', FOG_FRAGMENT);
  };
  const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : () => '';
  m.customProgramCacheKey = () => `${prevKey()}|atmo${wet ? JSON.stringify(wet) : ''}`;
  m.needsUpdate = true;
}

/** Patch every fogged, lit (or basic) material in the scene; `profileOf(material)` picks a wet profile. */
export function installSurfaceFx(scene, profileOf) {
  const seen = new Set();
  let n = 0;
  scene.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if (m.isShaderMaterial || m.isRawShaderMaterial || m.fog === false || m.isPointsMaterial || m.isLineBasicMaterial || m.isSpriteMaterial) continue;
      patchMaterial(m, profileOf(m));
      n++;
    }
  });
  return n;
}

/** Top-down map of street-lamp light (sum of soft pools), sampled once per fragment. */
export function makeLampMap(lamps, rect = [-70, -70, 70, 70], N = 256) {
  const [x0, z0, x1, z1] = rect;
  const d = new Float32Array(N * N);
  for (const [lx, lz, fx = 0, fz = 0] of lamps) {
    const cx = lx + fx * 1.2, cz = lz + fz * 1.2;
    for (let j = 0; j < N; j++) {
      const z = z0 + ((j + 0.5) / N) * (z1 - z0);
      if (Math.abs(z - cz) > 9) continue;
      for (let i = 0; i < N; i++) {
        const x = x0 + ((i + 0.5) / N) * (x1 - x0);
        const r2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (r2 > 81) continue;
        d[j * N + i] += Math.exp(-r2 / 14) * 0.85 + Math.exp(-r2 / 3) * 0.35;
      }
    }
  }
  const u = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) { const v = Math.min(255, Math.round(Math.min(1.4, d[i]) / 1.4 * 255)); u[i * 4] = v; u[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(u, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = false;
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}

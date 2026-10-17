import * as THREE from 'three';
import { ATLAS_W, ATLAS_H } from './atlas.js';
import { coastUniforms, COAST_GLSL } from '../world/coastShading.js';

// Shared nature materials (one for all vegetation, one for all rocks).

export const windUniforms = {
  uTime: { value: 0 },
  uWind: { value: 1.0 },
  uWindSpeed: { value: 1.0 },
  uWindDir: { value: new THREE.Vector2(0.84, 0.54).normalize() },
  uWindGust: { value: 0.48 },
  uWindTurb: { value: 0.42 },
  uSunDir: { value: new THREE.Vector3(-0.78, 0.52, 0.36).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.84, 0.64) },
};

/**
 * Vegetation: atlas map + vertex colour (tint/AO) + per-instance colour.
 * - Unpacks `wind` attribute into:
 *     - `isLeaf` (sign >= 0 for leaves/fronds, < 0 for woody trunks/branches)
 *     - `wTrunk` (floor(abs(wind)) * 0.01): cantilever trunk & branch sway
 *     - `wLeaf`  (fract(abs(wind))): high-frequency frond whip & leaflet flutter
 * - World-space travelling wind gusts + directional bend + length-preserving vertical dip
 *   so coconut trunks flex gracefully from base to crown and fronds whip in synchronization.
 */
export function makeVegMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({
    map: atlas, vertexColors: true, side: THREE.DoubleSide,
    alphaTest: 0.46, alphaToCoverage: false, roughness: 0.88, metalness: 0,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, windUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float wind;
        uniform float uTime;
        uniform float uWind;
        uniform float uWindSpeed;
        uniform vec2 uWindDir;
        uniform float uWindGust;
        uniform float uWindTurb;
        varying float vLeaf;`)
      .replace('#include <project_vertex>', `
        vLeaf = step(0.0, wind);
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          mvPosition = batchingMatrix * mvPosition;
        #endif
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          float wAbs = abs(wind);
          float wTrunk = floor(wAbs) * 0.01;
          float wLeaf = fract(wAbs);

          vec4 wp0 = mvPosition;
          vec4 wOrigin = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_BATCHING
            wOrigin = batchingMatrix * wOrigin;
          #endif
          #ifdef USE_INSTANCING
            wOrigin = instanceMatrix * wOrigin;
          #endif

          vec2 dir = normalize(uWindDir + vec2(1e-5, 0.0));
          vec2 perp = vec2(-dir.y, dir.x);
          float spd = max(0.05, uWindSpeed);
          float t = uTime * spd;

          // Per-tree spatial phase from instance world origin so adjacent trees don't move in lockstep
          float treePhase = dot(wOrigin.xz, dir) * 0.075 + dot(wOrigin.xz, perp) * 0.045;
          float treeHash = sin(wOrigin.x * 0.37 + wOrigin.z * 0.53) * 1.7;

          // Travelling atmospheric gust wave across the island
          float gustWave = 0.5 + 0.5 * sin(t * 0.72 - treePhase + sin(t * 0.31 + treeHash) * 0.65);
          float gustWave2 = 0.5 + 0.5 * sin(t * 1.35 - treePhase * 1.4 - treeHash);
          float gustEnv = mix(1.0, 0.45 + 1.05 * (0.68 * gustWave + 0.32 * gustWave2), clamp(uWindGust, 0.0, 2.0));

          // 1. Cantilever trunk & branch sway (smooth, coherent elastic bend + steady wind lean in strong gusts)
          float swayOsc = sin(t * 1.25 - treePhase + treeHash) * 0.65
                        + sin(t * 2.15 - treePhase * 1.3 - treeHash * 0.7) * 0.35;
          float steadyLean = uWind * (0.38 + 0.62 * gustEnv);
          float bendAlong = wTrunk * (steadyLean * 0.52 + uWind * gustEnv * swayOsc * 0.48);
          float bendCross = wTrunk * uWind * gustEnv * cos(t * 1.05 - treePhase * 0.9 + treeHash) * 0.16 * (0.5 + 0.5 * uWindTurb);

          vec2 trunkDisp = dir * bendAlong + perp * bendCross;
          // Arc-length preservation: as a tall coconut trunk bends horizontally, the crown dips slightly
          float hAbove = max(0.5, wp0.y - wOrigin.y);
          float trunkDip = -min(hAbove * 0.28, dot(trunkDisp, trunkDisp) / (2.2 * hAbove));

          // 2. Foliar whip & leaflet flutter (coconut frond tips, banana blades, canopy leaves)
          float leafPhase = t * 2.85 - dot(wp0.xz, dir) * 0.28 + wp0.y * 0.42 + treeHash;
          float whipAlong = wLeaf * uWind * gustEnv * (
            0.36 * gustWave +
            (0.62 * sin(leafPhase) + 0.32 * sin(leafPhase * 2.15 + 1.1)) * (0.55 + 0.65 * uWindTurb)
          );
          float whipCross = wLeaf * uWind * gustEnv * (0.38 * cos(leafPhase * 1.45 + wp0.x * 0.5)) * (0.5 + 0.7 * uWindTurb);
          float whipVert = wLeaf * uWind * gustEnv * (
            -0.22 * abs(sin(leafPhase * 0.9)) +
            0.24 * sin(leafPhase * 2.6 + wp0.z * 0.7) * (0.5 + 0.6 * uWindTurb)
          );

          vec3 worldDelta = vec3(
            trunkDisp.x + dir.x * whipAlong + perp.x * whipCross,
            trunkDip + whipVert,
            trunkDisp.y + dir.y * whipAlong + perp.y * whipCross
          );

          mvPosition.xyz += worldDelta;
        }
        vec4 displacedWorld = mvPosition;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <worldpos_vertex>', `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
        vec4 worldPosition = modelMatrix * displacedWorld;
      #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying float vLeaf;`)
      .replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <alphatest_fragment>', `
        float camDist = length(vViewPosition);
        diffuseColor.a *= 1.0 + smoothstep(26.0, 95.0, camDist) * 0.24 * vLeaf;
        #include <alphatest_fragment>
        diffuseColor.a = 1.0;`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 Vv = normalize(vViewPosition);
          float back = pow(max(dot(-Vv, Lv), 0.0), 3.5);
          float wrap = max(dot(normal, Lv) * 0.5 + 0.5, 0.0);
          outgoingLight += diffuseColor.rgb * uSunColor * vLeaf * (back * 0.24 + wrap * 0.06);
        }
        diffuseColor.a = 1.0;
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'aazhi-veg-v5';
  return m;
}

/**
 * Rocks: world-space triplanar detail texture (no stretching on any boulder
 * size), derivative bump from the same texture, wet/darker band and lower
 * roughness near the waterline, faint algae tint below it.
 */
export function makeRockMaterial({ albedo, normal: normalTex }) {
  const m = new THREE.MeshStandardMaterial({ map: albedo, vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRockNormal = { value: normalTex };
    Object.assign(sh.uniforms, coastUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            wp = batchingMatrix * wp;
          #endif
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
          #endif
          vRockW = (modelMatrix * wp).xyz;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRockW;\nuniform sampler2D uRockNormal;\nfloat rockH;\n${COAST_GLSL}`)
      .replace('#include <opaque_fragment>', `
        outgoingLight = underwater(outgoingLight, vRockW, max(dot(inverseTransformDirection(normal, viewMatrix), uSunDirW), 0.0));
        #include <opaque_fragment>`)
      .replace('#include <map_fragment>', `
        vec3 wn = inverseTransformDirection(normalize(vNormal), viewMatrix);
        vec3 tw = pow(abs(wn), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec3 tp = vRockW * 0.8;
        vec4 tri = texture2D(map, tp.zy) * tw.x + texture2D(map, tp.xz) * tw.y + texture2D(map, tp.xy) * tw.z;
        rockH = dot(tri.rgb, vec3(0.333));
        diffuseColor.rgb *= tri.rgb * 3.0;
        diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(-0.55, 0.45, wn.y));   // under-sides / joints between stones
        float wet = 1.0 - smoothstep(-0.05, 0.6, vRockW.y);
        diffuseColor.rgb *= mix(1.0, 0.58, wet);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.92, 0.72), (1.0 - smoothstep(-0.4, 0.2, vRockW.y)) * 0.8);
        diffuseColor.rgb *= 1.0 + 0.14 * smoothstep(0.55, 0.95, wn.y) * smoothstep(0.6, 1.4, vRockW.y);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= mix(1.0, 0.38, 1.0 - smoothstep(-0.1, 0.7, vRockW.y));
        roughnessFactor *= 0.9 + 0.2 * rockH;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // world-space triplanar normal mapping, whiteout blend (no screen derivatives)
          vec3 gn = inverseTransformDirection(normal, viewMatrix);
          vec3 bw = pow(abs(gn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
          vec3 tp = vRockW * 0.8;
          vec3 nX = texture2D(uRockNormal, tp.zy).xyz * 2.0 - 1.0;
          vec3 nY = texture2D(uRockNormal, tp.xz).xyz * 2.0 - 1.0;
          vec3 nZ = texture2D(uRockNormal, tp.xy).xyz * 2.0 - 1.0;
          nX = vec3(nX.xy + gn.zy, abs(nX.z) * gn.x);
          nY = vec3(nY.xy + gn.xz, abs(nY.z) * gn.y);
          nZ = vec3(nZ.xy + gn.xy, abs(nZ.z) * gn.z);
          vec3 wN = normalize(nX.zyx * bw.x + nY.xzy * bw.y + nZ.xyz * bw.z);
          normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
        }`);
  };
  m.customProgramCacheKey = () => 'aazhi-rock-v3';
  return m;
}

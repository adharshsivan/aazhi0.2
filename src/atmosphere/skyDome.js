import * as THREE from 'three';
import { atmoUniforms, CLOUD_GLSL } from './atmoShared.js';

// ---------------------------------------------------------------------------
// Sky dome: analytic twilight-aware gradient, Mie sun glow, belt of Venus,
// sun disc, phase-correct moon (lit by the real sun direction, earthshine,
// maria), sidereal star field + faint Milky Way, three cloud layers (cirrus,
// cumulus/stratus deck with light-direction self-shadowing, low scud), rain
// curtains, horizon haze and lightning-lit cloud interiors. One draw call.
// ---------------------------------------------------------------------------

export function makeSkyUniforms() {
  return {
    ...atmoUniforms,
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uZen: { value: new THREE.Color() },
    uHor: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uBelt: { value: new THREE.Color() },
    uSunGlowCol: { value: new THREE.Color() },
    uSunDisc: { value: new THREE.Color() },
    uMoonCol: { value: new THREE.Color() },
    uMoonGlow: { value: new THREE.Color() },
    uStarVis: { value: 0 },
    uStarBasis: { value: new THREE.Matrix3() },
    uCloudLit: { value: new THREE.Color() },
    uCloudAmb: { value: new THREE.Color() },
    uCloudDark: { value: new THREE.Color() },
    uDark: { value: 0 },
    uCirrus: { value: 0 },
    uScud: { value: 0 },
    uRain: { value: 0 },
    uRainCol: { value: new THREE.Color() },
    uHaze: { value: 0 },
    uFogCol: { value: new THREE.Color() },
    uCityGlow: { value: new THREE.Color() },
    uFlash: { value: 0 },
    uFlashDir: { value: new THREE.Vector3(1, 0.2, 0) },
    uFlashCol: { value: new THREE.Color(0.75, 0.8, 1.0) },
  };
}

export function buildSkyDome(scene, { lowQuality = false } = {}) {
  const uniforms = makeSkyUniforms();
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    defines: lowQuality ? { SKY_LQ: '' } : {},
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w * 0.99999;      // always at the far plane
      }`,
    fragmentShader: /* glsl */`
      ${CLOUD_GLSL}
      uniform float uAtmoTime;
      uniform vec3 uSunDir, uMoonDir;
      uniform vec3 uZen, uHor, uGlow, uBelt, uSunGlowCol, uSunDisc, uMoonCol, uMoonGlow;
      uniform float uStarVis;
      uniform mat3 uStarBasis;
      uniform vec3 uCloudLit, uCloudAmb, uCloudDark, uRainCol, uFogCol, uCityGlow, uFlashCol;
      uniform float uDark, uCirrus, uScud, uRain, uHaze, uFlash;
      uniform vec3 uFlashDir;
      varying vec3 vDir;

      float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
      vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        float hp = max(h, 0.0);
        float t = uAtmoTime;

        // ---- clear-air gradient
        float cs = dot(dir, uSunDir);
        float csh = clamp(cs * 0.5 + 0.5, 0.0, 1.0);
        // horizon is pale and cool away from the sun, warm towards it (avoids greying the blue)
        float hl = dot(uHor, vec3(0.2126, 0.7152, 0.0722));
        vec3 horCool = mix(uZen, vec3(hl) * vec3(0.92, 0.98, 1.06), 0.62);
        vec3 hor = mix(horCool, uHor, 0.25 + 0.75 * pow(csh, 1.6));
        vec3 sky = mix(hor, uZen, pow(smoothstep(0.0, 0.85, hp), 0.32));
        float sunSide = pow(csh, 2.6);
        float low = 1.0 - smoothstep(0.0, 0.32, hp);
        sky = mix(sky, uGlow, sunSide * low * 0.8);
        // anti-solar twilight band (belt of Venus) above the Earth's shadow
        float anti = pow(clamp(-cs * 0.5 + 0.5, 0.0, 1.0), 3.0);
        sky += uBelt * anti * exp(-pow((hp - 0.09) / 0.07, 2.0));
        float csp = max(cs, 0.0);
        sky += uSunGlowCol * (pow(csp, 6.0) * 0.16 + pow(csp, 48.0) * 0.4 + pow(csp, 700.0) * 1.4);
        // Kochi's lights warming the eastern horizon at night
        sky += uCityGlow * exp(-hp * 9.0) * (0.35 + 0.65 * max(dir.x * 0.8 - dir.z * 0.2, 0.0));

        // ---- stars and Milky Way (rotate with sidereal time)
        if (uStarVis > 0.002 && h > -0.02) {
          vec3 eq = transpose(uStarBasis) * dir;
          vec3 sp = eq * 240.0;
          vec3 cell = floor(sp);
          float hs = hash13(cell);
          float star = 0.0;
          vec3 tint = vec3(1.0);
          if (hs > 0.968) {
            vec3 jit = (hash33(cell) - 0.5) * 0.55;
            float d = length(fract(sp) - 0.5 - jit);
            float mag = pow(hash13(cell + 17.0), 7.0);
            #ifndef SKY_LQ
              float tw = 0.7 + 0.3 * sin(t * (1.7 + hs * 6.0) + hs * 91.0) * (1.0 - smoothstep(0.1, 0.5, hp) * 0.6);
            #else
              float tw = 1.0;
            #endif
            star = smoothstep(0.17 + mag * 0.12, 0.0, d) * (0.18 + 2.6 * mag) * tw;
            float tc = hash13(cell + 5.0);
            tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), tc);
          }
          vec3 gp = vec3(-0.8676, -0.1981, 0.4560);     // north galactic pole (equatorial)
          float band = exp(-pow(dot(eq, gp), 2.0) / 0.03);
          float mw = band * (0.55 + 0.45 * texture2D(uCloudTex, eq.xy * 1.7 + eq.z).g) * 0.045;
          float vis = uStarVis * smoothstep(-0.02, 0.2, h);
          sky += (tint * star + vec3(0.62, 0.7, 0.95) * mw) * vis;
        }

        // ---- sun disc (limb-darkened)
        float as = acos(clamp(cs, -1.0, 1.0));
        float rS = 0.0118;
        sky += uSunDisc * smoothstep(rS, rS * 0.82, as) * (1.0 - 0.45 * pow(clamp(as / rS, 0.0, 1.0), 2.0));

        // ---- moon: sphere lit by the actual sun direction (true phase + terminator)
        float cm = dot(dir, uMoonDir);
        float rM = 0.0165;
        if (cm > cos(rM * 1.1)) {
          vec3 up0 = abs(uMoonDir.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
          vec3 right = normalize(cross(uMoonDir, up0));
          vec3 upv = cross(right, uMoonDir);
          vec3 off = dir - uMoonDir * cm;
          vec2 uv = vec2(dot(off, right), dot(off, upv)) / rM;
          float r2 = dot(uv, uv);
          if (r2 < 1.0) {
            vec3 n = right * uv.x + upv * uv.y - uMoonDir * sqrt(1.0 - r2);
            float lit = smoothstep(-0.03, 0.1, dot(n, uSunDir));
            float maria = texture2D(uCloudTex, uv * 0.33 + vec2(0.21, 0.63)).a;
            float mDark = mix(1.0, 0.68, smoothstep(0.5, 0.78, maria));
            float limb = 0.82 + 0.18 * sqrt(1.0 - r2);
            float edge = smoothstep(1.0, 0.9, r2);
            sky += uMoonCol * mDark * limb * (lit + 0.012) * edge;
          }
        }
        float cmp = max(cm, 0.0);
        sky += uMoonGlow * (pow(cmp, 900.0) * 0.5 + pow(cmp, 60.0) * 0.1 + pow(cmp, 8.0) * 0.025);

        // ---- clouds
        vec3 cam = cameraPosition;
        if (h > 0.0) {
          float hzn = smoothstep(0.0, 0.07, h);
          // cirrus: high wind-combed ice, catches sunset colour first
          if (uCirrus > 0.01) {
            float tc = 2600.0 / (h + 0.04);
            vec2 pc = cam.xz * 0.3 + dir.xz * tc + uCloudOffset * 1.7;
            float c = texture2D(uCloudTex, pc / 5600.0).b * 0.75 + texture2D(uCloudTex, pc / 2100.0 + 0.3).b * 0.25;
            float patchC = smoothstep(0.35, 0.75, texture2D(uCloudTex, pc / 16000.0 + 0.7).a);
            float ca = smoothstep(0.62, 0.97, c) * uCirrus * smoothstep(0.02, 0.22, h) * 0.75 * patchC;
            vec3 ccol = uCloudLit * 1.05 + uCloudAmb * 0.35;
            ccol = mix(ccol, uHor, smoothstep(0.25, 0.0, h) * 0.6);
            sky = mix(sky, ccol, ca);
          }
          // main deck (fair-weather cumulus -> monsoon stratus)
          float th = (uCloudAlt - cam.y) / max(h, 0.012);
          vec2 p = cam.xz + dir.xz * th;
          vec2 cf = cloudField(p);
          float d = cf.x;
          if (d > 0.003) {
            vec2 ld = normalize(uLightDirW.xz + vec2(1e-4, 0.0));
            float s1 = cloudField(p + ld * 160.0).x;
            #ifndef SKY_LQ
              float s2 = cloudField(p + ld * 420.0).x;
            #else
              float s2 = s1;
            #endif
            float thick = 0.7 + 1.5 * uCloudCover;
            float shade = exp(-(s1 * 1.15 + s2 * 0.7) * thick);
            float fwd = pow(max(dot(dir, uLightDirW), 0.0), 6.0);
            float rim = (1.0 - d) * d * 4.0;
            vec3 col = uCloudAmb * (0.72 + 0.4 * hp) + uCloudLit * (shade * 0.92 + fwd * (0.3 + rim * 1.5));
            col *= 0.8 + 0.42 * cf.y * (0.35 + 0.65 * uCloudCover);              // rolling texture in solid decks
            col *= 1.0 - 0.3 * smoothstep(0.45, 1.0, d) * smoothstep(0.1, 0.7, hp) * (1.0 - fwd); // flat grey bases seen from below
            col = mix(col, uCloudDark * (0.62 + 0.6 * cf.y), uDark * smoothstep(0.2, 1.0, d) * (1.0 - fwd * 0.5));
            col += uCityGlow * 0.7 * (1.0 - hp);
            col += uFlashCol * uFlash * (0.2 + 1.8 * pow(max(dot(dir, uFlashDir), 0.0), 7.0)) * d;
            float far = smoothstep(1400.0, 9500.0, th);
            col = mix(col, mix(uHor, uFogCol, uHaze), far * 0.85);
            float a = d * hzn * (1.0 - smoothstep(14000.0, 32000.0, th));
            sky = mix(sky, col, a);
          }
          // scud: low ragged fractus racing under rain decks (parallax = depth)
          if (uScud > 0.01) {
            float t2 = (250.0 - cam.y) / max(h, 0.012);
            vec2 p2 = cam.xz + dir.xz * t2 + uScudOffset;
            // ragged fractus: wind-stretched, eroded, soft-edged
            vec2 wd = normalize(uScudOffset + vec2(1e-3));
            vec2 ps = vec2(dot(p2, wd), dot(p2, vec2(-wd.y, wd.x))) * vec2(0.45, 1.0);
            float sn = texture2D(uCloudTex, ps / 520.0).r * 0.55 + texture2D(uCloudTex, ps / 190.0 + 0.3).g * 0.45;
            float sdn = smoothstep(0.7 - uScud * 0.3, 1.05 - uScud * 0.15, sn) * uScud * hzn * 0.7;
            vec3 scol = uCloudDark * 0.82 + uCloudAmb * 0.22 + uFlashCol * uFlash * 0.45;
            scol = mix(scol, mix(uHor, uFogCol, uHaze), smoothstep(700.0, 6000.0, t2) * 0.8);
            sky = mix(sky, scol, sdn);
          }
        }
        // ---- rain curtains hanging from distant cells
        if (uRain > 0.01) {
          float az = atan(dir.z, dir.x);
          float shaft = texture2D(uCloudTex, vec2(az * 0.42 + uCloudOffset.x * 0.0002, 0.37)).a * 0.7
                      + texture2D(uCloudTex, vec2(az * 1.3 - uCloudOffset.y * 0.0003, 0.61)).g * 0.3;
          shaft = smoothstep(0.35, 0.8, shaft) * (0.75 + 0.25 * texture2D(uCloudTex, vec2(az * 3.1, h * 2.0 - t * 0.05)).r);
          float band = 1.0 - smoothstep(-0.02, 0.3, h);
          sky = mix(sky, uRainCol, band * shaft * uRain * 0.5);
        }
        // ---- horizon haze, below-horizon fill, lightning wash
        sky = mix(sky, uFogCol, uHaze * (1.0 - smoothstep(0.0, 0.3, hp)) * 0.8);
        if (h < 0.0) sky = mix(sky, uFogCol, smoothstep(0.0, -0.05, h));
        sky += uFlashCol * uFlash * 0.07;
        gl_FragColor = vec4(sky, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 48, 24), mat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.onBeforeRender = (r, s, camera) => { sky.position.copy(camera.position); sky.updateMatrixWorld(); };
  scene.add(sky);
  return { mesh: sky, uniforms };
}

import * as THREE from 'three';

function std(params) { return new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...params }); }

function tiled(tex, sx = 1, sy = sx) { const t = tex.clone(); t.needsUpdate = true; t.repeat.set(sx, sy); return t; }

function withWorldMacro(mat, key, fragColorGlsl, fragRoughGlsl = '') {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldPos;
        float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float wNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x),
                     mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float wFbm(vec2 p) {
          return 0.55 * wNoise(p) + 0.30 * wNoise(p * 2.13 + 7.1) + 0.15 * wNoise(p * 4.47 + 19.3);
        }`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n{\n${fragColorGlsl}\n}`);
    if (fragRoughGlsl) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{\n${fragRoughGlsl}\n}`);
    }
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export function makeMaterials(T) {
  const asphalt = withWorldMacro(
    std({ map: T.asphalt, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.58, 0.58), roughness: 0.89 }),
    'aazhi-asphalt-v3',
    `vec2 rUv = vec2(vWorldPos.x * 0.09 - vWorldPos.z * 0.07, vWorldPos.x * 0.07 + vWorldPos.z * 0.09);
     vec3 macroSample = texture2D(map, rUv).rgb;
     diffuseColor.rgb = mix(diffuseColor.rgb, macroSample, 0.24);
     float n1 = wFbm(vWorldPos.xz * 0.055), n2 = wNoise(vWorldPos.xz * 0.19);
     diffuseColor.rgb *= 0.93 + 0.12 * n1 + 0.04 * (n2 - 0.5);`,
    `float r1 = wFbm(vWorldPos.xz * 0.075 + 11.0);
     roughnessFactor = clamp(roughnessFactor * (0.91 + 0.15 * r1), 0.74, 0.96);`
  );

  const paving = withWorldMacro(
    std({ map: T.paving, normalMap: T.pavingN, normalScale: new THREE.Vector2(0.72, 0.72), roughness: 0.86 }),
    'aazhi-paving-v3',
    `float n1 = wFbm(vWorldPos.xz * 0.07 + 3.7), n2 = wNoise(vWorldPos.xz * 0.25);
     vec3 warmTint = mix(vec3(0.95, 0.94, 0.93), vec3(1.04, 1.01, 0.97), n1);
     diffuseColor.rgb *= warmTint * (0.94 + 0.10 * n1 + 0.035 * (n2 - 0.5));`,
    `float r1 = wFbm(vWorldPos.xz * 0.085 + 5.2);
     roughnessFactor = clamp(roughnessFactor * (0.92 + 0.14 * r1), 0.75, 0.95);`
  );

  const grass = withWorldMacro(
    std({ map: T.grass, normalMap: T.grassN, normalScale: new THREE.Vector2(0.48, 0.48), roughness: 0.93 }),
    'aazhi-grass-v4',
    `vec2 rUv = vec2(vWorldPos.x * 0.105 + vWorldPos.z * 0.068, -vWorldPos.x * 0.068 + vWorldPos.z * 0.105);
     vec3 macroGrass = texture2D(map, rUv).rgb;
     diffuseColor.rgb = mix(diffuseColor.rgb, macroGrass, 0.32);
     float m1 = wFbm(vWorldPos.xz * 0.075), m2 = wFbm(vWorldPos.xz * 0.21 + 13.4), m3 = wNoise(vWorldPos.xz * 0.42 + 5.1);
     vec3 lush = vec3(0.88, 0.98, 0.85), sunWarm = vec3(1.05, 1.02, 0.89);
     vec3 patchTint = mix(lush, sunWarm, smoothstep(0.28, 0.72, m1));
     diffuseColor.rgb *= patchTint * (0.93 + 0.11 * m2 + 0.04 * (m3 - 0.5));`,
    `roughnessFactor = clamp(roughnessFactor * (0.94 + 0.10 * wNoise(vWorldPos.xz * 0.15)), 0.85, 0.98);`
  );

  const curb = withWorldMacro(
    std({ map: T.curb || T.concrete, normalMap: T.curbN || T.concreteN, normalScale: new THREE.Vector2(0.7, 0.7), color: 0xe6e0d6, roughness: 0.84 }),
    'aazhi-curb-v2',
    `float c1 = wFbm(vWorldPos.xz * 0.11 + 2.3);
     diffuseColor.rgb *= 0.94 + 0.11 * c1;`
  );

  const makeEdgeBlend = (colorHex, opacity, key) => {
    const m = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGutUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvGutUv = uv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGutUv;')
        .replace('#include <opaque_fragment>', 'diffuseColor.a *= pow(clamp(1.0 - vGutUv.y, 0.0, 1.0), 1.65);\n#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => key;
    return m;
  };
  const gutter = makeEdgeBlend(0x0c0b09, 0.25, 'aazhi-gutter-v2');
  const soilEdge = makeEdgeBlend(0x281c11, 0.30, 'aazhi-soiledge-v2');

  const M = {
    asphalt,
    paving,
    curb,
    gutter,
    soilEdge,
    concrete: std({ map: T.concrete, normalMap: T.concreteN, roughness: 0.85 }),
    concreteDark: std({ map: T.concrete, normalMap: T.concreteN, color: 0xb0aaa0, roughness: 0.88 }),
    grass,
    stone: std({ map: T.stone, normalMap: T.stoneN, roughness: 0.9 }),
    sand: std({ map: T.sand, normalMap: T.sandN, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.97 }),
    planks: std({ map: T.planks, roughness: 0.9 }),
    lineWhite: std({ color: 0xebe8e0, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    lineYellow: std({ color: 0xe8b528, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    railing: std({ color: 0xd9d9d4, metalness: 0.5, roughness: 0.4 }),
    metalDark: std({ color: 0x3b3f44, metalness: 0.6, roughness: 0.45 }),
    steel: std({ color: 0xb8bec4, metalness: 0.7, roughness: 0.35 }),
    aptWall: std({ map: T.aptFacade }),
    aptSlab: std({ color: 0xf1e8d8 }),
    aptAccent: std({ color: 0x9a6b47 }),
    grafWall: std({ map: T.grafFacade }),
    plainWall: std({ map: T.whiteWall }),
    mural: std({ map: T.mural, roughness: 0.9 }),
    glass: std({ map: T.glass, roughness: 0.15, metalness: 0.3 }),
    glassClear: new THREE.MeshStandardMaterial({ map: T.glassClear, transparent: true, roughness: 0.1, metalness: 0.2, side: THREE.DoubleSide, depthWrite: false }),
    shopfront: std({ map: T.shopfront, emissive: 0x3a2410, roughness: 0.3 }),
    signTea: std({ map: T.signTea, emissive: 0xffffff, emissiveMap: T.signTea, emissiveIntensity: 0.35 }),
    signMetro: std({ map: T.signMetro, emissive: 0xffffff, emissiveMap: T.signMetro, emissiveIntensity: 0.3 }),
    roofTiles: std({ map: T.roofTiles }),
    solar: std({ map: T.solar, roughness: 0.3, metalness: 0.4 }),
    wood: std({ color: 0x7a5534 }),
    woodDark: std({ color: 0x4e3523 }),
    blueRoof: std({ color: 0x2f5fa8, roughness: 0.6 }),
    whitePaint: std({ color: 0xf4f3ef, roughness: 0.6 }),
    teal: std({ color: 0x1aa6a6, roughness: 0.6 }),
    trackBed: std({ map: T.trackBed }),
    leafPlanter: std({ color: 0x4f7f2f, roughness: 1 }),
    soil: std({ color: 0x5a4330 }),
    lampGlow: std({ color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 0.6 }),
    umbrellaBlue: std({ color: 0x2a6fd1, side: THREE.DoubleSide }),
    umbrellaWhite: std({ color: 0xf5f5f0, side: THREE.DoubleSide }),
    hullWhite: std({ color: 0xf2f2ee, roughness: 0.5 }),
    hullBlue: std({ color: 0x2257a8, roughness: 0.5 }),
    hullRed: std({ color: 0xc23b2a, roughness: 0.5 }),
    buoy: std({ color: 0xe0441e }),
    acUnit: std({ color: 0xd8d8d2 }),
    darkGlass: std({ color: 0x1d2a33, roughness: 0.2, metalness: 0.4 }),
    awning: std({ color: 0x2e6b5e }),
  };
  M.tiled = tiled;
  return M;
}

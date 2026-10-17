import * as THREE from 'three';
import { skyState, phaseName, localToUtcMs, utcMsToLocal, SYNODIC } from './astro.js';
import { makePalette, samplePalette } from './palette.js';
import { WeatherSim, WEATHER } from './weather.js';
import { atmoUniforms, makeCloudTexture } from './atmoShared.js';
import { buildSkyDome } from './skyDome.js';
import { installSurfaceFx, makeLampMap } from './surfaceFx.js';
import { buildRain, buildSplashes, bakeSurfaceHeights, buildBolt } from './precip.js';
import { WeatherAudio } from './audio.js';
import { TornadoEvent, TORNADO_LEVELS } from './tornado.js';
import { FloodEvent } from './flood.js';

// ---------------------------------------------------------------------------
// One continuous world simulation: a calendar clock drives the real sun and
// moon over Kochi; the weather sim drives clouds, rain, wind, fog and storms;
// both feed a single lighting solve each frame (sky dome, sun/moon light and
// shadows, ambient, fog, surface wetness, lamps, vegetation wind, rain, the
// water's sky/sun uniforms) so everything always agrees.
// ---------------------------------------------------------------------------

const MOON_COL = new THREE.Color('#a9bde8');
const lum = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const DEG = 180 / Math.PI;

export class Atmosphere {
  constructor({ scene, renderer, camera, sun, hemi, fog, materials: M, data: D, walkMesh, water, coastUniforms, windUniforms, puddleNoise, waterNormal, quality = 'high' }) {
    Object.assign(this, { scene, renderer, camera, sun, hemi, fog, M, D, water, coastUniforms, windUniforms });
    this.quality = quality;
    const low = quality === 'low';
    // ---- clock: local Kochi time, default today 16:30 (the island's original light)
    const now = new Date();
    this.ms = localToUtcMs(now.getFullYear(), now.getMonth() + 1, now.getDate(), 16.5);
    this.timeScale = 72;              // game seconds per real second (1 day = 20 min)
    this.moonShift = 0;               // days, dev override of the lunar age
    this.weather = new WeatherSim('scattered');
    this.pal = makePalette();
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.cloudOffset = new THREE.Vector2();
    this.scudOffset = new THREE.Vector2();
    this.windAngle = Math.atan2(-0.36, 0.93);
    this.windDirOverride = null;   // radians (direction the wind blows towards), dev override
    this.realTime = 0;

    // ---- shared resources
    atmoUniforms.uCloudTex.value = makeCloudTexture(low ? 256 : 512);
    atmoUniforms.uPuddleNoise.value = puddleNoise;
    const lampRect = [-70, -66, 70, 70];
    atmoUniforms.uLampRect.value.set(...lampRect);
    atmoUniforms.uLampMap.value = makeLampMap(this.lampSpots(), lampRect);

    this.sky = buildSkyDome(scene, { lowQuality: low });
    this.rain = buildRain(scene, low ? 7000 : 22000);
    this.splash = buildSplashes(scene, bakeSurfaceHeights(walkMesh), low ? 40 : 64);
    this.bolt = buildBolt(scene);
    this.audio = new WeatherAudio();
    this.env = {
      ambient: new THREE.Color(0.8, 0.8, 0.8), sunColor: new THREE.Color(), fog, flash: 0, rain: 0, windX: 0, windZ: 0,
      isLand: (x, z) => D.coast.wallDist(x, z) < 0 || D.coast.height(x, z) > 0.05,
    };
    this.tornado = new TornadoEvent(scene, { lowQuality: low });
    this.flood = new FloodEvent(scene, { walkMesh, data: D, lowQuality: low, waterN: waterNormal, coastTex: coastUniforms.uCoastTex.value });
    this.flash = { pulses: [], level: 0, dir: new THREE.Vector3(1, 0.25, 0), dist: 2000, next: 6, near: 0, boltUntil: 0, boltK: 0 };

    // ---- materials: per-material wetness profiles (roads pool water, walls only darken)
    const P = new Map();
    const set = (k, prof) => { if (M[k]) P.set(M[k], prof); };
    set('asphalt', { dark: 0.42, rough: 0.16, side: 0.3, refl: 0.35, puddle: 1 });
    set('paving', { dark: 0.36, rough: 0.2, side: 0.3, refl: 0.3, puddle: 0.75 });
    for (const k of ['curb', 'concrete', 'concreteDark', 'stone']) set(k, { dark: 0.3, rough: 0.25, side: 0.4, refl: 0.22 });
    for (const k of ['roofTiles', 'planks', 'wood', 'woodDark']) set(k, { dark: 0.32, rough: 0.3, side: 0.35, refl: 0.18 });
    set('grass', { dark: 0.16, rough: 0.55, side: 0.4, refl: 0.08 });
    for (const k of ['railing', 'metalDark', 'steel', 'solar', 'blueRoof', 'teal', 'awning', 'whitePaint']) set(k, { dark: 0.08, rough: 0.12, side: 0.6, refl: 0.3 });
    const noWet = new Set([M.coastGround].filter(Boolean));     // shoreline keeps its own wet/dry logic
    this.patched = installSurfaceFx(scene, (m) => {
      if (noWet.has(m)) return null;
      if (P.has(m)) return P.get(m);
      if (m.map && m.map.isTexture && m.alphaTest > 0) return { dark: 0.14, rough: 0.55, side: 0.6, refl: 0.06 };   // foliage
      if (m.vertexColors && m.name !== 'player') return null;                                                        // rocks etc. (shore)
      return { dark: 0.18, rough: 0.35, side: 0.4, refl: 0.12 };                                                    // walls, misc.
    });

    // remember base values we modulate
    this.base = {
      inscatter: coastUniforms.uInscatter.value.clone(),
      foamWater: water.mesh.material.uniforms.uFoamCol.value.clone(),
      foamGround: M.coastGround?.userData.uniforms?.uFoamCol.value.clone(),
      lampGlow: M.lampGlow?.emissiveIntensity ?? 0.6,
      signTea: M.signTea?.emissiveIntensity ?? 0.35,
      signMetro: M.signMetro?.emissiveIntensity ?? 0.3,
    };
    this.tmp = { a: new THREE.Color(), b: new THREE.Color(), c: new THREE.Color(), grey: new THREE.Color() };
    this.info = {};
    this.update(0, camera, new THREE.Vector3());
  }

  lampSpots() {
    return (this.D.lamps || []).map(([x, z]) => {
      // lamp arms reach over the carriageway: nudge the pool towards the nearest road
      const r = this.D.roads?.ring?.pl;
      if (!r) return [x, z];
      const p = r.at(r.project(x, z));
      const dx = p.x - x, dz = p.z - z, l = Math.hypot(dx, dz) || 1;
      return [x, z, dx / l, dz / l];
    });
  }

  // ---- dev API -------------------------------------------------------------------
  get local() { return utcMsToLocal(this.ms); }
  setHours(h) { const L = this.local; this.ms = localToUtcMs(L.year, L.month, L.day, h); }
  setDate(y, m, d) { const L = this.local; this.ms = localToUtcMs(y, m, d, L.hours); }
  setMoonAge(age) {
    if (age === null) { this.moonShift = 0; return; }
    const cur = skyState(this.ms, 0).age;
    let delta = age - cur;
    delta -= Math.round(delta / SYNODIC) * SYNODIC;
    this.moonShift = delta * (SYNODIC / (SYNODIC - 1));   // moon gains ~1 synodic day per (synodic-1) days
  }
  strike(near = false) { this.flash.next = 0; this.flash.forceNear = near; }

  // ---- per frame -------------------------------------------------------------------
  update(dtReal, camera, focus) {
    const { pal, tmp, sun, hemi, fog } = this;
    const U = this.sky.uniforms, A = atmoUniforms;
    this.realTime += dtReal;
    const dtGame = dtReal * this.timeScale;
    this.ms += dtGame * 1000;
    const L = this.local;
    const st = skyState(this.ms, this.moonShift);
    const sunV = tmp.sv || (tmp.sv = new THREE.Vector3());
    const moonV = tmp.mv || (tmp.mv = new THREE.Vector3());
    sunV.fromArray(st.sun); moonV.fromArray(st.moon);
    const sunEl = Math.asin(sunV.y) * DEG, moonEl = Math.asin(moonV.y) * DEG;
    const evening = ss(0.15, -0.15, sunV.x);
    samplePalette(pal, sunEl, evening);

    // ---- weather, then the extreme-weather scenarios layered on top of it
    const W0 = this.weather.update(dtReal, dtGame / 60, { month: L.month, hour: L.hours, sunUp: sunEl > 0 });
    const env = this.env;
    const tz = this.tornado.update(dtReal, camera, focus, env);
    const fl = this.flood.update(dtReal, camera, env);
    const W = { ...W0 };
    for (const sc of [fl, tz]) {
      if (!sc || sc.weight <= 0) continue;
      for (const [k, v] of Object.entries(sc.params)) W[k] += (v - W[k]) * sc.weight;
    }
    this.weather.soak(W, dtReal, dtGame / 60);
    this.scenario = { tz, fl };
    const cover = W.cover, dark = W.dark;
    const dayK = ss(-6, 4, sunEl), night = 1 - ss(-12, -3, sunEl);
    const moonUp = ss(-1.5, 6, moonEl);
    const moonLight = moonUp * (0.1 + 0.9 * st.illum);

    // ---- lightning (Poisson strikes, multi-pulse flashes, delayed thunder)
    const F = this.flash;
    const stormRate = Math.pow(W.storm, 1.3) / 5.5;
    F.next -= dtReal;
    if (F.next <= 0 && (stormRate > 0.002 || F.forceNear !== undefined)) {
      this.spawnStrike(camera, focus, W);
      F.next = stormRate > 0.002 ? -Math.log(1 - Math.random()) / stormRate + 0.8 : 1e9;
      F.forceNear = undefined;
    } else if (stormRate <= 0.002 && F.next > 30) F.next = 8;
    let flash = 0;
    F.pulses = F.pulses.filter((p) => this.realTime - p.t < p.d + 0.6);
    for (const p of F.pulses) {
      const k = this.realTime - p.t;
      if (k >= 0) flash = Math.max(flash, p.a * (k < 0.02 ? k / 0.02 : Math.exp(-(k - 0.02) / p.d)));
    }
    F.level = flash;
    this.bolt.set(F.boltUntil > this.realTime ? flash * F.boltK : 0);

    // ---- active light: the sun by day, the moon by night
    const sunVis = sunEl > -1.2;
    const useSun = pal.sunI > 0.02 || !moonUp;
    this.lightDir.copy(useSun ? sunV : moonV);
    if (this.lightDir.y < 0.06) this.lightDir.y = 0.06;
    this.lightDir.normalize();
    const veil = (1 - 0.32 * W.haze - 0.25 * W.fog) * (1 - 0.55 * dark);
    const moonCol = MOON_COL;
    let lightI, lightCol = tmp.a;
    if (useSun) { lightI = pal.sunI * veil; lightCol.copy(pal.sun); }
    else { lightI = 0.95 * moonLight * night * veil; lightCol.copy(moonCol); }
    sun.color.copy(lightCol);
    sun.intensity = lightI;
    sun.shadow.intensity = Math.max(0.12, 1 - 0.7 * Math.pow(cover, 1.6) - 0.45 * W.fog - 0.3 * W.haze);

    // ---- ambient: greyer and flatter under cloud, brighter on moonlit nights, flashes
    tmp.grey.setScalar(lum(pal.hemiSky));
    hemi.color.copy(pal.hemiSky).lerp(tmp.grey.multiply(tmp.b.setRGB(0.95, 1.0, 1.06)), Math.min(1, cover * 0.75 + W.rain * 0.2));
    hemi.groundColor.copy(pal.hemiGnd).multiplyScalar(1 - 0.35 * cover * dayK);
    const fd = camera.position.distanceTo(focus);
    hemi.intensity = pal.hemiI * (1 + 0.3 * cover * dayK) * (1 - 0.58 * dark) + 0.16 * moonLight * night + flash * 2.4 * F.near;
    this.renderer.toneMappingExposure = 1.05 + 0.3 * night;

    // ---- sky & cloud colours (weather-adjusted)
    const deck = tmp.b.copy(pal.cloudAmb).lerp(tmp.grey.setScalar(lum(pal.cloudAmb)), 0.5).multiplyScalar(1 - 0.55 * dark);
    U.uZen.value.copy(pal.zen).lerp(deck, ss(0.5, 1.0, cover) * 0.85);
    const fogC = fog.color.copy(pal.fog);
    tmp.grey.setScalar(lum(pal.fog));
    fogC.lerp(tmp.grey.multiply(tmp.c.setRGB(0.93, 0.99, 1.04)), Math.min(1, cover * 0.55 + W.rain * 0.35 + W.fog * 0.5));
    fogC.multiplyScalar(1 - 0.66 * dark * (1 - W.fog * 0.5));
    // under a storm deck the distance turns slate grey rather than glowing
    fogC.lerp(tmp.c.set('#5d6670').multiplyScalar(0.25 + 0.75 * dayK), ss(0.4, 1.0, dark) * 0.6 * (1 - W.fog * 0.5));
    if (W.fog > 0.01) fogC.lerp(tmp.c.copy(pal.hemiSky).multiplyScalar(0.92), W.fog * 0.35 * dayK);
    U.uHor.value.copy(pal.hor).lerp(fogC, Math.min(1, W.haze * 0.5 + cover * 0.45));
    U.uGlow.value.copy(pal.glow).lerp(U.uHor.value, Math.min(1, cover * 1.05));
    U.uFogCol.value.copy(fogC);
    U.uBelt.value.set('#c98aa8').multiplyScalar(0.22 * ss(-7, -1, sunEl) * (1 - ss(-1, 4, sunEl)) * (1 - cover));
    const sunUp = sunVis ? 1 : 0;
    U.uSunGlowCol.value.copy(pal.glow).multiplyScalar(0.6 * sunUp * Math.pow(1 - cover, 1.5) * (1 - W.fog * 0.6));
    U.uSunDisc.value.copy(pal.sun).multiplyScalar(26 * sunUp * (1 - W.haze * 0.6) * (1 - W.fog * 0.85));
    U.uSunDir.value.copy(sunV);
    U.uMoonDir.value.copy(moonV);
    U.uMoonCol.value.set('#f1eee4').multiplyScalar(1.7 * (0.32 + 0.68 * night) * (1 - W.fog * 0.8) * ss(-2, 1, moonEl));
    U.uMoonGlow.value.set('#c9d6f5').multiplyScalar(st.illum * night * (0.35 + 0.9 * W.haze) * moonUp);
    U.uStarVis.value = night * (1 - W.haze * 0.85) * (1 - W.fog);
    const [ex, ey, ez] = st.starBasis;
    U.uStarBasis.value.set(ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]);
    U.uCloudLit.value.copy(pal.cloudLit).multiplyScalar(dayK * (1 - 0.6 * dark) * (useSun ? 1 : 0.6))
      .add(tmp.c.copy(moonCol).multiplyScalar(0.22 * moonLight * night));
    U.uCloudAmb.value.copy(pal.cloudAmb).multiplyScalar(1 - 0.5 * dark);
    U.uCloudDark.value.set('#3d444f').multiplyScalar(0.12 + 0.88 * dayK).lerp(tmp.c.set('#0b0f17'), night * 0.85).multiplyScalar(1 - 0.3 * W.storm);
    U.uDark.value = dark;
    U.uCirrus.value = W.cirrus * (1 - cover * 0.7) * 0.75;
    U.uScud.value = W.scud;
    U.uRain.value = W.rain;
    U.uRainCol.value.copy(U.uCloudDark.value).lerp(fogC, 0.45);
    U.uHaze.value = Math.min(1, W.haze * 0.65 + W.fog * 0.4);
    U.uCityGlow.value.set('#ff9d5c').multiplyScalar(0.07 * night * (0.35 + 0.65 * cover));
    U.uFlash.value = flash;
    U.uFlashDir.value.copy(F.dir);

    // ---- clouds drift with the wind aloft (veers slowly)
    const veer = Math.atan2(-0.36, 0.93) + 0.35 * Math.sin(this.weather.clock * 0.011);
    let goal = this.windDirOverride ?? veer;
    if (tz && tz.windWeight) {          // inflow + rotation around an approaching tornado
      const ww = tz.windWeight * tz.weight;
      goal = Math.atan2(Math.sin(goal) * (1 - ww) + tz.windDir.y * ww, Math.cos(goal) * (1 - ww) + tz.windDir.x * ww);
    }
    this.windAngle += Math.atan2(Math.sin(goal - this.windAngle), Math.cos(goal - this.windAngle)) * Math.min(1, dtReal * 1.5 + (dtReal === 0 ? 1 : 0));
    const wdx = Math.cos(this.windAngle), wdz = Math.sin(this.windAngle);
    const aloft = (5 + 11 * W.wind) * dtReal * (1 + Math.min(this.timeScale, 360) / 70);
    this.cloudOffset.x -= wdx * aloft; this.cloudOffset.y -= wdz * aloft;
    this.scudOffset.x -= wdx * aloft * 2.4; this.scudOffset.y -= wdz * aloft * 2.4;
    A.uCloudOffset.value.copy(this.cloudOffset);
    A.uScudOffset.value.copy(this.scudOffset);
    A.uCloudCover.value = cover;
    A.uCloudSoft.value = W.soft;
    A.uCloudShadowK.value = (useSun ? 0.84 : 0.7) * (1 - 0.3 * W.fog);
    A.uLightDirW.value.copy(this.lightDir);
    A.uAtmoTime.value = this.realTime;

    // ---- fog & mist: visibility falls with rain and fog, but the focus stays readable
    const v = Math.min(1, W.haze * 0.22 + W.rain * 0.5 + W.fog * 0.95);
    const nearW = 280 + (14 - 280) * Math.pow(v, 0.8), farW = 950 + (150 - 950) * Math.pow(v, 0.75);
    fog.near = Math.max(nearW, Math.min(fd * 0.55, 280));
    fog.far = Math.max(farW, Math.min(fd * 2.4, 950), fog.near + 40);
    const mistD = (W.mist * 0.05 + W.fog * 0.02) * (0.6 + 0.4 * (1 - dayK * 0.5));
    A.uMistDensity.value = mistD;
    A.uMistHeight.value = 4 + 9 * W.fog;
    this.scene.background = fogC;

    // ---- surfaces
    const wx = this.weather;
    A.uWet.value = Math.max(wx.wet, fl ? fl.surfaces : 0);
    A.uPuddle.value = Math.max(wx.puddle, fl ? fl.surfaces : 0);
    A.uRainNow.value = W.rain;
    A.uSkyZenW.value.copy(U.uZen.value);
    A.uSkyHorW.value.copy(U.uHor.value);
    const lamps = Math.max(1 - ss(-5, 3, sunEl), dark * 0.55 * dayK, W.fog * 0.35 * (1 - dayK * 0.5));
    A.uLampLevel.value = lamps;
    if (this.M.lampGlow) this.M.lampGlow.emissiveIntensity = this.base.lampGlow + 2.8 * lamps;
    if (this.M.signTea) this.M.signTea.emissiveIntensity = this.base.signTea + 0.9 * lamps;
    if (this.M.signMetro) this.M.signMetro.emissiveIntensity = this.base.signMetro + 0.9 * lamps;

    // ---- vegetation wind (weather owns the wind; dev overrides go through the weather sim)
    const wu = this.windUniforms;
    wu.uWind.value = 0.25 + W.wind * 0.85;
    wu.uWindGust.value = W.gust;
    wu.uWindTurb.value = 0.25 + W.gust * 0.6;
    wu.uWindSpeed.value = 0.75 + W.wind * 0.3;
    wu.uWindDir.value.set(wdx, wdz);
    wu.uSunDir.value.copy(this.lightDir);
    wu.uSunColor.value.copy(lightCol).multiplyScalar(Math.min(1, lightI / 3.1));

    // ---- water: reflect this sky and this light (uniform values only; the sea shader is unchanged)
    const cu = this.coastUniforms;
    cu.uSunDirW.value.copy(this.lightDir);
    cu.uSunColW.value.copy(lightCol).multiplyScalar(Math.min(1.1, lightI / 3.1) * (1 - 0.8 * cover));
    cu.uSkyTop.value.copy(U.uZen.value).addScalar(flash * 0.4);
    cu.uSkyHorizon.value.copy(U.uHor.value);
    const amb = Math.min(1.25, Math.max(0.05, (hemi.intensity * lum(hemi.color) + lightI * 0.06) / (1.15 * 0.83 + 3.1 * 0.06)));
    cu.uInscatter.value.copy(this.base.inscatter).multiplyScalar(amb);
    this.water.mesh.material.uniforms.uFoamCol.value.copy(this.base.foamWater).multiplyScalar(Math.min(1, amb * 1.05));
    if (this.base.foamGround) this.M.coastGround.userData.uniforms.uFoamCol.value.copy(this.base.foamGround).multiplyScalar(Math.min(1, amb * 1.05));
    const wu2 = this.water.mesh.material.uniforms;
    let wNear = fog.near, wFar = fog.far;
    if (mistD > 0.0005) {   // fold the ground mist into the sea's linear fog
      const H = A.uMistHeight.value, hc = Math.max(camera.position.y, 0.01);
      const avg = (1 - Math.exp(-hc / H)) * H / hc;
      wFar = Math.min(wFar, Math.max(wNear + 25, 2.4 / (mistD * avg)));
      wNear = Math.min(wNear, wFar * 0.3);
    }
    wu2.uFogNear.value = wNear; wu2.uFogFar.value = wFar;

    // ---- rain + splashes
    const R = this.rain.uniforms;
    const rainOn = W.rain > 0.01;
    this.rain.mesh.visible = rainOn;
    if (rainOn) {
      const fwd = tmp.fw || (tmp.fw = new THREE.Vector3());
      camera.getWorldDirection(fwd);
      const D = Math.min(110, Math.max(10, fd * 0.55));
      const S = Math.min(150, Math.max(26, D * 1.4));
      R.uCenter.value.copy(camera.position).addScaledVector(fwd, D);
      R.uSize.value.set(S, S * 0.75, S);
      R.uTime.value = this.realTime;
      R.uAmount.value = Math.min(1, W.rain * 1.05);
      const gust = 1 + 0.35 * Math.sin(this.realTime * 0.9) * W.gust;
      R.uWind.value.set(wdx, wdz).multiplyScalar((1.2 + 3.8 * W.wind) * gust);
      R.uLen.value = 0.75 + 0.55 * W.rain;
      R.uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, this.renderer.domElement.height / this.renderer.getPixelRatio());
      R.uColor.value.copy(hemi.color).multiplyScalar(0.55 * hemi.intensity + 0.1).addScalar(flash * 0.6);
      R.uAlpha.value = 0.24 + 0.28 * W.rain;
    }
    const S2 = this.splash.uniforms;
    this.splash.mesh.visible = rainOn && fd < 60;
    if (this.splash.mesh.visible) {
      S2.uTime.value = this.realTime;
      S2.uFocus.value.copy(focus);
      S2.uAmount.value = W.rain;
      S2.uColor.value.copy(hemi.color).multiplyScalar(0.7 * hemi.intensity + 0.12);
    }
    this.audio.update(W.rain, W.wind, this.tornado.state.roar);
    // environment snapshot the scenarios use next frame
    env.ambient.copy(hemi.color).multiplyScalar(hemi.intensity * 0.85).add(tmp.c.copy(lightCol).multiplyScalar(lightI * 0.12));
    env.sunColor.copy(lightCol).multiplyScalar(Math.min(1, lightI / 3.1));
    env.flash = flash; env.rain = W.rain;
    env.windX = wdx * W.wind * 3; env.windZ = wdz * W.wind * 3;

    // ---- dev readout
    const hh = Math.floor(L.hours), mm = Math.floor((L.hours - hh) * 60);
    Object.assign(this.info, {
      time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      date: `${L.year}-${String(L.month).padStart(2, '0')}-${String(L.day).padStart(2, '0')}`,
      hours: L.hours, sunEl, moonEl, moonAge: st.age, illum: st.illum, phase: phaseName(st.age),
      weather: this.weather.describe(), state: this.weather.state, params: W, wet: A.uWet.value, puddle: A.uPuddle.value,
      tornado: this.tornado.running ? `${TORNADO_LEVELS[this.tornado.level].name} · ${this.tornado.phaseName()}${this.tornado.paused ? ' (paused)' : ''} · ${Math.round(this.tornado.state.dist)} m` : null,
      flood: this.flood.running || this.flood.stats.max > 0.003
        ? `${this.flood.phase}${this.flood.paused ? ' (paused)' : ''} · road ${Math.round(this.flood.stats.mean * 100)} cm · max ${Math.round(this.flood.stats.max * 100)} cm` : null,
    });
  }

  spawnStrike(camera, focus, W) {
    const F = this.flash;
    const near = F.forceNear === true;
    let dist = near ? 420 + Math.random() * 380 : 450 + Math.pow(Math.random(), 0.75) * 5200;
    // storms march in from the west-south-west: strikes favour that side, or cluster round a tornado's parent cell
    let az = (Math.random() < 0.6 ? Math.PI + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2);
    let d2 = dist;
    const tb = this.tornado.running ? this.tornado.state.base : null;
    if (tb && Math.random() < 0.7 && !near) {
      az = Math.atan2(tb.z - focus.z, tb.x - focus.x) + (Math.random() - 0.5) * 0.9;
      d2 = Math.max(300, Math.hypot(tb.x - focus.x, tb.z - focus.z) + (Math.random() - 0.3) * 700);
    }
    const dx = Math.cos(az), dz = Math.sin(az);
    const ground = new THREE.Vector3(focus.x + dx * d2, 0, focus.z + dz * d2);
    dist = d2;
    F.dir.set(ground.x - camera.position.x, 0, ground.z - camera.position.z).normalize();
    F.dir.y = 0.3; F.dir.normalize();
    F.dist = dist;
    F.near = Math.min(1, 1500 / (dist + 600));
    const strength = (0.55 + 0.45 * Math.random()) * Math.min(1, 2200 / (dist + 900));
    const n = 1 + Math.floor(Math.random() * 3.5);
    let t = this.realTime;
    for (let i = 0; i < n; i++) {
      F.pulses.push({ t, d: 0.06 + Math.random() * 0.12, a: strength * (i === 0 ? 1 : 0.5 + Math.random() * 0.5) });
      t += 0.06 + Math.random() * 0.22;
    }
    const cg = near || (dist < 3200 && Math.random() < 0.6);
    if (cg) {
      const top = ground.clone().add(new THREE.Vector3((Math.random() - 0.5) * 160, atmoUniforms.uCloudAlt.value - 30, (Math.random() - 0.5) * 160));
      this.bolt.strike(ground, top, camera.position);
      F.boltUntil = t + 0.2;
      F.boltK = Math.exp(-dist / 4000) * 1.4;
    }
    this.audio.thunder(dist);
  }
}

export { WEATHER };

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Batch } from './geom.js';
import { makeTextures, setMaxAnisotropy } from './textures.js';
import { makeMaterials } from './materials.js';
import { SPAWN } from './layout.js';
import { buildTerrain } from './world/terrain.js';
import { buildMetro, stationFootprint } from './world/metro.js';
import { buildBuildings } from './world/buildings.js';
import { buildProps } from './world/props.js';
import { buildNature } from './nature/index.js';
import { windUniforms } from './nature/materials.js';
import { buildWater } from './world/water.js';
import { Atmosphere } from './atmosphere/index.js';
import { initDevPanel } from './atmosphere/devPanel.js';
import { coastUniforms, patchUnderwater } from './world/coastShading.js';
import { makeBeachDetail } from './world/coastTextures.js';
import { buildTraffic } from './traffic.js';
import { Player, buildWalkMesh } from './player.js';

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
const horizon = new THREE.Color('#f1d9b8');
scene.fog = new THREE.Fog(horizon, 280, 950);
scene.background = horizon;

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.3, 3500);

// key light: the atmosphere drives it as the sun by day and the moon by night
const sunDir = new THREE.Vector3(-0.78, 0.52, 0.36).normalize();
const sun = new THREE.DirectionalLight(0xffd6a4, 3.1);
sun.position.copy(sunDir).multiplyScalar(160);
sun.castShadow = true;
const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
sun.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
const sc = sun.shadow.camera;
sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 20; sc.far = 400;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x8a7656, 1.15);
scene.add(hemi);
const quality = new URLSearchParams(location.search).get('quality')
  || (mobile || (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high');

// ---------------------------------------------------------------------------
// World build
// ---------------------------------------------------------------------------
const T = makeTextures();
const M = makeMaterials(T);
const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const ctx = { scene, T, M, batch: new Batch(), walk: [], colliders: [], data: {}, maxAniso };
ctx.data.stationFootprint = stationFootprint();
coastUniforms.uSunDirW.value.copy(sunDir);
coastUniforms.uSkyHorizon.value.copy(horizon);
// surfaces that dip below the waterline get depth absorption + caustics
for (const k of ['stone', 'woodDark', 'hullWhite', 'hullBlue', 'hullRed', 'buoy', 'concrete']) patchUnderwater(M[k], k);

buildTerrain(ctx);
const train = buildMetro(ctx);
buildBuildings(ctx);
const boats = buildProps(ctx);
ctx.batch.build(scene);
const nature = buildNature(ctx, { maxAniso, mobile });
// beach detail (footprints, rock contact shading) needs the final rock and palm positions
M.coastGround.userData.uniforms.uBeachDetail.value = makeBeachDetail({
  rect: M.coastGround.userData.uniforms.uBeachRect.value.toArray(),
  height: ctx.data.coast.height,
  rocks: ctx.data.rocks,
  trees: nature.stats.beachTrees || [],
  keepOut: [...(ctx.data.beachKeepOut || []), ...ctx.data.rocks.filter((q) => q.R > 0.3).map((q) => [q.x, q.z, q.R * 0.8])],
});
const water = buildWater(scene, ctx.data, ctx.coastT, scene.fog);
const traffic = buildTraffic(scene, ctx.data, T);

const walkMesh = buildWalkMesh(ctx.walk);
const player = new Player(scene, walkMesh, ctx.colliders);
player.spawn(SPAWN.x, SPAWN.z, SPAWN.heading);

// sky, day-night and weather: one simulation driving lights, fog, clouds, rain and surfaces
const atmo = new Atmosphere({
  scene, renderer, camera, sun, hemi, fog: scene.fog, materials: M, data: ctx.data, walkMesh, water,
  coastUniforms, windUniforms, puddleNoise: ctx.coastT.noiseTex, waterNormal: ctx.coastT.waterN, quality,
});

scene.updateMatrixWorld(true);

// ---------------------------------------------------------------------------
// Cameras: overview (diorama orbit) and explore (third person)
// ---------------------------------------------------------------------------
const OVERVIEW = { pos: new THREE.Vector3(-66, 112, 150), target: new THREE.Vector3(4, 0, 0) };
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 25;
orbit.maxDistance = 320;
orbit.maxPolarAngle = Math.PI * 0.46;
orbit.target.copy(OVERVIEW.target);
camera.position.copy(OVERVIEW.pos);
orbit.update();

let mode = 'overview';
const follow = { yaw: Math.PI, pitch: 0.32, dist: 7.5 };
let blend = 1; // 0..1 transition progress
const blendFrom = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
const curLook = new THREE.Vector3().copy(OVERVIEW.target);

const modeBtn = document.getElementById('mode');
const panel = document.getElementById('panel');
const help = {
  overview: '<b>Overview</b><br>Drag to orbit · right-drag to pan · scroll to zoom<br><kbd>C</kbd> or the button to walk the island',
  explore: '<b>On foot</b><br><kbd>W A S D</kbd> / arrows to walk · <kbd>Shift</kbd> run<br>Drag to look · scroll to zoom · <kbd>C</kbd> overview',
};
function setMode(m) {
  mode = m;
  blend = 0;
  blendFrom.pos.copy(camera.position);
  blendFrom.look.copy(curLook);
  orbit.enabled = m === 'overview';
  modeBtn.textContent = m === 'overview' ? 'Walk the island' : 'Overview';
  panel.innerHTML = help[m];
  if (m === 'explore') {
    // keep looking roughly the same way the overview camera faced
    const d = new THREE.Vector3().subVectors(camera.position, player.pos);
    follow.yaw = Math.atan2(d.x, d.z);
  } else {
    orbit.target.copy(player.pos).setY(0);
  }
}
modeBtn.addEventListener('click', () => setMode(mode === 'overview' ? 'explore' : 'overview'));
panel.innerHTML = help.overview;

// input
const input = { forward: false, back: false, left: false, right: false, run: false };
const keymap = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
addEventListener('keydown', (e) => {
  if (keymap[e.code]) { input[keymap[e.code]] = true; if (mode === 'explore') e.preventDefault(); }
  if (e.key === 'Shift') input.run = true;
  if (e.code === 'KeyC' && !e.repeat) setMode(mode === 'overview' ? 'explore' : 'overview');
});
addEventListener('keyup', (e) => {
  if (keymap[e.code]) input[keymap[e.code]] = false;
  if (e.key === 'Shift') input.run = false;
});
addEventListener('blur', () => { for (const k in input) input[k] = false; });

let dragging = false, lastX = 0, lastY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging || mode !== 'explore') return;
  follow.yaw -= (e.clientX - lastX) * 0.006;
  follow.pitch = Math.min(1.2, Math.max(-0.15, follow.pitch + (e.clientY - lastY) * 0.004));
  lastX = e.clientX; lastY = e.clientY;
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (mode !== 'explore') return;
  follow.dist = Math.min(22, Math.max(3, follow.dist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: true });

// URL hash presets for quick inspection: #top, #walk
function applyHash() {
  if (location.hash === '#top') {
    camera.position.set(0, 230, 0.01); orbit.target.set(0, 0, 0); orbit.update();
  } else if (location.hash.startsWith('#cam=')) {
    // #cam=x,y,z,tx,ty,tz  (inspection shots)
    const v = location.hash.slice(5).split(',').map(Number);
    camera.position.set(v[0], v[1], v[2]); orbit.target.set(v[3], v[4], v[5]); orbit.update();
  } else if (location.hash === '#walk') {
    setMode('explore'); blend = 1;
  }
}
applyHash();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const fpsEl = document.getElementById('fps');
let fpsAcc = 0, fpsN = 0;
const desired = new THREE.Vector3(), look = new THREE.Vector3();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;

  if (mode === 'explore') player.update(dt, input, follow.yaw);
  else player.update(dt, {}, follow.yaw);
  train.update(dt);
  traffic.update(dt, mode === 'explore' ? player.pos : null);
  water.update(time);
  boats.update(dt, time, water.heightAt);
  nature.update(camera, time, innerHeight);

  if (mode === 'explore') {
    look.copy(player.pos).add(new THREE.Vector3(0, 1.5, 0));
    const cp = Math.cos(follow.pitch);
    desired.set(Math.sin(follow.yaw) * cp, Math.sin(follow.pitch), Math.cos(follow.yaw) * cp)
      .multiplyScalar(follow.dist).add(look);
    if (blend < 1) {
      blend = Math.min(1, blend + dt / 1.2);
      const k = blend * blend * (3 - 2 * blend);
      camera.position.lerpVectors(blendFrom.pos, desired, k);
      curLook.lerpVectors(blendFrom.look, look, k);
    } else {
      camera.position.copy(desired);
      curLook.copy(look);
    }
    camera.lookAt(curLook);
  } else {
    if (blend < 1) {
      blend = Math.min(1, blend + dt / 1.2);
      const k = blend * blend * (3 - 2 * blend);
      const toPos = OVERVIEW.pos.clone().add(orbit.target).sub(OVERVIEW.target);
      camera.position.lerpVectors(blendFrom.pos, toPos, k);
      curLook.lerpVectors(blendFrom.look, orbit.target, k);
      camera.lookAt(curLook);
      if (blend >= 1) orbit.update();
    } else {
      orbit.update();
      curLook.copy(orbit.target);
    }
  }

  // the atmosphere owns sun/moon, sky, fog, weather; keep the shadow frustum centred where the action is
  const focus = mode === 'explore' ? player.pos : orbit.target;
  atmo.update(dt, camera, focus);
  sun.target.position.set(focus.x * 0.3, 0, focus.z * 0.3);
  sun.position.copy(sun.target.position).addScaledVector(atmo.lightDir, 160);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);

  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps · ${renderer.info.render.calls} draws`; fpsAcc = 0; fpsN = 0; }
  requestAnimationFrame(tick);
}

initDevPanel(atmo, { view: (...a) => view(...a) });

const loading = document.getElementById('loading');
loading.style.opacity = '0';
setTimeout(() => loading.remove(), 600);
// inspection helper: __aazhi.view([x,y,z], [tx,ty,tz]) frames any shot from the overview orbit
const view = (pos, tgt, hours) => {
  if (mode !== 'overview') setMode('overview');
  blend = 1; orbit.minDistance = 1; orbit.maxPolarAngle = Math.PI * 0.62;
  if (hours !== undefined) atmo.setHours(hours);
  camera.position.set(...pos); orbit.target.set(...tgt); orbit.update();
  atmo.update(0.016, camera, orbit.target);
  sun.position.copy(sun.target.position).addScaledVector(atmo.lightDir, 160);
  renderer.render(scene, camera);
  return `${atmo.info.time} sun ${atmo.info.sunEl.toFixed(1)}° moon ${atmo.info.moonEl.toFixed(1)}° · ${atmo.info.weather}`;
};
window.__aazhi = { scene, camera, player, ctx, setMode, nature, renderer, windUniforms, water, coastUniforms, orbit, follow, atmo, view };
requestAnimationFrame(tick);

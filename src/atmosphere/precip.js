import * as THREE from 'three';
import { makeRng } from './weather.js';

// ---------------------------------------------------------------------------
// Rain: instanced streak quads in a world-anchored box that wraps around a
// point in front of the camera (drops never "follow" the camera), slanted by
// the wind, sized to stay ~1px wide at overview distance. Intensity simply
// enables a fraction of the drops, so one draw call covers drizzle to monsoon.
// ---------------------------------------------------------------------------
export function buildRain(scene, count) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const r = makeRng(3301);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = r();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = count;
  const uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uSize: { value: new THREE.Vector3(40, 30, 40) },
    uFall: { value: 9.5 },
    uWind: { value: new THREE.Vector2() },
    uLen: { value: 0.9 },
    uPx: { value: 0.002 },
    uAmount: { value: 0 },
    uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uAlpha: { value: 0.32 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uFall, uLen, uPx, uAmount;
      uniform vec3 uCenter, uSize;
      uniform vec2 uWind;
      varying float vA;
      varying vec2 vUv;
      void main() {
        if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float sp = 0.82 + 0.36 * fract(aSeed.w * 13.7);
        vec3 vel = vec3(uWind.x, -uFall * sp, uWind.y);
        vec3 p = aSeed.xyz * uSize + vel * uTime;
        vec3 bmin = uCenter - uSize * 0.5;
        p = bmin + mod(p - bmin, uSize);
        vec3 vd = normalize(vel);
        vec3 toCam = cameraPosition - p;
        float dist = length(toCam);
        vec3 side = normalize(cross(vd, toCam / dist));
        float w = max(0.007, dist * uPx * 1.45);
        float len = uLen * (0.7 + 0.6 * fract(aSeed.x * 31.1)) * (1.0 + dist * 0.004);
        vec3 wp = p + side * position.x * w - vd * position.y * len;
        vUv = vec2(position.x, position.y);
        // fade in/out at the box faces so wrapping never pops; thin out far drops
        vec3 q = abs(p - uCenter) / (uSize * 0.5);
        float edge = 1.0 - smoothstep(0.75, 1.0, max(max(q.x, q.y), q.z));
        // drops at the lens are out of focus: fade them so they never smear the view
        vA = edge * (1.0 - smoothstep(60.0, 260.0, dist) * 0.6) * smoothstep(1.2, 5.5, dist);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vA;
      varying vec2 vUv;
      void main() {
        float across = 1.0 - abs(vUv.x) * 2.0;
        float along = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
        float a = uAlpha * vA * across * along;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, uniforms };
}

// ---------------------------------------------------------------------------
// Splashes: a world-anchored grid of cells around the focus; each cell fires
// short-lived crowns + rings at random sub-positions on the walkable surface
// (heights from a baked map of roads, pavements, plazas, lawns, pier, beach).
// ---------------------------------------------------------------------------
export function bakeSurfaceHeights(walkMesh, rect = [-66, -58, 66, 66], N = 224) {
  const [x0, z0, x1, z1] = rect;
  const data = new Float32Array(N * N * 4);
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const o = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    o.set(x0 + ((i + 0.5) / N) * (x1 - x0), 40, z0 + ((j + 0.5) / N) * (z1 - z0));
    ray.set(o, down); ray.far = 60;
    const hit = ray.intersectObject(walkMesh, false)[0];
    const k = (j * N + i) * 4;
    if (!hit || hit.point.y < 0.05) { data[k + 1] = 0; continue; }
    const y = hit.point.y;
    // hard paving splashes crisply, lawns and sand swallow most of it
    const kind = y > 1.5 && y < 1.82 ? 1 : y > 1.95 && y < 2.2 ? 0.3 : y < 1.4 ? 0.35 : 0.8;
    data[k] = y; data[k + 1] = kind;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false;
  t.needsUpdate = true;
  return { tex: t, rect };
}

export function buildSplashes(scene, heights, grid) {
  const count = grid * grid;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], 3));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  const idx = new Float32Array(count * 2);
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) { idx[(j * grid + i) * 2] = i; idx[(j * grid + i) * 2 + 1] = j; }
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(idx, 2));
  geo.instanceCount = count;
  const uniforms = {
    uTime: { value: 0 },
    uFocus: { value: new THREE.Vector3() },
    uGrid: { value: grid },
    uCell: { value: 0.75 },
    uAmount: { value: 0 },
    uHeights: { value: heights.tex },
    uRect: { value: new THREE.Vector4(...heights.rect) },
    uColor: { value: new THREE.Color(0.8, 0.83, 0.86) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, fog: false,
    vertexShader: /* glsl */`
      attribute vec2 aCell;
      uniform float uTime, uGrid, uCell, uAmount;
      uniform vec3 uFocus;
      uniform sampler2D uHeights;
      uniform vec4 uRect;
      varying vec2 vUv;
      varying float vPh, vA;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 base = floor(uFocus.xz / uCell) - uGrid * 0.5;
        vec2 cell = base + aCell;
        float hs = h21(cell);
        float period = 0.45 + hs * 0.5;
        float tt = uTime / period + hs * 7.0;
        float cyc = floor(tt);
        float ph = fract(tt);
        float fire = h21(cell + cyc * 0.731);
        vec2 jit = vec2(h21(cell + cyc * 1.37 + 0.5), h21(cell - cyc * 0.93 + 2.1));
        vec2 xz = (cell + jit) * uCell;
        vec2 uv = (xz - uRect.xy) / (uRect.zw - uRect.xy);
        vec4 hs4 = texture2D(uHeights, uv);
        float kind = (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) ? hs4.g : 0.0;
        float dist = length(cameraPosition - vec3(xz.x, hs4.r, xz.y));
        float on = step(fire, uAmount * 0.85) * step(0.01, kind) * (1.0 - smoothstep(18.0, 36.0, dist));
        if (on < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float size = 0.05 + 0.11 * ph;
        vec3 wp = vec3(xz.x, hs4.r + 0.015, xz.y) + position * size;
        vUv = position.xz;
        vPh = ph;
        vA = kind;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vPh, vA;
      void main() {
        float r = length(vUv);
        float ring = smoothstep(0.16, 0.0, abs(r - 0.82)) * (1.0 - vPh);
        float crown = (1.0 - smoothstep(0.0, 0.35, vPh)) * smoothstep(0.55, 0.15, r);
        float drops = 0.0;
        if (vPh < 0.45) {
          float ang = atan(vUv.y, vUv.x);
          float spokes = pow(abs(sin(ang * 4.0 + 1.3)), 24.0);
          drops = spokes * smoothstep(0.12, 0.0, abs(r - vPh * 1.9)) * (1.0 - vPh / 0.45);
        }
        float a = (ring * 0.3 + crown * 0.55 + drops * 0.7) * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a * 0.6);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, uniforms };
}

// ---------------------------------------------------------------------------
// Lightning: fractal cloud-to-ground bolt (with forks) built as camera-facing
// ribbons, plus a soft wide glow ribbon. Rebuilt per strike, shown for the
// flash pulses only.
// ---------------------------------------------------------------------------
export function buildBolt(scene) {
  const core = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.9, 0.92, 1.0), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
  }));
  const glow = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.45, 0.5, 1.0), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
  }));
  for (const m of [core, glow]) { m.frustumCulled = false; m.renderOrder = 2; m.visible = false; scene.add(m); }

  const ribbon = (paths, camPos, width) => {
    const pos = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), dirv = new THREE.Vector3(), side = new THREE.Vector3(), view = new THREE.Vector3();
    for (const { pts, w } of paths) {
      for (let i = 0; i < pts.length - 1; i++) {
        a.copy(pts[i]); b.copy(pts[i + 1]);
        dirv.subVectors(b, a).normalize();
        view.subVectors(camPos, a).normalize();
        side.crossVectors(dirv, view).normalize().multiplyScalar(width * w * (1 - (i / pts.length) * 0.4));
        pos.push(a.x - side.x, a.y - side.y, a.z - side.z, a.x + side.x, a.y + side.y, a.z + side.z, b.x + side.x, b.y + side.y, b.z + side.z);
        pos.push(a.x - side.x, a.y - side.y, a.z - side.z, b.x + side.x, b.y + side.y, b.z + side.z, b.x - side.x, b.y - side.y, b.z - side.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  };
  const r = makeRng(Date.now() & 0xffff);
  // midpoint displacement: big kinks at large scale, fine crackle at small scale
  const subdivide = (a, b, disp, levels) => {
    if (levels === 0) return [a];
    const m = a.clone().lerp(b, 0.4 + r() * 0.2);
    m.x += (r() - 0.5) * disp; m.z += (r() - 0.5) * disp; m.y += (r() - 0.5) * disp * 0.25;
    return [...subdivide(a, m, disp * 0.55, levels - 1), ...subdivide(m, b, disp * 0.55, levels - 1)];
  };
  const jag = (from, to, depth, out, spread) => {
    const pts = [...subdivide(from, to, spread * 3.2, depth === 0 ? 7 : 5), to.clone()];
    out.push({ pts, w: depth === 0 ? 1 : 0.45 });
    if (depth < 1) {
      for (let f = 0; f < 4; f++) {
        if (r() > 0.65) continue;
        const k = 4 + Math.floor(r() * (pts.length * 0.55));
        const s = pts[k];
        const e = s.clone().add(new THREE.Vector3((r() - 0.5) * 140, -(60 + r() * 140), (r() - 0.5) * 140));
        jag(s, e, depth + 1, out, spread * 0.6);
      }
    }
    return out;
  };
  return {
    strike(ground, top, camPos) {
      const paths = jag(top, ground, 0, [], 34);
      core.geometry.dispose(); glow.geometry.dispose();
      const dist = camPos.distanceTo(ground);
      core.geometry = ribbon(paths, camPos, Math.max(0.6, dist * 0.0011));
      glow.geometry = ribbon(paths, camPos, Math.max(5, dist * 0.008));
    },
    set(level) {
      core.visible = glow.visible = level > 0.01;
      core.material.opacity = Math.min(1, level * 1.4);
      glow.material.opacity = level * 0.35;
    },
  };
}

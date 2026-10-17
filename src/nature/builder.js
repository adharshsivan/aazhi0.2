import * as THREE from 'three';

// Geometry builder shared by all procedural plants. Every asset produces the same
// attribute layout (position, normal, uv, color, wind) so they can share one
// BatchedMesh / material. `wind` is the per-vertex sway weight in metres
// (0 for trunks and stems so they stay rigid).

const _v = new THREE.Vector3();

export class GeoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.wind = []; this.idx = []; }
  get count() { return this.pos.length / 3; }

  vert(p, n, u, v, c, w = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.wind.push(w);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('wind', new THREE.Float32BufferAttribute(this.wind, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /**
   * Tapered tube along a polyline (parallel-transport frames).
   * strip: {u0,u1} bark strip, vPerM: texture repeats per metre along the length.
   */
  tube(path, radii, { radial = 6, strip, vPerM = 0.35, vOff = 0, color = () => [1, 1, 1], wind = () => 0, cap = false }) {
    const n = path.length;
    const T = [], N = [], B = [];
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      T.push(new THREE.Vector3().subVectors(b, a).normalize());
    }
    let ref = Math.abs(T[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    N.push(new THREE.Vector3().crossVectors(T[0], ref).normalize());
    for (let i = 1; i < n; i++) {
      const prev = N[i - 1].clone();
      prev.addScaledVector(T[i], -prev.dot(T[i])).normalize();
      N.push(prev);
    }
    for (let i = 0; i < n; i++) B.push(new THREE.Vector3().crossVectors(T[i], N[i]).normalize());
    let len = 0;
    const base = this.count;
    for (let i = 0; i < n; i++) {
      if (i) len += path[i].distanceTo(path[i - 1]);
      const t = i / (n - 1);
      const c = color(t), w = wind(t);
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        const dir = _v.copy(N[i]).multiplyScalar(Math.cos(a)).addScaledVector(B[i], Math.sin(a));
        const p = path[i].clone().addScaledVector(dir, radii[i]);
        this.vert(p, dir.clone(), strip.u0 + (strip.u1 - strip.u0) * (k / radial), vOff + len * vPerM, c, w);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = base + i * (radial + 1) + k, b = a + radial + 1;
        this.quad(a, b, b + 1, a + 1);
      }
    }
    if (cap) {
      const c = this.vert(path[n - 1], T[n - 1], strip.u0, vOff + len * vPerM, color(1), wind(1));
      const ring = base + (n - 1) * (radial + 1);
      for (let k = 0; k < radial; k++) this.tri(ring + k, ring + k + 1, c);
    }
    return this;
  }

  /**
   * Leaf card: centre c, half-axes ax (right) / ay (up, towards tile top).
   * nf(p) returns the shading normal for a vertex; cf(p) its colour; wf(p, top) its wind.
   */
  card(c, ax, ay, rect, nf, cf, wf, flipU = false) {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ids = corners.map(([sx, sy]) => {
      const p = c.clone().addScaledVector(ax, sx).addScaledVector(ay, sy);
      const fu = flipU ? -sx : sx;
      return this.vert(p, nf(p), fu < 0 ? rect.u0 : rect.u1, sy < 0 ? rect.v1 : rect.v0, cf(p), wf(p, sy > 0));
    });
    this.quad(ids[0], ids[1], ids[2], ids[3]);
  }

  /**
   * Cupped leaf card (3x3 grid): the centre bulges along `n` so a cluster card
   * reads as a volume instead of a flat sheet. `anchor`: 'bottom' (cluster
   * texture whose twig enters at the bottom edge) or 'center' (rosettes).
   */
  cuppedCard(a, ax, ay, n, cup, rect, nf, cf, wf, flipU = false, anchor = 'bottom') {
    const ids = [];
    for (let j = 0; j <= 2; j++) {
      for (let i = 0; i <= 2; i++) {
        const sx = i - 1, sy = anchor === 'bottom' ? j / 2 * 2 - 1 : j - 1;
        const p = a.clone().addScaledVector(ax, sx);
        if (anchor === 'bottom') p.addScaledVector(ay, (sy + 1));
        else p.addScaledVector(ay, sy);
        const bulge = cup * (0.6 - 0.5 * (sx * sx + sy * sy) * 0.6) * (anchor === 'bottom' ? (j === 0 ? 0.2 : 1) : 1);
        p.addScaledVector(n, bulge);
        const fu = flipU ? -sx : sx;
        const u = rect.u0 + (rect.u1 - rect.u0) * (fu + 1) / 2;
        const v = rect.v1 - (rect.v1 - rect.v0) * (sy + 1) / 2;
        ids.push(this.vert(p, nf(p), u, v, cf(p), wf(p, sy)));
      }
    }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const a0 = j * 3 + i;
      this.quad(ids[a0], ids[a0 + 1], ids[a0 + 4], ids[a0 + 3]);
    }
  }

  /**
   * Folded leaf ribbon along a midrib (palm fronds, banana / strap leaves).
   * rows: [{p, side, up, w, fold, t, color, wind}]; texture u runs along the
   * length, v maps the half-widths relative to wMax (centre = midrib).
   */
  ribbon(rows, rect, wMax, upBias = 0.45) {
    const vc = (rect.v0 + rect.v1) / 2, vh = (rect.v1 - rect.v0) / 2;
    const ids = [];
    const wu = new THREE.Vector3(0, 1, 0);
    for (const r of rows) {
      const u = rect.u0 + (rect.u1 - rect.u0) * r.t;
      const cf = Math.cos(r.fold), sf = Math.sin(r.fold);
      const lDir = r.side.clone().multiplyScalar(-cf).addScaledVector(r.up, -sf);
      const rDir = r.side.clone().multiplyScalar(cf).addScaledVector(r.up, -sf);
      const nl = r.up.clone().multiplyScalar(cf).addScaledVector(r.side, -sf).addScaledVector(wu, upBias).normalize();
      const nr = r.up.clone().multiplyScalar(cf).addScaledVector(r.side, sf).addScaledVector(wu, upBias).normalize();
      const nc = r.up.clone().addScaledVector(wu, upBias).normalize();
      const wl = r.wl ?? r.w, wr = r.wr ?? r.w;
      const vlFrac = Math.min(1, Math.max(0, wl / (wMax || 1)));
      const vrFrac = Math.min(1, Math.max(0, wr / (wMax || 1)));
      const edgeCol = r.edgeColor || r.color;
      ids.push([
        this.vert(r.p.clone().addScaledVector(lDir, wl), nl, u, vc - vh * vlFrac, edgeCol, r.wind + (r.flutter || 0)),
        this.vert(r.p, nc, u, vc, r.color, r.wind),
        this.vert(r.p.clone().addScaledVector(rDir, wr), nr, u, vc + vh * vrFrac, edgeCol, r.wind + (r.flutter || 0)),
      ]);
    }
    for (let i = 0; i < ids.length - 1; i++) {
      const [a0, a1, a2] = ids[i], [b0, b1, b2] = ids[i + 1];
      this.quad(a0, b0, b1, a1);
      this.quad(a1, b1, b2, a2);
    }
  }

  /** Low-poly sphere (coconuts, nuts) using the plain atlas texel. */
  sphere(c, r, ws, hs, uv, color, wind = 0, squash = 1) {
    const base = this.count;
    for (let j = 0; j <= hs; j++) {
      const v = j / hs, ph = v * Math.PI;
      for (let i = 0; i <= ws; i++) {
        const th = (i / ws) * Math.PI * 2;
        const n = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
        const p = c.clone().add(new THREE.Vector3(n.x * r, n.y * r * squash, n.z * r));
        const shade = 0.75 + 0.25 * (n.y * 0.5 + 0.5);
        this.vert(p, n, uv[0], uv[1], [color[0] * shade, color[1] * shade, color[2] * shade], wind);
      }
    }
    for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) {
      const a = base + j * (ws + 1) + i, b = a + ws + 1;
      this.quad(a, b, b + 1, a + 1);
    }
  }
}

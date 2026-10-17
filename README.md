# Aazhi — Island Vertical Slice

A compact, walkable Three.js recreation of the Kerala-inspired island reference: tall apartment block, mural low-rise, elevated metro station + viaduct, waterfront café, pavilion, bus shelters, beach and pier.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/
```

## Controls
- **Overview** (default): drag to orbit, right-drag to pan, scroll to zoom.
- **Walk** (`C` or the button): `WASD`/arrows, `Shift` to run, drag to look, scroll to zoom.
- Inspection URLs: `#top`, `#walk`, `#cam=x,y,z,tx,ty,tz`.

## How the island is built
Everything is generated from the data in `src/layout.js` (axes: +x east, +z south, metres).

- `src/geom.js` – curve sampling, Clipper polygon ops, slab extrusion, static batching.
- `world/terrain.js` – road network is the union of buffered centrelines with curb returns
  (morphological close), paving = island − roads (curbs are the slab sides), planting beds are
  derived by subtracting roads, sidewalks, footprints, plazas and paths. Markings are clipped at
  junctions and crossings. Also seawall, rocks, beach, beach stairs, pier and railings.
- `world/metro.js` – viaduct, piers, track, station (stairs → south platform) and shuttle train.
- `world/buildings.js`, `props.js` – structures, street furniture, boats.
- `nature/` – procedural vegetation + shoreline system (see below).
- `world/water.js` – placeholder sea (shore mask → turquoise shallows + foam) and sky.
- `player.js` – third-person walker; ground via BVH raycast over one merged walk mesh
  (step up ≤ 0.6 m, step down ≤ 0.65 m so walls/platform edges/pier edges block), 2D colliders with height ranges.
- `traffic.js` – left-hand ring-road traffic that yields to the player.

## Nature system (`src/nature/`)
| file | role |
|---|---|
| `atlas.js` | one 2048×1024 painted atlas: coconut fronds (fresh/dry), mango, rain-tree, gulmohar, frangipani, banana, pandanus/lily straps, bougainvillea, hibiscus, croton, ixora, fern, grass, morning-glory, plus two vertically tiling bark strips. Colour and alpha are painted separately (no dark mip fringes). |
| `plants.js` | seeded generators with 3 LODs each: coconut & areca palms (curved tapered trunks, gravity-bent folded fronds, dead fronds, coconuts), broadleaf trees (branch skeleton + canopy leaf-card clusters with volume normals and baked AO), banana, pandanus, spider lily, card shrubs, ground cover. All random choices are drawn before building, so LODs share one silhouette. |
| `rocks.js` | boulders = noisy ellipsoid + planar fracture cuts + bearing face, cavity AO and mottled vertex colour; tileable granite texture. |
| `materials.js` | one vegetation material (alpha-to-coverage + mip alpha boost, double-sided without normal flip, vertex-weighted wind on leaves only — trunks never move) and one rock material (world-space triplanar detail, derivative bump, wet/darker waterline band). |
| `lod.js` | `LODBatch` = one `THREE.BatchedMesh` per group with pooled LOD geometry; instances swap LOD by projected screen size (`setGeometryIdAt`), tiny ground cover is hidden at distance. `LODManager` only re-evaluates when the camera moves. |
| `index.js` | placement from the real layout: promenade planter palms lean seaward, trees by Poisson disk in bed cores (species from noise + context: coast, near buildings, under the viaduct), bed borders and shrub drifts, ground cover, coastal sand planting, balcony planters, and a 4-row graded rock revetment. Keeps crossings/junction sight zones, entrances, stairs, pier and paths clear, then validates (`nature.stats.issues`, rock resting check). |

Batches: trees (casts shadows), ground plants (no shadows), rocks above the waterline (casts), waterline rocks (no shadows). Mobile uses a lower LOD bias. Inspect at runtime with `__aazhi.nature.stats` / `__aazhi.nature.census()`.

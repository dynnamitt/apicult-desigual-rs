//! WebAssembly bindings for `apicult-desigual`. Gated behind the `wasm`
//! feature so native builds don't pull `wasm-bindgen`.
//!
//! `WasmLayout` packs a bounded grid for the pages that need cell groupings:
//!   - `tris()` — the unified mesh stream (`all_tris`): hex faces,
//!     tessellated gap quads and 3-way junction tris.
//!   - `wire_edges()` — gap-quad perimeter segments, no internal
//!     tessellation diagonal. Drops straight into a `LineSegments` geometry.
//!   - `face_tris()` / `face_bridge_quads()` — per-hex groupings (54 and 78
//!     floats per hex) for the units and crawler pages.
//!
//! Numeric layout: tris are flat `n_tris * 9` floats (3 verts × 3 floats);
//! wire_edges are flat `n_edges * 6` floats (2 endpoints × 3 floats). Both
//! arrive as `Float32Array` on the JS side.
//!
//! `wire_edges` per-quad order is fixed: 4 segments walking the CCW corner
//! sequence `q[0]→q[1]→q[2]→q[3]→q[0]`. Quad-local edge indices `0` and `2`
//! are **bridge** segments (cross-gap, hex→neighbor); `1` and `3` are **rim**
//! segments (along one hex's side). Consumers wanting a single role can
//! derive it from the quad-local index without any extra metadata.
//!
//! Chunks cross as stateless functions, one per layout function (see
//! `docs/design/cell-state.md`): each call builds chunk `(q, r)` from the
//! seeds and returns one flat buffer. The treadmill groups seams itself.

use glam::Vec3;
use hexx::Hex;
use wasm_bindgen::prelude::*;

use crate::chunk::entangled_seam_keys;
use crate::layout::{ChunkError, HGridLayout, HGridSettings, chunk_center_hex};

/// Project defaults with the two noise seeds the pages choose.
fn seeded(height_seed: u32, radius_seed: u32) -> HGridSettings {
    let mut g = HGridSettings::default();
    g.height_noise.seed = height_seed;
    g.radius_noise.seed = radius_seed;
    g
}

/// Opaque handle wrapping `HGridLayout`. Build once, query repeatedly.
#[wasm_bindgen]
pub struct WasmLayout {
    inner: HGridLayout,
}

#[wasm_bindgen]
impl WasmLayout {
    /// Build a bounded grid of `radius` rings with project defaults
    /// (`HGridSettings::default()`) and the two noise seeds.
    #[wasm_bindgen(constructor)]
    pub fn new(radius: u32, height_seed: u32, radius_seed: u32) -> Self {
        Self {
            inner: HGridLayout::new(&seeded(height_seed, radius_seed), radius),
        }
    }

    /// Unified mesh stream: hex face fans, gap quad tris and junction tris.
    /// Flat `n_tris * 9` floats.
    pub fn tris(&self) -> Vec<f32> {
        flatten_tris(&self.inner.all_tris())
    }

    /// Gap-quad perimeter segments. Flat `n_edges * 6`
    /// floats (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
    /// `q[0]→q[1]→q[2]→q[3]→q[0]`. Quad-local edges `0`/`2` are bridge
    /// (cross-gap), `1`/`3` are rim (along one hex's side); see module docs.
    /// No tessellation diagonal — feed straight into a `THREE.LineSegments`
    /// geometry.
    pub fn wire_edges(&self) -> Vec<f32> {
        flatten_wire_edges(&self.inner.gap_quads())
    }

    /// Per-hex face fans, flat `n_hexes * 54` floats (6 center-fan tris ×
    /// 3 verts × 3 floats). The grouping is stable: the i-th 54-float slice
    /// owns the 6 tris of the i-th hex in `shapes::hexagon` traversal order.
    /// Lets the JS side address whole hex cells (e.g. random-subset overlays
    /// like the y-axis band shader) without reconstructing the grouping
    /// from the flat `tris` stream.
    pub fn face_tris(&self) -> Vec<f32> {
        flatten_tris(&self.inner.hex_face_tris())
    }

    /// Per-hex face-edge bridge quads, flat
    /// `n_hexes * 78` floats: 6 slots × 13 floats per slot
    /// (`[flag, v0x, v0y, v0z, ..., v3x, v3y, v3z]`). `flag` is `1.0`
    /// when a bridge exists on that face edge, `0.0` on border edges
    /// (the 12 vertex floats are zeros in that case). Stride and hex
    /// ordering match [`face_tris`] — the i-th 78-float slice owns the
    /// 6 bridges of the i-th hex. Quad-corner order matches
    /// the `gap_quads` layout: `v0` / `v3` lie on the source hex
    /// perimeter, `n0` / `n1` on the neighbor — JS picks one of the 6
    /// slots per selected hex and emits two band-shaded tris bridging
    /// the gap.
    pub fn face_bridge_quads(&self) -> Vec<f32> {
        flatten_bridges(self.inner.hex_face_bridge_quads())
    }
}

fn js_error(e: ChunkError) -> JsError {
    JsError::new(&e.to_string())
}

/// Chunk `(q, r)` of the world with these seeds, with no edits.
fn chunk_layout(
    chunk_radius: u32,
    height_seed: u32,
    radius_seed: u32,
    q: i32,
    r: i32,
) -> Result<HGridLayout, JsError> {
    let g = seeded(height_seed, radius_seed);
    HGridLayout::for_chunk(&g, Hex::new(q, r), chunk_radius, &[]).map_err(js_error)
}

/// `HGridLayout::own_tris` of chunk `(q, r)`: flat `n_tris * 9` world-space
/// floats, 14 tris per own cell. Always drawn.
///
/// @throws when the chunk can't be built (see `HGridLayout::for_chunk`).
#[wasm_bindgen]
pub fn chunk_own_tris(
    chunk_radius: u32,
    height_seed: u32,
    radius_seed: u32,
    q: i32,
    r: i32,
) -> Result<Vec<f32>, JsError> {
    let layout = chunk_layout(chunk_radius, height_seed, radius_seed, q, r)?;
    Ok(flatten_tris(&layout.own_tris()))
}

/// `HGridLayout::own_cell_states` of chunk `(q, r)`: flat
/// `[q, r, height, radius, …]`, 4 floats per own cell in `shapes::hexagon` order.
///
/// @throws when the chunk can't be built (see `HGridLayout::for_chunk`).
#[wasm_bindgen]
pub fn chunk_own_cell_states(
    chunk_radius: u32,
    height_seed: u32,
    radius_seed: u32,
    q: i32,
    r: i32,
) -> Result<Vec<f32>, JsError> {
    let layout = chunk_layout(chunk_radius, height_seed, radius_seed, q, r)?;
    let cells = layout.own_cell_states();
    Ok(cells.iter().flat_map(|c| [c.hex.x as f32, c.hex.y as f32, c.height, c.radius]).collect())
}

/// `HGridLayout::entangled_seam_tris` of chunk `(q, r)`: flat `n_tris * 9`
/// world-space floats, parallel to [`chunk_entangled_seam_keys`]. Draw a tri
/// only while `EntangledSeam::drawn` holds for its key.
///
/// @throws when the chunk can't be built (see `HGridLayout::for_chunk`).
#[wasm_bindgen]
pub fn chunk_entangled_seam_tris(
    chunk_radius: u32,
    height_seed: u32,
    radius_seed: u32,
    q: i32,
    r: i32,
) -> Result<Vec<f32>, JsError> {
    let layout = chunk_layout(chunk_radius, height_seed, radius_seed, q, r)?;
    Ok(flatten_tris(&layout.entangled_seam_tris()))
}

/// `entangled_seam_keys` of chunk `(q, r)`, flat `[owner_q, owner_r, also_q,
/// also_r, …]`, 4 ints per seam tri. A key with no `also` repeats its owner
/// there, which makes rule 1 (`EntangledSeam::drawn`) reduce to "owner not
/// loaded" with no special case. Needs no seeds: keys depend only on the shape.
///
/// @throws when the chunk can't be built (see `HGridLayout::for_chunk`).
#[wasm_bindgen]
pub fn chunk_entangled_seam_keys(chunk_radius: u32, q: i32, r: i32) -> Result<Vec<i32>, JsError> {
    let keys = entangled_seam_keys(Hex::new(q, r), chunk_radius).map_err(js_error)?;
    Ok(keys
        .iter()
        .flat_map(|k| {
            let also = k.also.unwrap_or(k.owner);
            [k.owner.x, k.owner.y, also.x, also.y]
        })
        .collect())
}

/// World `[x, z]` of chunk `(q, r)`'s centre cell. Needs no seeds.
///
/// @throws when the chunk can't be built (see `HGridLayout::for_chunk`).
#[wasm_bindgen]
pub fn chunk_center(chunk_radius: u32, q: i32, r: i32) -> Result<Vec<f32>, JsError> {
    let center = chunk_center_hex(Hex::new(q, r), chunk_radius).map_err(js_error)?;
    // World positions depend only on the hex size, so a one-cell grid will do.
    let c = HGridLayout::new(&HGridSettings::default(), 0).hex_to_world_pos(center);
    Ok(vec![c.x, c.y])
}

fn flatten_tris(tris: &[[Vec3; 3]]) -> Vec<f32> {
    let mut out = Vec::with_capacity(tris.len() * 9);
    for [a, b, c] in tris {
        out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
    }
    out
}

fn flatten_bridges(data: Vec<[Option<[Vec3; 4]>; 6]>) -> Vec<f32> {
    let mut out = Vec::with_capacity(data.len() * 78);
    for hex_bridges in data {
        for slot in hex_bridges {
            if let Some(corners) = slot {
                out.push(1.0);
                for v in corners {
                    out.extend_from_slice(&[v.x, v.y, v.z]);
                }
            } else {
                out.extend_from_slice(&[0.0_f32; 13]);
            }
        }
    }
    out
}

fn flatten_wire_edges(quads: &[[Vec3; 4]]) -> Vec<f32> {
    let mut out = Vec::with_capacity(quads.len() * 24);
    for &[a, b, c, d] in quads {
        out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z]);
        out.extend_from_slice(&[b.x, b.y, b.z, c.x, c.y, c.z]);
        out.extend_from_slice(&[c.x, c.y, c.z, d.x, d.y, d.z]);
        out.extend_from_slice(&[d.x, d.y, d.z, a.x, a.y, a.z]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHUNK_RADIUS: u32 = 2;
    const HEIGHT_SEED: u32 = 43;
    const RADIUS_SEED: u32 = 137;

    #[test]
    fn chunk_functions_flatten_the_layout() {
        for (q, r) in [(0, 0), (-3, 2)] {
            let g = seeded(HEIGHT_SEED, RADIUS_SEED);
            let layout = HGridLayout::for_chunk(&g, Hex::new(q, r), CHUNK_RADIUS, &[]).unwrap();
            let own = chunk_own_tris(CHUNK_RADIUS, HEIGHT_SEED, RADIUS_SEED, q, r).unwrap();
            assert_eq!(own, flatten_tris(&layout.own_tris()));
            let seam = chunk_entangled_seam_tris(CHUNK_RADIUS, HEIGHT_SEED, RADIUS_SEED, q, r);
            let seam = seam.unwrap();
            assert_eq!(seam, flatten_tris(&layout.entangled_seam_tris()));
            let keys = chunk_entangled_seam_keys(CHUNK_RADIUS, q, r).unwrap();
            assert_eq!(keys.len() / 4, seam.len() / 9);
            assert!(keys.chunks(4).any(|k| k[..2] != k[2..]), "({q}, {r}): no corner keys");
            let cells = chunk_own_cell_states(CHUNK_RADIUS, HEIGHT_SEED, RADIUS_SEED, q, r);
            assert_eq!(cells.unwrap().len(), 4 * layout.own_cells().count());
            let c = layout.hex_to_world_pos(layout.center());
            assert_eq!(chunk_center(CHUNK_RADIUS, q, r).unwrap(), vec![c.x, c.y]);
        }
        assert_eq!(chunk_center(CHUNK_RADIUS, 0, 0).unwrap(), vec![0.0, 0.0]);
    }
}

//! WebAssembly bindings for `apicult-desigual`. Gated behind the `wasm`
//! feature so native builds don't pull `wasm-bindgen`.
//!
//! Two renderable buffers cross the boundary, both filtered by an
//! `entangled` bool so callers can drive separate materials/passes:
//!   - `tris(entangled)` — the unified mesh stream (`all_tris`): hex faces
//!     and tessellated gap quads matching the flag, plus 3-way junction tris
//!     when `entangled = false` (junction tris are never entangled).
//!   - `wire_edges(entangled)` — gap-quad perimeter segments matching the
//!     flag, no internal tessellation diagonal. Drops straight into a
//!     `LineSegments` geometry for shader-driven wireframes.
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
//! Mirror types (`OverrideSpec`, `EntangleSpec`, `NoiseChannel`, `VertexDir`,
//! `HexCellView`) exist because `#[wasm_bindgen]` can't attach to foreign
//! types (`hexx::Hex`, `hexx::VertexDirection`) or to structs/tuples
//! containing them. Keeping them in this module localizes the bridge code.

use glam::Vec3;
use hexx::{Hex, VertexDirection};
use wasm_bindgen::prelude::*;

use crate::chunk::{Chunk, ChunkSource, NoiseWorld};
use crate::layout::{GapQuad, HGridLayout, HGridSettings, NoiseType, Override};

/// Mirror of `crate::NoiseType` exposed as a C-like enum for `wasm-bindgen`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseChannel {
    Height,
    Size,
}

impl From<NoiseChannel> for NoiseType {
    fn from(c: NoiseChannel) -> Self {
        match c {
            NoiseChannel::Height => NoiseType::Height,
            NoiseChannel::Size => NoiseType::Size,
        }
    }
}

/// Mirror of `hexx::VertexDirection` (a tuple struct in hexx, so re-expressed
/// here as a 6-variant enum). Indices match `VertexDirection::ALL_DIRECTIONS`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexDir {
    East = 0,
    SouthEast = 1,
    SouthWest = 2,
    West = 3,
    NorthWest = 4,
    NorthEast = 5,
}

impl From<VertexDir> for VertexDirection {
    fn from(v: VertexDir) -> Self {
        VertexDirection::ALL_DIRECTIONS[v as usize]
    }
}

/// Per-hex override input from JS. Maps to `crate::Override = (NoiseType, Hex, f32)`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct OverrideSpec {
    pub kind: NoiseChannel,
    pub q: i32,
    pub r: i32,
    pub value: f32,
}

#[wasm_bindgen]
impl OverrideSpec {
    #[wasm_bindgen(constructor)]
    pub fn new(kind: NoiseChannel, q: i32, r: i32, value: f32) -> Self {
        Self { kind, q, r, value }
    }
}

impl From<OverrideSpec> for Override {
    fn from(o: OverrideSpec) -> Self {
        (o.kind.into(), Hex::new(o.q, o.r), o.value)
    }
}

/// Per-hex entangle marker from JS. Maps to `hexx::Hex::new(q, r)`.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct EntangleSpec {
    pub q: i32,
    pub r: i32,
}

#[wasm_bindgen]
impl EntangleSpec {
    #[wasm_bindgen(constructor)]
    pub fn new(q: i32, r: i32) -> Self {
        Self { q, r }
    }
}

impl From<EntangleSpec> for Hex {
    fn from(e: EntangleSpec) -> Self {
        Hex::new(e.q, e.r)
    }
}

/// Flattened `HexCell` (`hex` decomposed into `q`/`r` since `Hex` is foreign
/// and can't carry `#[wasm_bindgen]`).
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub struct HexCellView {
    pub q: i32,
    pub r: i32,
    pub height: f32,
    pub radius: f32,
    pub entangled: bool,
}

/// Opaque handle wrapping `HGridLayout`. Build once, query repeatedly.
#[wasm_bindgen]
pub struct WasmLayout {
    inner: HGridLayout,
}

#[wasm_bindgen]
impl WasmLayout {
    /// Build a layout with project defaults (`HGridSettings::default()`)
    /// overridden by the explicit `radius` and noise seeds. `overrides`
    /// pin per-hex height/radius values after noise sampling; `entangle`
    /// marks the listed hexes as entangled.
    #[wasm_bindgen(constructor)]
    pub fn new(
        radius: u32,
        height_seed: u32,
        radius_seed: u32,
        overrides: Vec<OverrideSpec>,
        entangle: Vec<EntangleSpec>,
    ) -> Self {
        let settings = HGridSettings {
            radius,
            height_noise_seed: height_seed,
            radius_noise_seed: radius_seed,
            ..HGridSettings::default()
        };
        let mapped_overrides: Vec<Override> =
            overrides.into_iter().map(Override::from).collect();
        let mapped_entangle: Vec<Hex> = entangle.into_iter().map(Hex::from).collect();
        Self {
            inner: HGridLayout::new(&settings, &mapped_overrides, &mapped_entangle),
        }
    }

    /// Unified mesh stream filtered by entanglement. Flat `n_tris * 9` floats:
    /// gap quad tris + hex face fans matching `entangled`, plus junction tris
    /// when `entangled = false`.
    pub fn tris(&self, entangled: bool) -> Vec<f32> {
        flatten_tris(&self.inner.all_tris(entangled))
    }

    /// Gap-quad perimeter segments matching `entangled`. Flat `n_edges * 6`
    /// floats (`x1,y1,z1,x2,y2,z2`); 4 segments per quad walking
    /// `q[0]→q[1]→q[2]→q[3]→q[0]`. Quad-local edges `0`/`2` are bridge
    /// (cross-gap), `1`/`3` are rim (along one hex's side); see module docs.
    /// No tessellation diagonal — feed straight into a `THREE.LineSegments`
    /// geometry.
    pub fn wire_edges(&self, entangled: bool) -> Vec<f32> {
        flatten_wire_edges(self.inner.gap_quads(), entangled)
    }

    /// Per-hex face fans matching `entangled`, flat `n_hexes * 54` floats
    /// (6 center-fan tris × 3 verts × 3 floats). The grouping is stable:
    /// the i-th 54-float slice owns the 6 tris of the i-th matching hex
    /// (in `shapes::hexagon` traversal order, skipping non-matching cells).
    /// Lets the JS side address whole hex cells (e.g. random-subset overlays
    /// like the y-axis band shader) without reconstructing the grouping
    /// from the flat `tris` stream.
    pub fn face_tris(&self, entangled: bool) -> Vec<f32> {
        flatten_tris(&self.inner.hex_face_tris(entangled))
    }

    /// Per-hex face-edge bridge quads matching `entangled`, flat
    /// `n_hexes * 78` floats: 6 slots × 13 floats per slot
    /// (`[flag, v0x, v0y, v0z, ..., v3x, v3y, v3z]`). `flag` is `1.0`
    /// when a bridge exists on that face edge, `0.0` on border edges
    /// (the 12 vertex floats are zeros in that case). Stride and hex
    /// ordering match [`face_tris`] — the i-th 78-float slice owns the
    /// 6 bridges of the i-th matching hex. Quad-corner order matches
    /// the `gap_quads` layout: `v0` / `v3` lie on the source hex
    /// perimeter, `n0` / `n1` on the neighbor — JS picks one of the 6
    /// slots per selected hex and emits two band-shaded tris bridging
    /// the gap.
    pub fn face_bridge_quads(&self, entangled: bool) -> Vec<f32> {
        flatten_bridges(self.inner.hex_face_bridge_quads(entangled))
    }

    /// Cells along one outer side of the hexagon-shaped grid (see
    /// `HGridLayout::borderline_cells`). Returns `grid_radius + 1` views.
    pub fn borderline_cells(&self, direction: VertexDir) -> Vec<HexCellView> {
        self.inner
            .borderline_cells(direction.into())
            .map(|c| HexCellView {
                q: c.hex.x,
                r: c.hex.y,
                height: c.height,
                radius: c.radius,
                entangled: c.entangled,
            })
            .collect()
    }
}

/// Chunk generator for one world: every chunk shares `chunk_radius` and both
/// noise seeds (other settings are `HGridSettings::default()`).
#[wasm_bindgen]
pub struct WasmChunkWorld {
    inner: NoiseWorld,
}

#[wasm_bindgen]
impl WasmChunkWorld {
    /// @param chunk_radius — rings of cells per chunk.
    /// @param height_seed — height-noise seed, the same for every chunk.
    /// @param radius_seed — radius-noise seed, the same for every chunk.
    #[wasm_bindgen(constructor)]
    pub fn new(chunk_radius: u32, height_seed: u32, radius_seed: u32) -> Self {
        Self {
            inner: NoiseWorld {
                settings: HGridSettings {
                    height_noise_seed: height_seed,
                    radius_noise_seed: radius_seed,
                    ..HGridSettings::default()
                },
                chunk_radius,
            },
        }
    }

    /// Builds chunk `(q, r)` on the chunk lattice. Same seeds and coord give the same output.
    pub fn chunk(&self, q: i32, r: i32) -> WasmChunk {
        WasmChunk {
            inner: self.inner.chunk(Hex::new(q, r)),
        }
    }
}

/// One built chunk. All tri buffers are flat `n_tris * 9` floats in world space.
#[wasm_bindgen]
pub struct WasmChunk {
    inner: Chunk,
}

#[wasm_bindgen]
impl WasmChunk {
    /// Owned stream — always drawn.
    pub fn owned(&self) -> Vec<f32> {
        flatten_tris(&self.inner.owned)
    }

    /// World `[x, z]` of the chunk's centre cell.
    pub fn center(&self) -> Vec<f32> {
        vec![self.inner.center.x, self.inner.center.y]
    }

    /// Key of each seam group, flat `[owner_q, owner_r, also_q, also_r, …]`.
    /// A seam with no `also` repeats its owner there, which makes rule 1
    /// (`Seam::drawn`) reduce to "owner not loaded" with no special case.
    ///
    /// @returns {Vec<i32>} 4 ints per group, in `seam(i)` order.
    pub fn seam_keys(&self) -> Vec<i32> {
        self.inner
            .seams
            .iter()
            .flat_map(|s| {
                let also = s.also.unwrap_or(s.owner);
                [s.owner.x, s.owner.y, also.x, also.y]
            })
            .collect()
    }

    /// Seam group `i` — draw only while `Seam::drawn` holds. Empty when out of range.
    pub fn seam(&self, i: usize) -> Vec<f32> {
        self.inner
            .seams
            .get(i)
            .map(|s| flatten_tris(&s.tris))
            .unwrap_or_default()
    }
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

fn flatten_wire_edges(quads: Vec<GapQuad>, entangled: bool) -> Vec<f32> {
    let matching = quads.iter().filter(|q| q.entangled == entangled).count();
    let mut out = Vec::with_capacity(matching * 24);
    for q in quads {
        if q.entangled != entangled {
            continue;
        }
        let [a, b, c, d] = q.corners;
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
    use crate::chunk::{ChunkSource, NoiseWorld};

    const CHUNK_RADIUS: u32 = 2;
    const HEIGHT_SEED: u32 = 43;
    const RADIUS_SEED: u32 = 137;
    const OUT_OF_RANGE_SEAM: usize = 99;

    #[test]
    fn wasm_chunk_flattens_streams() {
        let world = WasmChunkWorld::new(CHUNK_RADIUS, HEIGHT_SEED, RADIUS_SEED);
        let native = NoiseWorld {
            settings: HGridSettings::default(),
            chunk_radius: CHUNK_RADIUS,
        };
        for (q, r) in [(0, 0), (-3, 2)] {
            let wc = world.chunk(q, r);
            let c = native.chunk(Hex::new(q, r));
            assert_eq!(wc.owned().len(), 9 * c.owned.len());
            let keys = wc.seam_keys();
            assert_eq!(keys.len(), 4 * c.seams.len());
            for (i, s) in c.seams.iter().enumerate() {
                assert_eq!(wc.seam(i).len(), 9 * s.tris.len());
                let also = s.also.unwrap_or(s.owner);
                assert_eq!(keys[4 * i..4 * i + 4], [s.owner.x, s.owner.y, also.x, also.y]);
            }
            assert!(c.seams.iter().any(|s| s.also.is_some()), "({q}, {r}): no corner seams");
            assert!(wc.seam(OUT_OF_RANGE_SEAM).is_empty());
            assert_eq!(wc.center(), vec![c.center.x, c.center.y]);
        }
        assert_eq!(world.chunk(0, 0).center(), vec![0.0, 0.0]);
    }
}

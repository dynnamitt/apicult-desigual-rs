//! Hex grid layout: spatial mapping, noise-driven heights/radii, vertex computation.

use glam::{Vec2, Vec3};
use hexx::{
    EdgeDirection, GridVertex, Hex, HexLayout, VertexDirection, shapes,
    storage::{HexStore, HexagonalMap},
};
use noise::{Fbm, MultiFractal, NoiseFn, Perlin};

use crate::math;

/// Grid layout and noise parameters.
#[derive(Clone, Debug)]
pub struct HGridSettings {
    /// Number of hex rings around the origin (~1200 hexes at 20).
    pub radius: u32,
    /// Hex size — center-to-corner distance of a 100% / normal-form cell, in world units.
    /// Pointy-top width is √3·nominal_hex_radius; flat-top width is 2·nominal_hex_radius.
    /// Drives `HexLayout.scale`.
    pub nominal_hex_radius: f32,
    /// Seed for the height noise generator.
    pub height_noise_seed: u32,
    /// Seed for the per-hex radius noise generator.
    pub radius_noise_seed: u32,
    /// Number of octaves for height noise.
    pub height_noise_octaves: usize,
    /// Number of octaves for radius noise.
    pub radius_noise_octaves: usize,
    /// Spatial scale divisor for height noise sampling.
    pub height_noise_scale: f64,
    /// Spatial scale divisor for radius noise sampling.
    pub radius_noise_scale: f64,
    /// Maximum terrain elevation produced by the noise function.
    pub max_height: f32,
    /// Lower bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0`. Cell radii below 1.0 leave room for bridge geometry.
    pub min_radius_ratio: f32,
    /// Upper bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0` (`> 1.0` causes neighbor overlap).
    pub max_radius_ratio: f32,
}

impl Default for HGridSettings {
    fn default() -> Self {
        Self {
            radius: 20,
            nominal_hex_radius: 4.0,
            height_noise_seed: 43,
            radius_noise_seed: 137,
            height_noise_octaves: 4,
            radius_noise_octaves: 3,
            height_noise_scale: 50.0,
            radius_noise_scale: 30.0,
            max_height: 20.0,
            min_radius_ratio: 0.05,
            max_radius_ratio: 0.90,
        }
    }
}

/// Bundled per-hex data: axial position, terrain height, visual radius,
/// and an `entangled` flag (set via the `entangle` arg to [`HGridLayout::new`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexCell {
    pub hex: Hex,
    pub height: f32,
    pub radius: f32,
    pub entangled: bool,
}

/// A gap-filler quad with its derived entanglement flag — true iff both
/// adjacent hex cells are entangled.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GapQuad {
    pub corners: [Vec3; 4],
    pub entangled: bool,
}

/// Encapsulates the hex layout, per-cell data, and vertex computation.
///
/// Owns only the data needed for grid generation and height interpolation —
/// no ECS dependencies.
pub struct HGridLayout {
    layout: HexLayout,
    unit_corners: [Vec2; 6],
    center: Hex,
    grid_radius: u32,
    cells: HexagonalMap<HexCell>,
}

/// Selects which per-hex channel an [`Override`] targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseType {
    Height,
    Size,
}

/// Per-hex override applied after noise sampling: replaces the value at `hex`
/// for the given channel. Out-of-grid hexes are silently ignored.
pub type Override = (NoiseType, Hex, f32);

impl HGridLayout {
    /// Constructs the layout from grid settings, sampling noise for heights and radii.
    /// `overrides` replaces noise-derived values at specific hexes (post-sample).
    /// `entangle` marks the listed hexes as entangled (out-of-grid hexes ignored).
    pub fn new(g: &HGridSettings, overrides: &[Override], entangle: &[Hex]) -> Self {
        Self::build(g, Hex::ZERO, g.radius, overrides, entangle)
    }

    /// Builds chunk `coord`: the radius-`chunk_radius` hexagon of cells with
    /// `hex.to_lower_res(chunk_radius) == coord`, centred on
    /// `coord.to_higher_res(chunk_radius)`, plus one entangled ring at
    /// `chunk_radius + 1`. The ring cells belong to neighbour chunks: they are
    /// read-only, so their faces are never drawn, and they only exist so every
    /// gap touching a chunk cell can be built. Noise is sampled at world
    /// positions, so a chunk built alone matches its neighbours exactly.
    ///
    /// `to_lower_res` divides in `f32`, so cells past roughly
    /// `16.7M / (3·chunk_radius + 2)` cells from the origin can land in the
    /// wrong chunk.
    ///
    /// @param g — seeds and noise parameters; `g.radius` is ignored.
    /// @param coord — the chunk's coordinate on the chunk lattice.
    /// @param chunk_radius — rings of cells per chunk; the same for every chunk of a world.
    /// @returns a layout of radius `chunk_radius + 1` around the chunk centre.
    pub fn for_chunk(g: &HGridSettings, coord: Hex, chunk_radius: u32) -> Self {
        let center = coord.to_higher_res(chunk_radius);
        let ring: Vec<Hex> = center.ring(chunk_radius + 1).collect();
        Self::build(g, center, chunk_radius + 1, &[], &ring)
    }

    fn build(
        g: &HGridSettings,
        center: Hex,
        radius: u32,
        overrides: &[Override],
        entangle: &[Hex],
    ) -> Self {
        let layout = HexLayout {
            scale: Vec2::splat(g.nominal_hex_radius),
            ..HexLayout::default()
        };
        let unit_layout = HexLayout {
            scale: Vec2::splat(1.0),
            ..HexLayout::default()
        };
        let unit_corners_slice = unit_layout.center_aligned_hex_corners();
        let unit_corners: [Vec2; 6] = std::array::from_fn(|i| unit_corners_slice[i]);

        let height_fbm: Fbm<Perlin> =
            Fbm::new(g.height_noise_seed).set_octaves(g.height_noise_octaves);
        let radius_fbm: Fbm<Perlin> =
            Fbm::new(g.radius_noise_seed).set_octaves(g.radius_noise_octaves);

        let radius_lo = g.nominal_hex_radius * g.min_radius_ratio;
        let radius_hi = g.nominal_hex_radius * g.max_radius_ratio;

        let mut cells = HexagonalMap::new(center, radius, |hex| {
            let pos = layout.hex_to_world_pos(hex);
            let h_noise = height_fbm.get([
                pos.x as f64 / g.height_noise_scale,
                pos.y as f64 / g.height_noise_scale,
            ]);
            let r_noise = radius_fbm.get([
                pos.x as f64 / g.radius_noise_scale,
                pos.y as f64 / g.radius_noise_scale,
            ]);
            HexCell {
                hex,
                height: math::map_noise_to_range(h_noise, 0.0, g.max_height),
                radius: math::map_noise_to_range(r_noise, radius_lo, radius_hi),
                entangled: false,
            }
        });

        for &(channel, hex, value) in overrides {
            if let Some(cell) = cells.get_mut(hex) {
                match channel {
                    NoiseType::Height => cell.height = value,
                    NoiseType::Size => cell.radius = value,
                }
            }
        }

        for &hex in entangle {
            if let Some(cell) = cells.get_mut(hex) {
                cell.entangled = true;
            }
        }

        Self {
            layout,
            unit_corners,
            center,
            grid_radius: radius,
            cells,
        }
    }

    // ── Coordinate conversion ──────────────────────────────────────

    /// World-space 2D position of a hex center.
    pub fn hex_to_world_pos(&self, hex: Hex) -> Vec2 {
        self.layout.hex_to_world_pos(hex)
    }

    /// Hex coordinate from a world-space 2D position.
    pub fn world_pos_to_hex(&self, pos: Vec2) -> Hex {
        self.layout.world_pos_to_hex(pos)
    }

    // ── Per-hex data access ────────────────────────────────────────

    /// Bundled read view for a hex — `Some` only when the hex is in-grid.
    pub fn cell(&self, hex: &Hex) -> Option<HexCell> {
        self.cells.get(*hex).copied()
    }

    /// Marks every cell along one outer side as entangled (`grid_radius + 1`
    /// cells, same iteration as [`borderline_cells`]). Idempotent; calling
    /// for adjacent sides simply re-marks the shared corner cells.
    pub fn entangle_borderline(&mut self, direction: VertexDirection) {
        for hex in self.center.ring_edge(self.grid_radius, direction) {
            if let Some(cell) = self.cells.get_mut(hex) {
                cell.entangled = true;
            }
        }
    }

    /// Cells along one outer side of the hexagon-shaped grid.
    ///
    /// `direction` selects the corner where the side begins; the side runs
    /// counter-clockwise to the next corner, yielding `grid_radius + 1` cells.
    /// Adjacent sides share their two corner cells.
    pub fn borderline_cells(
        &self,
        direction: VertexDirection,
    ) -> impl ExactSizeIterator<Item = &HexCell> + '_ {
        self.center
            .ring_edge(self.grid_radius, direction)
            .map(move |h| {
                self.cells
                    .get(h)
                    .expect("ring_edge stays within the hexagon grid")
            })
    }

    /// Computed world-space vertex position for `hex` at corner `index` (0..5).
    pub fn vertex(&self, hex: Hex, index: u8) -> Option<Vec3> {
        let cell = self.cells.get(hex)?;
        let center = self.layout.hex_to_world_pos(hex);
        let offset = self.unit_corners[index as usize] * cell.radius;
        Some(Vec3::new(center.x + offset.x, cell.height, center.y + offset.y))
    }

    /// Unit corner offset for a given corner index (0..5).
    pub fn unit_corner(&self, index: usize) -> Vec2 {
        self.unit_corners[index]
    }

    // ── Compute methods ────────────────────────────────────────────

    /// Returns the two **bridge** edges of each gap quad as `(from, to)` pairs:
    /// the edges that span across the gap connecting hex→neighbor (v0→n0 and
    /// v1→n1). The other two perimeter edges of a gap quad — the **rim** edges
    /// — run along one hex's side and are not returned here. Uses the even-edge
    /// `[0,2,4]` ownership rule so each gap is emitted exactly once.
    ///
    /// "Bridge" vs "rim" is a topological distinction (cross-gap vs along-hex),
    /// independent of relative size — the rim can be longer than the bridge
    /// when the hex radius is much larger than the gap padding.
    pub fn quad_bridge_edges(&self) -> Vec<(Vec3, Vec3)> {
        let mut edges = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for edge_index in [0u8, 2, 4] {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                if self.cells.get(neighbor).is_none() {
                    continue;
                }
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(hex, v1_idx),
                    self.vertex(neighbor, n1_idx),
                ) {
                    edges.push((a, b));
                    edges.push((c, d));
                }
            }
        }
        edges
    }

    /// Returns every gap quad as `[hex.v0, neighbor.n0, neighbor.n1, hex.v1]`
    /// in CCW order, paired with an `entangled` flag (true iff both adjacent
    /// cells are entangled). Same `[0,2,4]` even-edge ownership as
    /// [`quad_bridge_edges`].
    pub fn gap_quads(&self) -> Vec<GapQuad> {
        let mut quads = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for edge_index in [0u8, 2, 4] {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                let (Some(hex_cell), Some(nb_cell)) =
                    (self.cells.get(hex), self.cells.get(neighbor))
                else {
                    continue;
                };
                let entangled = hex_cell.entangled && nb_cell.entangled;
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(neighbor, n1_idx),
                    self.vertex(hex, v1_idx),
                ) {
                    quads.push(GapQuad {
                        corners: [a, b, c, d],
                        entangled,
                    });
                }
            }
        }
        quads
    }

    /// Returns the six center-fan triangles of every hex's flat top face,
    /// matching `entangled`. `entangled = false` yields non-entangled cells'
    /// faces; `true` yields entangled cells' faces. Hard-coded fan — no
    /// earcut needed for the flat-top case.
    pub fn hex_face_tris(&self, entangled: bool) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            let Some(cell) = self.cells.get(hex) else {
                continue;
            };
            if cell.entangled != entangled {
                continue;
            }
            let height = cell.height;
            let center2 = self.layout.hex_to_world_pos(hex);
            let center = Vec3::new(center2.x, height, center2.y);
            for i in 0..6u8 {
                let j = (i + 1) % 6;
                if let (Some(a), Some(b)) = (self.vertex(hex, i), self.vertex(hex, j)) {
                    tris.push([center, a, b]);
                }
            }
        }
        tris
    }

    /// For each hex matching `entangled` (same iteration / ordering as
    /// [`HGridLayout::hex_face_tris`]), returns the 6 face-edge bridge
    /// quads as a fixed-size array indexed by edge `0..6`:
    /// `Some([v0, n0, n1, v1])` if the neighbor on that edge exists in
    /// the grid, `None` for border edges.
    ///
    /// Quad-corner order matches [`HGridLayout::gap_quads`]:
    /// `corners[0]` / `corners[3]` lie on the source hex perimeter (the
    /// near edge of the bridge), `corners[1]` / `corners[2]` on the
    /// neighbor (the far edge). The two source-side corners are
    /// bit-exact the perimeter corners of the face-fan tri sharing that
    /// edge (both go through [`HGridLayout::vertex`]), so a band-shader
    /// overlay that paints both surfaces with `aWeight = 0` at the
    /// shared edge has no seam.
    ///
    /// Unlike [`gap_quads`], the even-edge ownership rule is **not**
    /// applied here — every face-edge of every matching hex is
    /// reported, so callers picking a random one of a hex's 6 tris can
    /// always recover its bridge geometry.
    pub fn hex_face_bridge_quads(&self, entangled: bool) -> Vec<[Option<[Vec3; 4]>; 6]> {
        let mut out = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            let Some(cell) = self.cells.get(hex) else {
                continue;
            };
            if cell.entangled != entangled {
                continue;
            }
            let mut bridges: [Option<[Vec3; 4]>; 6] = [None; 6];
            for edge_index in 0..6u8 {
                let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
                let neighbor = hex.neighbor(dir);
                if self.cells.get(neighbor).is_none() {
                    continue;
                }
                let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
                if let (Some(a), Some(b), Some(c), Some(d)) = (
                    self.vertex(hex, v0_idx),
                    self.vertex(neighbor, n0_idx),
                    self.vertex(neighbor, n1_idx),
                    self.vertex(hex, v1_idx),
                ) {
                    bridges[edge_index as usize] = Some([a, b, c, d]);
                }
            }
            out.push(bridges);
        }
        out
    }

    /// Returns the two triangles of every gap quad whose entanglement matches
    /// `entangled`, split along the rust-canonical `[v0, v2]` diagonal:
    /// `[a, b, c]` then `[a, c, d]`.
    pub fn gap_quad_tris(&self, entangled: bool) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for q in self.gap_quads() {
            if q.entangled != entangled {
                continue;
            }
            let [a, b, c, d] = q.corners;
            tris.push([a, b, c]);
            tris.push([a, c, d]);
        }
        tris
    }

    /// Unified triangle stream filtered by entanglement: gap quad tris and
    /// hex face fan tris matching `entangled`, plus 3-way junction tris when
    /// `entangled = false` (junction tris are never entangled per the project
    /// rule). All tessellation decisions owned here so clients consume one
    /// flat list with no per-source branching.
    ///
    /// The concatenation of [`HGridLayout::owned_tris_into`] over every cell
    /// in `shapes::hexagon` order. Gap quads are split along the canonical
    /// `[v0, v2]` diagonal (`[a,b,c]` then `[a,c,d]`), winding identical to
    /// `gap_quad_tris`.
    pub fn all_tris(&self, entangled: bool) -> Vec<[Vec3; 3]> {
        shapes::hexagon(self.center, self.grid_radius).fold(Vec::new(), |mut out, hex| {
            self.owned_tris_into(hex, entangled, &mut out);
            out
        })
    }

    /// Appends the triangles `hex` owns to `out` — the per-cell body of
    /// [`HGridLayout::all_tris`], with the same `entangled` filter.
    ///
    /// A cell owns its face fan (when `cell.entangled == entangled`), the gap
    /// quads on its even edges `[0, 2, 4]` whose neighbor is in-grid and whose
    /// entanglement (both cells entangled) matches, and — only when
    /// `entangled = false` — the junction tris at its corners `[0, 1]` where all
    /// three cells are in-grid (every lattice vertex is corner 0 or 1 of exactly one of its three hexes).
    ///
    /// @param hex — the owning cell; an off-grid hex appends nothing.
    /// @param entangled — which half of the stream to emit (see `all_tris`).
    /// @param out — triangles are appended here.
    /// @returns `(face_tris, quad_tris, junction_tris)` appended.
    pub fn owned_tris_into(
        &self,
        hex: Hex,
        entangled: bool,
        out: &mut Vec<[Vec3; 3]>,
    ) -> (usize, usize, usize) {
        let Some(&cell) = self.cells.get(hex) else {
            return (0, 0, 0);
        };
        let start = out.len();
        let center2 = self.layout.hex_to_world_pos(hex);
        let height = cell.height;
        let radius = cell.radius;
        let corners: [Vec3; 6] = std::array::from_fn(|i| {
            let off = self.unit_corners[i] * radius;
            Vec3::new(center2.x + off.x, height, center2.y + off.y)
        });

        if cell.entangled == entangled {
            let center = Vec3::new(center2.x, height, center2.y);
            for i in 0..6usize {
                let j = (i + 1) % 6;
                out.push([center, corners[i], corners[j]]);
            }
        }
        let after_faces = out.len();

        for edge_index in [0u8, 2, 4] {
            let dir = EdgeDirection::ALL_DIRECTIONS[edge_index as usize];
            let neighbor = hex.neighbor(dir);
            let Some(&nb_cell) = self.cells.get(neighbor) else {
                continue;
            };
            if (cell.entangled && nb_cell.entangled) != entangled {
                continue;
            }
            let (v0_idx, v1_idx, n0_idx, n1_idx) = math::quad_corner_indices(edge_index);
            let nb_center2 = self.layout.hex_to_world_pos(neighbor);
            let nb_height = nb_cell.height;
            let nb_radius = nb_cell.radius;
            let nb_corner = |i: u8| {
                let off = self.unit_corners[i as usize] * nb_radius;
                Vec3::new(nb_center2.x + off.x, nb_height, nb_center2.y + off.y)
            };
            let a = corners[v0_idx as usize];
            let b = nb_corner(n0_idx);
            let c = nb_corner(n1_idx);
            let d = corners[v1_idx as usize];
            out.push([a, b, c]);
            out.push([a, c, d]);
        }
        let after_quads = out.len();

        if !entangled {
            for v_idx in [0u8, 1] {
                let dir = VertexDirection::ALL_DIRECTIONS[v_idx as usize];
                let gv = GridVertex {
                    origin: hex,
                    direction: dir,
                };
                let coords = gv.coordinates();
                if coords[0] != hex {
                    continue;
                }
                if !coords.iter().all(|c| self.cells.get(*c).is_some()) {
                    continue;
                }
                if let (Some(i1), Some(i2)) = (
                    corner_index_for_vertex(coords[1], &gv),
                    corner_index_for_vertex(coords[2], &gv),
                ) && let (Some(v1), Some(v2)) =
                    (self.vertex(coords[1], i1), self.vertex(coords[2], i2))
                {
                    let v0 = corners[v_idx as usize];
                    out.push([v0, v1, v2]);
                }
            }
        }

        (
            after_faces - start,
            after_quads - after_faces,
            out.len() - after_quads,
        )
    }

    /// Returns the three world-space corners of every 3-hex junction gap tri.
    /// Ownership: each tri is emitted by the hex whose corner 0 or 1 it sits on;
    /// every lattice vertex is corner 0 or 1 of exactly one of its three hexes.
    pub fn gap_tris(&self) -> Vec<[Vec3; 3]> {
        let mut tris = Vec::new();
        for hex in shapes::hexagon(self.center, self.grid_radius) {
            for v_idx in [0u8, 1] {
                let dir = VertexDirection::ALL_DIRECTIONS[v_idx as usize];
                let gv = GridVertex {
                    origin: hex,
                    direction: dir,
                };
                let coords = gv.coordinates();
                if coords[0] != hex {
                    continue;
                }
                if !coords.iter().all(|c| self.cells.get(*c).is_some()) {
                    continue;
                }
                let idx1 = corner_index_for_vertex(coords[1], &gv);
                let idx2 = corner_index_for_vertex(coords[2], &gv);
                if let (Some(i1), Some(i2)) = (idx1, idx2)
                    && let (Some(v0), Some(v1), Some(v2)) = (
                        self.vertex(coords[0], v_idx),
                        self.vertex(coords[1], i1),
                        self.vertex(coords[2], i2),
                    )
                {
                    tris.push([v0, v1, v2]);
                }
            }
        }
        tris
    }

    /// Centre hex of the grid — `Hex::ZERO` for [`HGridLayout::new`], the chunk
    /// centre for [`HGridLayout::for_chunk`].
    pub fn center(&self) -> Hex {
        self.center
    }

    /// Grid radius (number of hex rings around the centre).
    pub fn grid_radius(&self) -> u32 {
        self.grid_radius
    }

    /// Nominal hex radius (center-to-corner of a 100% cell), reading the layout's `scale.x`.
    pub fn nominal_hex_radius(&self) -> f32 {
        self.layout.scale.x
    }

    /// Inverse-distance-weighted height interpolation from nearby hex vertices.
    pub fn interpolate_height(&self, pos: Vec2) -> f32 {
        let hex = self.layout.world_pos_to_hex(pos);
        let vertices: Vec<Vec3> = std::iter::once(hex)
            .chain(hex.all_neighbors())
            .flat_map(|h| (0..6u8).filter_map(move |i| self.vertex(h, i)))
            .collect();
        math::idw_interpolate_height(pos, &vertices)
            .unwrap_or_else(|| self.cells.get(hex).map(|c| c.height).unwrap_or(0.0))
    }
}

fn corner_index_for_vertex(hex: Hex, target: &GridVertex) -> Option<u8> {
    VertexDirection::ALL_DIRECTIONS.iter().find_map(|&dir| {
        let candidate = GridVertex {
            origin: hex,
            direction: dir,
        };
        candidate.equivalent(target).then_some(dir.index())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_RADIUS: u32 = 4;
    const ALL_TRIS_GOLDEN: u64 = 2_807_960_220_995_250_556;
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0100_0000_01b3;

    fn default_settings() -> HGridSettings {
        HGridSettings::default()
    }

    /// 64-bit FNV-1a over the `f32` bit patterns of every vertex coordinate.
    fn fnv1a_tris(tris: &[[Vec3; 3]]) -> u64 {
        tris.iter()
            .flat_map(|t| t.iter().flat_map(|v| [v.x, v.y, v.z]))
            .fold(FNV_OFFSET, |h, f| {
                (h ^ u64::from(f.to_bits())).wrapping_mul(FNV_PRIME)
            })
    }

    #[test]
    fn all_tris_golden_checksum() {
        // Pins all_tris byte-for-byte. Update the constant only on an intentional geometry change.
        let g = HGridSettings {
            radius: GOLDEN_RADIUS,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[Hex::ZERO, Hex::new(1, 0), Hex::new(2, 0)]);
        let tris: Vec<_> = layout
            .all_tris(false)
            .into_iter()
            .chain(layout.all_tris(true))
            .collect();
        assert_eq!(fnv1a_tris(&tris), ALL_TRIS_GOLDEN);
    }

    const CHUNK_GOLDEN_COORD: (i32, i32) = (1, -2);
    const CHUNK_GOLDEN_RADIUS: u32 = 3;
    const CHUNK_TRIS_GOLDEN: u64 = 14_654_224_851_271_909_658;

    #[test]
    fn chunk_tris_golden_checksum() {
        // Pins one chunk byte-for-byte (docs/design/cell-state.md, D11): each own cell's
        // 14 tris in `shapes::hexagon` order, then the entangled seam tris (per ring cell,
        // quads then junctions) in `ring(r + 1)` order. It outlives `all_tris_golden_checksum`
        // through the API change; update the constant only on an intentional geometry change.
        let (r, (q, s)) = (CHUNK_GOLDEN_RADIUS, CHUNK_GOLDEN_COORD);
        let layout = HGridLayout::for_chunk(&default_settings(), Hex::new(q, s), r);
        let center = layout.center();
        let mut tris = Vec::new();
        for h in shapes::hexagon(center, r) {
            let counts = layout.owned_tris_into(h, false, &mut tris);
            assert_eq!(counts, (6, 6, 2), "own cell {h:?}");
        }
        for h in center.ring(r + 1) {
            let (faces, ..) = layout.owned_tris_into(h, false, &mut tris);
            assert_eq!(faces, 0, "entangled cell {h:?} emits no face");
        }
        assert_eq!(
            tris.len(),
            layout.all_tris(false).len(),
            "own + seam tris cover the chunk"
        );
        assert_eq!(fnv1a_tris(&tris), CHUNK_TRIS_GOLDEN);
    }

    const CHUNK_COORDS: [(i32, i32); 5] = [(0, 0), (1, 0), (0, -1), (-3, 2), (4, -7)];
    const CHUNK_TRI_COUNTS: [(u32, usize); 3] = [(1, 126), (2, 312), (3, 582)];

    #[test]
    fn chunk_cells_map_back_to_coord() {
        for r in 0..=3u32 {
            for (q, s) in CHUNK_COORDS {
                let coord = Hex::new(q, s);
                let layout = HGridLayout::for_chunk(&default_settings(), coord, r);
                let center = layout.center();
                assert_eq!(center, coord.to_higher_res(r), "r {r}, {coord:?}");
                assert_eq!(layout.grid_radius(), r + 1);
                for h in shapes::hexagon(center, r) {
                    assert_eq!(h.to_lower_res(r), coord, "r {r}: {h:?} outside {coord:?}");
                    assert!(!layout.cell(&h).unwrap().entangled, "r {r}: {h:?} entangled");
                }
                for h in center.ring(r + 1) {
                    assert!(layout.cell(&h).unwrap().entangled, "r {r}: ring {h:?} not entangled");
                    assert_ne!(h.to_lower_res(r), coord, "r {r}: ring {h:?} inside {coord:?}");
                }
            }
        }
    }

    #[test]
    fn for_chunk_all_tris_counts() {
        for coord in [Hex::ZERO, Hex::new(-3, 2)] {
            for (r, n) in CHUNK_TRI_COUNTS {
                let layout = HGridLayout::for_chunk(&default_settings(), coord, r);
                assert_eq!(layout.all_tris(false).len(), n, "r {r}, {coord:?}");
            }
        }
    }

    #[test]
    fn for_chunk_ignores_settings_radius() {
        let at = |radius| {
            let g = HGridSettings {
                radius,
                ..default_settings()
            };
            HGridLayout::for_chunk(&g, Hex::new(1, 0), 2).all_tris(false)
        };
        assert_eq!(fnv1a_tris(&at(0)), fnv1a_tris(&at(20)));
    }

    #[test]
    fn all_tris_is_concat_of_owned_tris_into() {
        let g = HGridSettings {
            radius: 2,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[Hex::ZERO, Hex::new(1, 0)]);
        for entangled in [false, true] {
            let concat = shapes::hexagon(Hex::ZERO, 2).fold(Vec::new(), |mut out, hex| {
                layout.owned_tris_into(hex, entangled, &mut out);
                out
            });
            assert_eq!(concat, layout.all_tris(entangled), "entangled = {entangled}");
        }
    }

    #[test]
    fn owned_tris_into_counts_match_appended() {
        let g = HGridSettings {
            radius: 2,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[]);
        let mut out = Vec::new();
        for hex in shapes::hexagon(Hex::ZERO, 2) {
            let before = out.len();
            let (f, q, j) = layout.owned_tris_into(hex, false, &mut out);
            assert_eq!(out.len() - before, f + q + j, "{hex:?}");
            assert!(f == 0 || f == 6, "{hex:?}: face tris {f}");
            assert!(q % 2 == 0 && q <= 6, "{hex:?}: quad tris {q}");
            assert!(j <= 2, "{hex:?}: junction tris {j}");
        }
        let before = out.len();
        assert_eq!(layout.owned_tris_into(Hex::new(999, 999), false, &mut out), (0, 0, 0));
        assert_eq!(out.len(), before);
    }

    #[test]
    fn new_populates_all_hexes() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        let expected = shapes::hexagon(Hex::ZERO, g.radius).count();
        assert_eq!(layout.cells.len(), expected);
    }

    #[test]
    fn new_default_cells_are_not_entangled() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        assert!(!layout.cell(&Hex::ZERO).unwrap().entangled);
    }

    #[test]
    fn hex_to_world_and_back_roundtrip() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        for hex in shapes::hexagon(Hex::ZERO, 3) {
            let world = layout.hex_to_world_pos(hex);
            let back = layout.world_pos_to_hex(world);
            assert_eq!(hex, back, "roundtrip failed for {hex:?}");
        }
    }

    #[test]
    fn vertex_returns_six_positions_per_hex() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        for i in 0..6u8 {
            assert!(
                layout.vertex(Hex::ZERO, i).is_some(),
                "vertex {i} should exist"
            );
        }
    }

    #[test]
    fn interpolate_at_center_uniform_height() {
        let g = HGridSettings {
            radius: 1,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[]);
        let h = layout.interpolate_height(Vec2::ZERO);
        let center_h = layout.cell(&Hex::ZERO).unwrap().height;
        assert!(
            (h - center_h).abs() < 2.0,
            "interpolated height {h} should be near center height {center_h}"
        );
    }

    #[test]
    fn unit_corner_returns_six_distinct_offsets() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        let corners: Vec<Vec2> = (0..6).map(|i| layout.unit_corner(i)).collect();
        for i in 0..6 {
            for j in (i + 1)..6 {
                assert_ne!(corners[i], corners[j], "corners {i} and {j} are identical");
            }
        }
    }

    #[test]
    fn hex_face_tris_count_is_six_per_hex() {
        for r in [0u32, 1, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let hex_count = shapes::hexagon(Hex::ZERO, r).count();
            let tris = layout.hex_face_tris(false);
            assert_eq!(
                tris.len(),
                hex_count * 6,
                "radius {r}: expected {} fan tris, got {}",
                hex_count * 6,
                tris.len()
            );
            assert!(
                layout.hex_face_tris(true).is_empty(),
                "radius {r}: no entangled cells, expected zero entangled face tris"
            );
        }
    }

    #[test]
    fn hex_face_tris_share_height_per_hex() {
        let g = HGridSettings {
            radius: 1,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[]);
        let tris = layout.hex_face_tris(false);
        for (i, tri) in tris.iter().enumerate() {
            let y0 = tri[0].y;
            let y1 = tri[1].y;
            let y2 = tri[2].y;
            assert!(
                (y0 - y1).abs() < 1e-4 && (y0 - y2).abs() < 1e-4,
                "tri {i}: heights differ ({y0}, {y1}, {y2}) — face should be flat"
            );
        }
    }

    #[test]
    fn hex_face_bridge_quads_per_hex_shape() {
        // Radius-1 grid: 1 center + 6 borders. Center sees 6 in-grid
        // neighbors → 6 bridges; each border sees 3.
        let g = HGridSettings {
            radius: 1,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[]);
        let bridges = layout.hex_face_bridge_quads(false);
        assert_eq!(bridges.len(), 7);
        let counts: Vec<usize> = bridges
            .iter()
            .map(|b| b.iter().filter(|q| q.is_some()).count())
            .collect();
        let six = counts.iter().filter(|&&c| c == 6).count();
        let three = counts.iter().filter(|&&c| c == 3).count();
        assert_eq!(six, 1, "exactly one hex (center) should have 6 bridges; got {counts:?}");
        assert_eq!(three, 6, "six border hexes should have 3 bridges; got {counts:?}");
        assert!(
            layout.hex_face_bridge_quads(true).is_empty(),
            "no entangled cells → entangled query empty"
        );
    }

    #[test]
    fn hex_face_bridge_quads_emit_each_gap_twice() {
        // Every gap quad is shared by two hexes, and each hex reports both
        // its `[0, 2, 4]` and `[1, 3, 5]` edges, so the total Some-count
        // is exactly 2× the canonical `gap_quads().len()`.
        for r in [1u32, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let bridges = layout.hex_face_bridge_quads(false);
            let some_count: usize = bridges
                .iter()
                .map(|b| b.iter().filter(|q| q.is_some()).count())
                .sum();
            assert_eq!(some_count, layout.gap_quads().len() * 2);
        }
    }

    #[test]
    fn hex_face_bridge_quads_share_corners_with_face_tris() {
        // The two source-side corners of each Some bridge must match the
        // perimeter corners of the face-fan tri that owns the same edge.
        // `shapes::hexagon` shares its order between hex_face_tris and
        // hex_face_bridge_quads, so the i-th hex's 6 tris live at
        // face_tris[i*6 .. (i+1)*6] alongside bridges[i].
        let g = HGridSettings {
            radius: 1,
            ..default_settings()
        };
        let layout = HGridLayout::new(&g, &[], &[]);
        let face_tris = layout.hex_face_tris(false);
        let bridges = layout.hex_face_bridge_quads(false);
        let center_idx = bridges
            .iter()
            .position(|b| b.iter().all(|q| q.is_some()))
            .expect("one hex must have all 6 in-grid neighbors at radius=1");
        let base = center_idx * 6;
        for edge_index in 0..6usize {
            let tri = face_tris[base + edge_index];
            let q = bridges[center_idx][edge_index].expect("center has all 6 bridges");
            // Face-fan tri vertices: [center, perimeter_i, perimeter_(i+1)].
            // Bridge quad: [v0 = perimeter_i, n0, n1, v1 = perimeter_(i+1)].
            assert_eq!(tri[1], q[0], "edge {edge_index}: tri.v1 vs bridge.v0");
            assert_eq!(tri[2], q[3], "edge {edge_index}: tri.v2 vs bridge.v1");
        }
    }

    #[test]
    fn all_tris_count_matches_components() {
        for r in [1u32, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let quad_tris = layout.gap_quad_tris(false).len();
            let gap_tris = layout.gap_tris().len();
            let face_tris = layout.hex_face_tris(false).len();
            let total = layout.all_tris(false).len();
            assert_eq!(
                total,
                quad_tris + gap_tris + face_tris,
                "radius {r}: all_tris(false) should equal gap_quad_tris(false) + gap_tris + hex_face_tris(false)"
            );
            assert_eq!(
                layout.all_tris(true).len(),
                0,
                "radius {r}: no entangled cells, all_tris(true) should be empty"
            );
        }
    }

    #[test]
    fn all_tris_false_equals_components_as_multiset() {
        for r in [1u32, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let mut combined: Vec<[Vec3; 3]> = layout.gap_quad_tris(false);
            combined.extend(layout.gap_tris());
            combined.extend(layout.hex_face_tris(false));
            let single = layout.all_tris(false);

            let key = |t: &[Vec3; 3]| {
                let mut bits: [[u32; 3]; 3] = std::array::from_fn(|i| {
                    [t[i].x.to_bits(), t[i].y.to_bits(), t[i].z.to_bits()]
                });
                bits.sort();
                bits
            };
            let mut a: Vec<_> = combined.iter().map(key).collect();
            let mut b: Vec<_> = single.iter().map(key).collect();
            a.sort();
            b.sort();
            assert_eq!(
                a, b,
                "radius {r}: all_tris(false) multiset diverges from components"
            );
        }
    }

    #[test]
    fn overrides_replace_noise_values() {
        let g = HGridSettings {
            radius: 2,
            ..default_settings()
        };
        let baseline = HGridLayout::new(&g, &[], &[]);

        let pinned_height = 12.5_f32;
        let pinned_radius = 1.75_f32;
        let off_grid = Hex::new(999, 999);
        let neighbor = Hex::new(1, 0);
        let overrides = [
            (NoiseType::Height, Hex::ZERO, pinned_height),
            (NoiseType::Size, Hex::ZERO, pinned_radius),
            (NoiseType::Height, off_grid, 999.0),
        ];
        let pinned = HGridLayout::new(&g, &overrides, &[]);

        let pinned_zero = pinned.cell(&Hex::ZERO).unwrap();
        assert_eq!(pinned_zero.height, pinned_height);
        assert_eq!(pinned_zero.radius, pinned_radius);

        assert_eq!(pinned.cell(&neighbor), baseline.cell(&neighbor));

        assert_eq!(pinned.cell(&off_grid), None);
    }

    #[test]
    fn entangle_borderline_marks_outer_ring_side() {
        for r in [1u32, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            for dir in VertexDirection::ALL_DIRECTIONS {
                let mut layout = HGridLayout::new(&g, &[], &[]);
                layout.entangle_borderline(dir);
                let side: Vec<Hex> = Hex::ZERO.ring_edge(r, dir).collect();
                for hex in &side {
                    assert!(
                        layout.cell(hex).unwrap().entangled,
                        "radius {r}, dir {dir:?}: {hex:?} should be entangled"
                    );
                }
                let entangled_count = shapes::hexagon(Hex::ZERO, r)
                    .filter(|h| layout.cell(h).unwrap().entangled)
                    .count();
                assert_eq!(
                    entangled_count,
                    side.len(),
                    "radius {r}, dir {dir:?}: only the {} border cells should be entangled",
                    side.len()
                );
            }
        }
    }

    #[test]
    fn entangle_marks_cells_and_propagates_to_quads() {
        let g = HGridSettings {
            radius: 2,
            ..default_settings()
        };
        let a = Hex::ZERO;
        let b = Hex::new(1, 0);
        let c = Hex::new(2, 0);
        let off_grid = Hex::new(999, 999);
        let layout = HGridLayout::new(&g, &[], &[a, b, off_grid]);

        assert!(layout.cell(&a).unwrap().entangled);
        assert!(layout.cell(&b).unwrap().entangled);
        assert!(!layout.cell(&c).unwrap().entangled);

        let quads = layout.gap_quads();
        let bridges_ab: Vec<_> = quads.iter().filter(|q| q.entangled).collect();
        assert!(
            !bridges_ab.is_empty(),
            "quad bridging two entangled cells should exist and be entangled"
        );
        let touching_c: Vec<_> = quads
            .iter()
            .filter(|q| {
                !q.entangled
            })
            .collect();
        assert!(
            !touching_c.is_empty(),
            "quads with at least one non-entangled neighbor must remain non-entangled"
        );

        // Junction tris are never entangled — `all_tris(true)` must skip them.
        let junction_count = layout.gap_tris().len();
        let any_e = layout.all_tris(true);
        let junction_in_entangled = any_e
            .iter()
            .filter(|t| layout.gap_tris().iter().any(|j| j == *t))
            .count();
        assert_eq!(
            junction_in_entangled, 0,
            "all_tris(true) must not include any of the {junction_count} junction tris"
        );
    }

    #[test]
    fn cell_returns_in_grid_data() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        for hex in [Hex::ZERO, Hex::new(1, 0)] {
            let cell = layout.cell(&hex).expect("in-grid hex");
            assert_eq!(cell.hex, hex);
        }
    }

    #[test]
    fn cell_returns_none_off_grid() {
        let g = default_settings();
        let layout = HGridLayout::new(&g, &[], &[]);
        assert_eq!(layout.cell(&Hex::new(999, 999)), None);
    }

    #[test]
    fn borderline_cells_walk_outer_ring() {
        for r in [1u32, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            for dir in VertexDirection::ALL_DIRECTIONS {
                let side: Vec<&HexCell> = layout.borderline_cells(dir).collect();
                assert_eq!(
                    side.len() as u32,
                    r + 1,
                    "radius {r}, dir {dir:?}: expected {} cells",
                    r + 1
                );
                for cell in &side {
                    assert_eq!(
                        cell.hex.length(),
                        r as i32,
                        "radius {r}, dir {dir:?}: cell {:?} not on outer ring",
                        cell.hex
                    );
                }
            }
        }
    }

    #[test]
    fn quad_bridge_edges_count_matches_gap_filler() {
        for r in [1, 2, 4] {
            let g = HGridSettings {
                radius: r,
                ..default_settings()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let grid: Vec<Hex> = shapes::hexagon(Hex::ZERO, r).collect();
            let (expected_quads, _) = crate::math::gap_filler(&grid);
            let edges = layout.quad_bridge_edges();
            assert_eq!(
                edges.len(),
                expected_quads * 2,
                "radius {r}: expected {} bridge edges ({}×2), got {}",
                expected_quads * 2,
                expected_quads,
                edges.len()
            );
        }
    }

    #[test]
    fn nominal_hex_radius_field_and_accessor_exist() {
        let s = HGridSettings {
            nominal_hex_radius: 4.0,
            ..HGridSettings::default()
        };
        let layout = HGridLayout::new(&s, &[], &[]);
        assert_eq!(layout.nominal_hex_radius(), 4.0);
    }

    #[test]
    fn per_cell_radii_respect_ratio_bounds() {
        let s = HGridSettings {
            nominal_hex_radius: 4.0,
            min_radius_ratio: 0.05,
            max_radius_ratio: 0.65,
            radius: 5,
            ..HGridSettings::default()
        };
        let layout = HGridLayout::new(&s, &[], &[]);

        let lo = s.nominal_hex_radius * s.min_radius_ratio;
        let hi = s.nominal_hex_radius * s.max_radius_ratio;
        let eps = 1e-4;

        let (min_r, max_r) = hexx::shapes::hexagon(Hex::ZERO, s.radius)
            .map(|h| layout.cell(&h).unwrap().radius)
            .fold(
                (f32::INFINITY, f32::NEG_INFINITY),
                |(min, max), r| (min.min(r), max.max(r)),
            );

        assert!(min_r >= lo - eps, "min radius {min_r} below floor {lo}");
        assert!(max_r <= hi + eps, "max radius {max_r} above ceiling {hi}");
    }
}

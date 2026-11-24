//! Streaming chunks: build any chunk of an unbounded world on demand from its
//! coordinate.
//!
//! A chunk is the radius-`chunk_radius` hexagon of cells with
//! `hex.to_lower_res(chunk_radius) == coord`. It is built by
//! [`HGridLayout::for_chunk`] with one extra entangled ring of neighbour cells,
//! then cut into two streams:
//!
//! - **owned** — what the chunk's own cells own. Across all chunks the owned
//!   streams cover the world with no overlap and no holes.
//! - **seams** — the gaps that ring cells own and that touch the chunk,
//!   grouped by owning neighbour chunk (≤ 6 groups). Each is a copy of
//!   triangles in that neighbour's owned stream.
//!
//! Rules for consumers:
//! 1. Always draw the owned stream. Draw seam group *k* only while neighbour
//!    chunk *k* isn't loaded, so the two copies are never visible together.
//! 2. Entangled cells are never state. A change to a cell goes to its owning
//!    chunk only.
//! 3. A changed cell rebuilds its own chunk and every chunk that has it in its
//!    entangled ring: 1 chunk for an interior cell, 2 along a chunk edge, 3 at
//!    a chunk corner.

use glam::{Vec2, Vec3};
use hexx::{Hex, shapes};

use crate::layout::{HGridLayout, HGridSettings, HexCell};

/// Deterministic per-coordinate chunk generator.
pub trait ChunkSource {
    /// Rings of cells per chunk; the same for every chunk this source yields.
    fn chunk_radius(&self) -> u32;
    /// Owned + seam geometry of chunk `coord`. Same seeds and coord give the same output.
    ///
    /// @param coord — the chunk's coordinate on the chunk lattice.
    /// @returns the chunk's cells, owned stream and seam groups.
    fn chunk(&self, coord: Hex) -> Chunk;
}

/// One chunk's state and geometry. Ring cells are dropped after building.
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub coord: Hex,
    /// World `(x, z)` of the centre cell `coord.to_higher_res(chunk_radius)`.
    pub center: Vec2,
    /// Own cells, in `shapes::hexagon(center, chunk_radius)` order.
    pub cells: Vec<HexCell>,
    /// Owned stream: `owned_tris_into(cell, false)` of every own cell, concatenated.
    pub owned: Vec<[Vec3; 3]>,
    /// Triangle count of each cell's run in `owned`; parallel to `cells`.
    pub owned_runs: Vec<usize>,
    /// Seam stream: `(owning neighbour chunk coord, tris)` in first-seen order
    /// walking `center.ring(chunk_radius + 1)`; empty groups omitted.
    pub seams: Vec<(Hex, Vec<[Vec3; 3]>)>,
}

/// [`ChunkSource`] that samples noise per request via [`HGridLayout::for_chunk`].
/// One `settings` (and so one set of seeds) per world.
#[derive(Clone, Debug)]
pub struct NoiseWorld {
    /// Seeds and noise parameters; `settings.radius` is ignored.
    pub settings: HGridSettings,
    pub chunk_radius: u32,
}

impl ChunkSource for NoiseWorld {
    fn chunk_radius(&self) -> u32 {
        self.chunk_radius
    }

    fn chunk(&self, coord: Hex) -> Chunk {
        let r = self.chunk_radius;
        let layout = HGridLayout::for_chunk(&self.settings, coord, r);
        let center = layout.center();

        let (cells, owned, owned_runs) = shapes::hexagon(center, r).fold(
            (Vec::new(), Vec::new(), Vec::new()),
            |(mut cells, mut owned, mut runs), h| {
                cells.push(layout.cell(&h).expect("own cell is in the chunk layout"));
                let (f, q, j) = layout.owned_tris_into(h, false, &mut owned);
                runs.push(f + q + j);
                (cells, owned, runs)
            },
        );

        let seams = center.ring(r + 1).fold(
            Vec::<(Hex, Vec<[Vec3; 3]>)>::new(),
            |mut groups, h| {
                let mut tris = Vec::new();
                layout.owned_tris_into(h, false, &mut tris);
                if tris.is_empty() {
                    return groups;
                }
                let owner = h.to_lower_res(r);
                match groups.iter_mut().find(|(o, _)| *o == owner) {
                    Some((_, group)) => group.extend(tris),
                    None => groups.push((owner, tris)),
                }
                groups
            },
        );

        Chunk {
            coord,
            center: layout.hex_to_world_pos(center),
            cells,
            owned,
            owned_runs,
            seams,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use glam::Vec3;
    use hexx::{Hex, shapes};

    use super::*;
    use crate::layout::{HGridLayout, HGridSettings};

    const WORLD_RADIUS: u32 = 9;
    const CHUNK_RADII: [u32; 3] = [0, 1, 2];
    const SEAM_COORDS: [(i32, i32); 3] = [(0, 0), (1, 0), (-3, 2)];
    const MIN_FITTING_CHUNKS: usize = 7;
    const MAX_SEAM_GROUPS: usize = 6;
    // The chunk drawn in the geometry guide (docs/guide/gen.py asserts the same numbers).
    const GUIDE_OWNED: usize = 266;
    const GUIDE_SEAMS: [((i32, i32), usize); 6] = [
        ((0, 1), 6),
        ((-1, 1), 7),
        ((-1, 0), 12),
        ((0, -1), 9),
        ((1, -1), 8),
        ((1, 0), 4),
    ];

    fn world(chunk_radius: u32) -> NoiseWorld {
        NoiseWorld {
            settings: HGridSettings::default(),
            chunk_radius,
        }
    }

    fn tri_bits(t: &[Vec3; 3]) -> [u32; 9] {
        let [a, b, c] = t;
        [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].map(f32::to_bits)
    }

    #[test]
    fn owned_streams_partition_world() {
        for r in CHUNK_RADII {
            let g = HGridSettings {
                radius: WORLD_RADIUS,
                ..HGridSettings::default()
            };
            let layout = HGridLayout::new(&g, &[], &[]);
            let fitting: HashSet<Hex> = shapes::hexagon(Hex::ZERO, WORLD_RADIUS)
                .map(|h| h.to_lower_res(r))
                // The entangled ring (distance r + 1 from the centre) must fit inside the world.
                .filter(|c| c.to_higher_res(r).length() as u32 + r < WORLD_RADIUS)
                .collect();
            assert!(fitting.len() >= MIN_FITTING_CHUNKS, "r {r}: {} chunks", fitting.len());

            let src = world(r);
            let mut got: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|&c| src.chunk(c).owned)
                .map(|t| tri_bits(&t))
                .collect();
            let mut want: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|c| shapes::hexagon(c.to_higher_res(r), r))
                .fold(Vec::new(), |mut out, h| {
                    layout.owned_tris_into(h, false, &mut out);
                    out
                })
                .iter()
                .map(tri_bits)
                .collect();
            got.sort_unstable();
            want.sort_unstable();
            assert_eq!(got, want, "r {r}");
        }
    }

    #[test]
    fn seams_match_owner_owned() {
        for r in CHUNK_RADII {
            let src = world(r);
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let c = src.chunk(coord);
                assert!((1..=MAX_SEAM_GROUPS).contains(&c.seams.len()), "r {r}: {}", c.seams.len());
                for (owner, tris) in &c.seams {
                    assert_ne!(*owner, coord);
                    assert!(!tris.is_empty(), "r {r}: empty group {owner:?}");
                    let owned: HashSet<[u32; 9]> =
                        src.chunk(*owner).owned.iter().map(tri_bits).collect();
                    assert!(
                        tris.iter().all(|t| owned.contains(&tri_bits(t))),
                        "r {r}: seam of {coord:?} not in owner {owner:?}"
                    );
                }
                let seam_total: usize = c.seams.iter().map(|(_, t)| t.len()).sum();
                let layout = HGridLayout::for_chunk(&src.settings, coord, r);
                assert_eq!(c.owned.len() + seam_total, layout.all_tris(false).len(), "r {r}");
            }
        }
    }

    #[test]
    fn chunk_runs_and_cells_line_up() {
        for r in CHUNK_RADII {
            let c = world(r).chunk(Hex::new(-3, 2));
            let n = shapes::hexagon(c.coord.to_higher_res(r), r).count();
            assert_eq!(c.cells.len(), n);
            assert_eq!(c.owned_runs.len(), n);
            assert_eq!(c.owned_runs.iter().sum::<usize>(), c.owned.len());
            assert!(c.cells.iter().all(|cell| !cell.entangled));
        }
    }

    #[test]
    fn chunk_center_matches_layout() {
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let src = world(r);
                let layout = HGridLayout::for_chunk(&src.settings, coord, r);
                let want = layout.hex_to_world_pos(coord.to_higher_res(r));
                assert_eq!(src.chunk(coord).center, want, "r {r}, {coord:?}");
            }
        }
    }

    #[test]
    fn chunk_zero_radius_2_counts() {
        let c = world(2).chunk(Hex::ZERO);
        assert_eq!(c.owned.len(), GUIDE_OWNED);
        let seams: Vec<((i32, i32), usize)> = c
            .seams
            .iter()
            .map(|(o, tris)| ((o.x, o.y), tris.len()))
            .collect();
        assert_eq!(seams, GUIDE_SEAMS);
    }

    #[test]
    fn chunk_is_deterministic() {
        let coord = Hex::new(-3, 2);
        assert_eq!(world(2).chunk(coord), world(2).chunk(coord));
        assert_eq!(world(2).chunk_radius(), 2);
    }
}

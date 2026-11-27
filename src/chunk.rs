//! Streaming chunks: the keys and draw rule for an unbounded world's seams.
//!
//! A chunk is the radius-`chunk_radius` hexagon of cells with
//! `hex.to_lower_res(chunk_radius) == coord`. [`HGridLayout::for_chunk`]
//! builds it from noise plus stored edits, with one extra entangled ring of
//! neighbour cells, and these layout functions cut it into two streams
//! (decisions D4, D10, D15 in `docs/design/cell-state.md`):
//!
//! - **own** — [`HGridLayout::own_tris`]: 14 tris per own cell (its
//!   `tri_sequence`), in [`HGridLayout::own_cells`] order, with the cells'
//!   state in [`HGridLayout::own_cell_states`]. Across all chunks the own
//!   streams cover the world with no overlap and no holes.
//! - **entangled seams** — [`HGridLayout::entangled_seam_tris`]: the gaps that
//!   ring cells own and that touch the chunk, per ring cell quads then
//!   junctions ([`HGridLayout::entangled_seam_counts`]). Each is a copy of a tri
//!   in the owning neighbour's own stream. [`entangled_seam_keys`] keys each
//!   one [`EntangledSeam`] `(owner, also)` from hex coordinates alone; `also`
//!   names the third chunk a corner junction tri touches, which carries the
//!   same copy.
//!
//! Rules for consumers:
//! 1. Always draw the own stream. Draw an entangled seam tri only while
//!    [`EntangledSeam::drawn`]: its owner isn't loaded, and if it has an `also`
//!    chunk, that one isn't loaded either or sorts after the carrier in
//!    `(q, r)` order. Every triangle touching a loaded chunk is then drawn
//!    exactly once.
//! 2. Entangled cells are never state. A change to a cell is stored under its
//!    owning chunk only, and passed as an override to every layout that holds it.
//! 3. A changed cell rebuilds its own chunk and every chunk that has it in its
//!    entangled ring: 1 chunk for an interior cell, 2 along a chunk edge, 3 at
//!    a chunk corner.

use hexx::Hex;

#[cfg(doc)]
use crate::layout::HGridLayout;
use crate::layout::{ChunkError, chunk_center_hex, owned_gaps};

/// The key of an entangled seam tri: which chunk owns it, and which third
/// chunk (if any) it also touches. A seam tri with no `also` touches only its
/// owner and the carrying chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EntangledSeam {
    /// Chunk whose owned stream holds the tri.
    pub owner: Hex,
    /// Third chunk a corner junction tri touches; it carries the same copy.
    pub also: Option<Hex>,
}

impl EntangledSeam {
    /// Consumer rule 1: whether chunk `carrier` should draw a seam tri with
    /// this key now. The `(q, r)` tie-break lets exactly one of two loaded
    /// carriers draw a corner. `testdata/entangled_seam_drawn.tsv` holds the
    /// cases every port of this rule is tested against.
    ///
    /// @param carrier {Hex} — the chunk whose entangled seam tris hold this one.
    /// @param loaded {impl Fn(Hex) -> bool} — whether a chunk coordinate is loaded.
    /// @returns {bool} true when no loaded chunk already draws the tri.
    pub fn drawn(&self, carrier: Hex, loaded: impl Fn(Hex) -> bool) -> bool {
        !loaded(self.owner)
            && self
                .also
                .is_none_or(|b| !loaded(b) || (carrier.x, carrier.y) < (b.x, b.y))
    }
}

/// The key of each of chunk `coord`'s entangled seam tris, parallel to
/// [`HGridLayout::entangled_seam_tris`] of that chunk, from hex coordinates
/// alone. Which tris exist depends only on the chunk's shape, not on heights
/// or edits, so no layout is built.
///
/// Rejects the same chunks as [`HGridLayout::for_chunk`], with the same error.
///
/// @param coord — the carrying chunk's coordinate on the chunk lattice.
/// @param chunk_radius — rings of cells per chunk.
/// @returns one key per tri: per entangled cell, in `ring(chunk_radius + 1)`
///   order, its quad tris then its junction tris.
pub fn entangled_seam_keys(
    coord: Hex,
    chunk_radius: u32,
) -> Result<Vec<EntangledSeam>, ChunkError> {
    let r = chunk_radius;
    let center = chunk_center_hex(coord, r)?;
    let exists = |h: Hex| center.unsigned_distance_to(h) <= r + 1;
    let entangled = |h: Hex| center.unsigned_distance_to(h) == r + 1;
    let mut keys = Vec::new();
    for hex in center.ring(r + 1) {
        let owner = hex.to_lower_res(r);
        let gaps = owned_gaps(hex, |nb| exists(nb) && !entangled(nb), exists);
        let quad_tris = 2 * gaps.quads.iter().flatten().count();
        keys.extend(std::iter::repeat_n(EntangledSeam { owner, also: None }, quad_tris));
        for (_, gv) in gaps.junctions.iter().flatten() {
            let also = gv
                .coordinates()
                .into_iter()
                .map(|c| c.to_lower_res(r))
                .find(|&c| c != coord && c != owner);
            keys.push(EntangledSeam { owner, also });
        }
    }
    Ok(keys)
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
    // ≤ 6 neighbour owners, plus ≤ 6 corner groups (one per chunk corner).
    const MAX_SEAM_GROUPS: usize = 12;
    const COVER_RADII: [u32; 4] = [0, 1, 2, 3];
    const REGION_RADIUS: u32 = 2; // 19 chunks
    const ONE_PLUS_SIX: usize = 7;
    const RANDOM_SUBSETS: usize = 300;
    const SUBSET_SEED: u64 = 0x2727;
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

    /// One chunk as a consumer assembles it from the free functions.
    struct Built {
        own: Vec<[Vec3; 3]>,
        seams: Vec<(EntangledSeam, [Vec3; 3])>,
    }

    fn build(coord: Hex, r: u32) -> Built {
        let layout = HGridLayout::for_chunk(&HGridSettings::default(), coord, r, &[]).unwrap();
        let keys = entangled_seam_keys(coord, r).unwrap();
        let tris = layout.entangled_seam_tris();
        assert_eq!(keys.len(), tris.len(), "a key per seam tri, r {r}, {coord:?}");
        Built { own: layout.own_tris(), seams: keys.into_iter().zip(tris).collect() }
    }

    fn tri_bits(t: &[Vec3; 3]) -> [u32; 9] {
        let [a, b, c] = t;
        [a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].map(f32::to_bits)
    }

    #[test]
    fn own_streams_partition_world() {
        for r in CHUNK_RADII {
            let layout = HGridLayout::new(&HGridSettings::default(), WORLD_RADIUS);
            let fitting: HashSet<Hex> = shapes::hexagon(Hex::ZERO, WORLD_RADIUS)
                .map(|h| h.to_lower_res(r))
                // The entangled ring (distance r + 1 from the centre) must fit inside the world.
                .filter(|c| c.to_higher_res(r).length() as u32 + r < WORLD_RADIUS)
                .collect();
            assert!(fitting.len() >= MIN_FITTING_CHUNKS, "r {r}: {} chunks", fitting.len());

            let mut got: Vec<[u32; 9]> =
                fitting.iter().flat_map(|&c| build(c, r).own).map(|t| tri_bits(&t)).collect();
            let mut want: Vec<[u32; 9]> = fitting
                .iter()
                .flat_map(|c| shapes::hexagon(c.to_higher_res(r), r))
                .fold(Vec::new(), |mut out, h| {
                    layout.owned_tris_into(h, &mut out);
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
    fn seams_match_owner_own() {
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let c = build(coord, r);
                let groups: HashSet<EntangledSeam> = c.seams.iter().map(|(k, _)| *k).collect();
                assert!((1..=MAX_SEAM_GROUPS).contains(&groups.len()), "r {r}: {}", groups.len());
                for (EntangledSeam { owner, also }, t) in &c.seams {
                    assert_ne!(*owner, coord);
                    if let Some(b) = also {
                        assert!(*b != coord && b != owner, "r {r}: also {b:?}");
                        let adjacent = |h: &Hex| h.unsigned_distance_to(*b) == 1;
                        assert!(adjacent(&coord) && adjacent(owner), "r {r}: also {b:?}");
                    }
                    let own: HashSet<[u32; 9]> =
                        build(*owner, r).own.iter().map(tri_bits).collect();
                    let missing = format!("r {r}: seam of {coord:?} not in {owner:?}");
                    assert!(own.contains(&tri_bits(t)), "{missing}");
                }
            }
        }
    }

    #[test]
    fn chunk_zero_radius_2_counts() {
        let c = build(Hex::ZERO, 2);
        assert_eq!(c.own.len(), GUIDE_OWNED);
        // The guide counts per owner; corner tris count towards their owner.
        for ((q, s), n) in GUIDE_SEAMS {
            let by_owner = c.seams.iter().filter(|(k, _)| k.owner == Hex::new(q, s)).count();
            assert_eq!(by_owner, n, "({q}, {s})");
        }
        let owners: HashSet<Hex> = c.seams.iter().map(|(k, _)| k.owner).collect();
        assert_eq!(owners.len(), GUIDE_SEAMS.len());
    }

    /// Loaded sets to check: every subset of the 1+6 around the origin, then
    /// random subsets of the whole region. Bit `i` loads `region[i]`.
    fn loaded_sets(region_len: usize) -> Vec<Vec<bool>> {
        let one_plus_six = (0u32..1 << ONE_PLUS_SIX).map(|m| (0..region_len).map(|i| i < ONE_PLUS_SIX && m >> i & 1 == 1).collect());
        // splitmix64: no rand dependency for a test.
        let random = (0..RANDOM_SUBSETS as u64).map(|k| {
            let mut z = SUBSET_SEED.wrapping_add(k.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            let z = z ^ (z >> 31);
            (0..region_len).map(|i| z >> i & 1 == 1).collect()
        });
        one_plus_six.chain(random).collect()
    }

    #[test]
    fn drawn_seams_cover_loaded_chunks_once() {
        for r in COVER_RADII {
            // The 1+6 first, so the low ONE_PLUS_SIX bits of a loaded set pick them.
            let mut region: Vec<Hex> = std::iter::once(Hex::ZERO).chain(Hex::ZERO.ring(1)).collect();
            region.extend(shapes::hexagon(Hex::ZERO, REGION_RADIUS).filter(|h| h.length() > 1));
            let chunks: Vec<Built> = region.iter().map(|&c| build(c, r)).collect();
            // Number each distinct triangle once, so a loaded set is just counting.
            let mut ids = std::collections::HashMap::new();
            let mut id_of = |t: &[Vec3; 3]| {
                let n = ids.len();
                *ids.entry(tri_bits(t)).or_insert(n)
            };
            let own: Vec<Vec<usize>> =
                chunks.iter().map(|c| c.own.iter().map(&mut id_of).collect()).collect();
            let seams: Vec<Vec<usize>> =
                chunks.iter().map(|c| c.seams.iter().map(|(_, t)| id_of(t)).collect()).collect();

            for set in loaded_sets(region.len()) {
                let loaded = |h: Hex| region.iter().zip(&set).any(|(c, &on)| on && *c == h);
                let mut drawn = vec![0u8; ids.len()];
                let mut touching = vec![false; ids.len()];
                for (i, c) in chunks.iter().enumerate().filter(|&(i, _)| set[i]) {
                    own[i].iter().for_each(|&t| (drawn[t], touching[t]) = (drawn[t] + 1, true));
                    for ((key, _), &t) in c.seams.iter().zip(&seams[i]) {
                        let on = u8::from(key.drawn(region[i], loaded));
                        (drawn[t], touching[t]) = (drawn[t] + on, true);
                    }
                }
                let twice = drawn.iter().filter(|&&n| n > 1).count();
                assert_eq!(twice, 0, "r {r}: {twice} duplicate tris, set {set:?}");
                // Every triangle touching a loaded chunk is in its owned or seam stream.
                let holes = touching.iter().zip(&drawn).filter(|&(&t, &n)| t && n == 0).count();
                assert_eq!(holes, 0, "r {r}: {holes} holes, set {set:?}");
            }
        }
    }

    /// `testdata/entangled_seam_drawn.tsv`: `(carrier, key, loaded, drawn)` rows.
    fn drawn_table() -> Vec<(Hex, EntangledSeam, Vec<Hex>, bool)> {
        let hex = |t: &str| {
            let (q, r) = t.split_once(',').expect("hex is `q,r`");
            Hex::new(q.parse().expect("q"), r.parse().expect("r"))
        };
        let hexes = |t: &str| if t == "-" { Vec::new() } else { t.split(';').map(hex).collect() };
        include_str!("../testdata/entangled_seam_drawn.tsv")
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                let also = (f[2] != "-").then(|| hex(f[2]));
                let key = EntangledSeam { owner: hex(f[1]), also };
                (hex(f[0]), key, hexes(f[3]), f[4].parse().expect("drawn is true/false"))
            })
            .collect()
    }

    #[test]
    fn drawn_follows_the_shared_table() {
        let table = drawn_table();
        assert!(table.len() >= 10, "table has {} rows", table.len());
        for (carrier, key, loaded, want) in table {
            let got = key.drawn(carrier, |h| loaded.contains(&h));
            assert_eq!(got, want, "carrier {carrier:?}, {key:?}, loaded {loaded:?}");
        }
    }

    #[test]
    fn seam_keys_match_vertex_positions() {
        // The keys come from hex math; check them against the tris' actual corners:
        // `also` is the chunk of a corner cell that is neither the carrier nor the owner.
        for r in CHUNK_RADII {
            for (q, s) in SEAM_COORDS {
                let coord = Hex::new(q, s);
                let g = HGridSettings::default();
                let layout = HGridLayout::for_chunk(&g, coord, r, &[]).unwrap();
                let tris = layout.entangled_seam_tris();
                let keys = entangled_seam_keys(coord, r).unwrap();
                assert_eq!(keys.len(), tris.len(), "r {r}, {coord:?}");
                let counts = layout.entangled_seam_counts();
                assert_eq!(counts.iter().map(|(q, j)| q + j).sum::<usize>(), tris.len());
                let owners = layout.entangled_ring().zip(&counts).flat_map(|(h, &(q, j))| {
                    std::iter::repeat_n(h, q + j)
                });
                for ((t, key), ring_cell) in tris.iter().zip(&keys).zip(owners) {
                    assert_eq!(key.owner, ring_cell.to_lower_res(r));
                    let chunk_of = |v: &Vec3| {
                        std::iter::once(ring_cell)
                            .chain(ring_cell.all_neighbors())
                            .find(|&n| (0..6).any(|i| layout.vertex(n, i) == Some(*v)))
                            .expect("seam vertex is a corner of its ring cell or a neighbour")
                            .to_lower_res(r)
                    };
                    let also = t.iter().map(chunk_of).find(|&c| c != coord && c != key.owner);
                    assert_eq!(key.also, also, "r {r}, {coord:?}, {t:?}");
                }
            }
        }
    }

    #[test]
    fn own_and_seam_tris_split_all_tris() {
        for r in CHUNK_RADII {
            let g = HGridSettings::default();
            let layout = HGridLayout::for_chunk(&g, Hex::new(2, -1), r, &[]).unwrap();
            let own = layout.own_tris();
            assert_eq!(own.len(), 14 * layout.own_cells().count(), "r {r}: 14 tris per own cell");
            let seam = layout.entangled_seam_tris();
            let mut split: Vec<_> = own.iter().chain(&seam).map(tri_bits).collect();
            let mut all: Vec<_> = layout.all_tris().iter().map(tri_bits).collect();
            split.sort();
            all.sort();
            assert_eq!(split, all, "r {r}");
            assert_eq!(layout.entangled_ring().count(), 6 * (r as usize + 1));
        }
        let grid = HGridLayout::new(&HGridSettings::default(), 2);
        assert!(grid.entangled_seam_tris().is_empty() && grid.entangled_seam_counts().is_empty());
        assert_eq!(grid.own_tris(), grid.all_tris());
    }

    #[test]
    fn keys_reject_what_for_chunk_rejects() {
        let g = HGridSettings::default();
        for coord in [Hex::new(2_000_000, 0), Hex::new(i32::MAX, 0), Hex::new(-3, 2)] {
            let layout = HGridLayout::for_chunk(&g, coord, 6, &[]).err();
            assert_eq!(entangled_seam_keys(coord, 6).err(), layout, "{coord:?}");
        }
    }

    #[test]
    fn own_cell_states_follow_own_cells() {
        let g = HGridSettings::default();
        let edits = [(crate::NoiseType::Height, Hex::new(1, -1), 7.5)];
        let layout = HGridLayout::for_chunk(&g, Hex::ZERO, 2, &edits).unwrap();
        let states = layout.own_cell_states();
        let hexes: Vec<Hex> = layout.own_cells().collect();
        assert_eq!(states.iter().map(|c| c.hex).collect::<Vec<_>>(), hexes);
        assert_eq!(states.iter().find(|c| c.hex == Hex::new(1, -1)).unwrap().height, 7.5);
    }

    #[test]
    fn chunk_is_deterministic() {
        let coord = Hex::new(-3, 2);
        let (a, b) = (build(coord, 2), build(coord, 2));
        assert_eq!((a.own, a.seams), (b.own, b.seams));
    }
}

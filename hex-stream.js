/**
 * Bookkeeping for the 1+6 chunk treadmill on `hex-stream.html`: which chunk
 * coordinates are loaded, what one step spawns and despawns, when the camera
 * has drifted far enough to step, and which seam groups to draw.
 *
 * Coordinates are `[q, r]` on the chunk lattice (`WasmChunkWorld.chunk(q, r)`),
 * not cell coordinates. No engine or wasm imports, so it runs under plain node.
 */

import { splitmix32 } from "./seed.js";

/** Longest frame (s) one update may integrate; a tab back from the background would otherwise replay every step it missed in one frame. */
export const MAX_FRAME_DT = 0.1;
/** Largest chunk radius the page builds; matches the input's `max`. */
export const MAX_CHUNK_RADIUS = 6;
/** Rate (1/s) at which the camera's sideways offset from its rail decays; off-rail it would zig-zag between two chunk rows. */
export const RAIL_PULL = 3;
/**
 * Fade timing: a step's 3 spawned chunks fade in over FADE_IN_S; the 3 despawned ones
 * wait that long, then fade to a ghost (see {@link ageGhost}). FADE_OUT_S is the time a
 * full 1 → 0 fade-out would take; partial fades take their share of it.
 */
export const FADE_IN_S = 0.6, FADE_OUT_S = 0.25;
/** Opacity a despawned chunk holds for each step since it left: 10% on the first, 5% on the next, then dropped. */
export const GHOST_ALPHAS = [0.1, 0.05];

/** Ints per seam group in `WasmChunk.seam_keys()`: `[oq, or, aq, ar]`. */
export const SEAM_KEY_STRIDE = 4;
/** u16 values in one triangle of a flat f32 buffer (9 floats × 2). */
const U16_PER_TRI = 18;

/** The 6 axial neighbour offsets on the chunk lattice. */
export const CHUNK_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/**
 * Map key for a chunk coordinate.
 * @param {number} q
 * @param {number} r
 * @returns {string} `"q,r"`
 */
export const chunkKey = (q, r) => `${q},${r}`;

/**
 * Stable, well-mixed u32 per chunk coordinate, so neighbours get unrelated colours.
 * @param {number} q
 * @param {number} r
 * @returns {number} u32
 */
export const chunkHash = (q, r) => splitmix32(splitmix32(q >>> 0) ^ (r >>> 0));

const add = ([q, r], [dq, dr]) => [q + dq, r + dr];
const keyOf = ([q, r]) => chunkKey(q, r);

/**
 * The 7 chunks loaded around `anchor`.
 * @param {[number, number]} anchor
 * @returns {[number, number][]} anchor first, then `anchor + CHUNK_DIRS[i]`.
 */
export const footprint = (anchor) => [anchor, ...CHUNK_DIRS.map((d) => add(anchor, d))];

/**
 * Move the anchor one chunk in direction `dir` and diff the footprints.
 * @param {[number, number]} anchor
 * @param {number} dir index into {@link CHUNK_DIRS}
 * @returns {{anchor: [number, number], spawn: [number, number][],
 *   despawn: [number, number][], keep: [number, number][]}} always 3 / 3 / 4.
 */
export const stepFootprint = (anchor, dir) => {
  const next = add(anchor, CHUNK_DIRS[dir]);
  const before = footprint(anchor), after = footprint(next);
  const beforeKeys = new Set(before.map(keyOf)), afterKeys = new Set(after.map(keyOf));
  return {
    anchor: next,
    spawn: after.filter((c) => !beforeKeys.has(keyOf(c))),
    despawn: before.filter((c) => !afterKeys.has(keyOf(c))),
    keep: after.filter((c) => beforeKeys.has(keyOf(c))),
  };
};

/**
 * World `(x, z)` centre of a chunk. Linear in the coordinate because both
 * `to_higher_res` and `hex_to_world_pos` are, so two basis vectors suffice.
 * @param {[number, number]} coord
 * @param {[number, number]} u world centre of chunk `(1, 0)`
 * @param {[number, number]} v world centre of chunk `(0, 1)`
 * @returns {[number, number]}
 */
export const chunkCenter = ([q, r], u, v) => [q * u[0] + r * v[0], q * u[1] + r * v[1]];

/**
 * Which neighbour chunk, if any, the camera position `pos` is now closer to
 * than the anchor — i.e. which way to step.
 * @param {[number, number]} pos world `(x, z)` under the camera
 * @param {[number, number]} anchor
 * @param {[number, number]} u
 * @param {[number, number]} v
 * @returns {number} index into {@link CHUNK_DIRS}, or `-1` to stay.
 */
export const nearestStep = (pos, anchor, u, v) => {
  const dist2 = (c) => {
    const [x, z] = chunkCenter(c, u, v);
    return (x - pos[0]) ** 2 + (z - pos[1]) ** 2;
  };
  const { dir } = CHUNK_DIRS.reduce(
    (best, d, i) => {
      const dd = dist2(add(anchor, d));
      return dd < best.d2 ? { dir: i, d2: dd } : best;
    },
    { dir: -1, d2: dist2(anchor) },
  );
  return dir;
};

const before = ([q, r], [bq, br]) => q < bq || (q === bq && r < br);

/**
 * Seam groups chunk `self` should draw (consumer rule 1, `Seam::drawn` in
 * `src/chunk.rs`): the owner isn't loaded, and the `also` chunk a corner
 * triangle touches isn't loaded either or comes after `self` in `(q, r)`
 * order — so of two loaded carriers exactly one draws a corner.
 * @param {Int32Array|number[]} keys `WasmChunk.seam_keys()`, `[oq, or, aq, ar, …]`
 * @param {[number, number]} self the carrying chunk's coordinate
 * @param {Set<string>} loaded keys from {@link chunkKey}
 * @returns {number[]} group indices for `WasmChunk.seam(i)`.
 */
export const visibleSeamGroups = (keys, self, loaded) =>
  Array.from({ length: keys.length / SEAM_KEY_STRIDE }, (_, i) => i).filter((i) => {
    const [oq, or, aq, ar] = keys.slice(SEAM_KEY_STRIDE * i, SEAM_KEY_STRIDE * (i + 1));
    return !loaded.has(chunkKey(oq, or)) && (!loaded.has(chunkKey(aq, ar)) || before(self, [aq, ar]));
  });

/**
 * Triangles that appear more than once across flat `n_tris * 9` buffers (bit-exact match).
 * @param {Float32Array[]} buffers
 * @returns {number} extra copies; 0 when no triangle is drawn twice.
 */
export const duplicateTris = (buffers) => {
  // Each tri's raw bytes as a short string: exact, and far cheaper than formatting 9 floats.
  const keys = buffers.flatMap((b) => {
    const u16 = new Uint16Array(b.buffer, b.byteOffset, b.length * 2);
    return Array.from({ length: u16.length / U16_PER_TRI }, (_, i) =>
      String.fromCharCode(...u16.subarray(U16_PER_TRI * i, U16_PER_TRI * (i + 1))));
  });
  return keys.length - new Set(keys).size;
};

/**
 * Move the camera position along `dir` for one frame, with `dt` capped at
 * {@link MAX_FRAME_DT}, easing any sideways offset from the line through
 * `rail` (along `dir`) away at {@link RAIL_PULL}. After a direction change the
 * camera would otherwise run parallel to a row of chunk centres and the
 * nearest-chunk anchor would zig-zag between two rows.
 * @param {[number, number]} pos world `(x, z)`
 * @param {[number, number]} dir world `(x, z)` direction, any non-zero length
 * @param {number} speed world units per second
 * @param {number} dt seconds since the last frame
 * @param {[number, number]} [rail=pos] a point on the line to settle onto, e.g. the anchor's centre
 * @returns {[number, number]}
 */
export const advancePos = (pos, [dx, dz], speed, dt, rail = pos) => {
  const t = Math.min(dt, MAX_FRAME_DT), len = Math.hypot(dx, dz);
  const ux = dx / len, uz = dz / len;
  const ox = pos[0] - rail[0], oz = pos[1] - rail[1], along = ox * ux + oz * uz;
  const pull = Math.exp(-RAIL_PULL * t) - 1; // negative: fraction of the sideways offset removed
  return [
    pos[0] + ux * speed * t + (ox - along * ux) * pull,
    pos[1] + uz * speed * t + (oz - along * uz) * pull,
  ];
};

/**
 * Age a chunk by one step out of the footprint: aim at the next {@link GHOST_ALPHAS}
 * stage, or at 0 (then dropped) past the last. Never aims above the alpha it has, so a
 * chunk despawned before it showed stays invisible. A settled chunk waits FADE_IN_S to
 * fade alongside this step's despawns; one still waiting or fading keeps going, so
 * steps faster than FADE_IN_S cannot hold a ghost in place.
 * @param {{fade: {alpha: number, target: number, delay: number}, ghost: number}} chunk
 *   ghost is the steps it has been out (0 = in the footprint)
 * @returns {{fade: {alpha: number, target: number, delay: number}, ghost: number}}
 */
export const ageGhost = ({ fade, ghost }) => ({
  fade: {
    alpha: fade.alpha,
    target: Math.min(fade.alpha, GHOST_ALPHAS[ghost] ?? 0),
    delay: fade.alpha === fade.target ? FADE_IN_S : fade.delay,
  },
  ghost: ghost + 1,
});

/**
 * Advance one chunk's fade by `dt`: wait out `delay`, then move `alpha`
 * toward `target` and stop there (fading in at 1 per {@link FADE_IN_S}, out at 1 per {@link FADE_OUT_S}).
 * @param {{alpha: number, target: number, delay: number}} fade target in [0, 1]
 * @param {number} dt seconds
 * @returns {{alpha: number, target: number, delay: number}}
 */
export const advanceFade = ({ alpha, target, delay }, dt) => {
  const wait = Math.min(delay, dt), run = dt - wait;
  const next = target > alpha
    ? Math.min(target, alpha + run / FADE_IN_S)
    : Math.max(target, alpha - run / FADE_OUT_S);
  return { alpha: next, target, delay: delay - wait };
};

/**
 * Chunk radius from the sidebar, clamped to `0..MAX_CHUNK_RADIUS`; a negative
 * value would wrap to `u32::MAX` across the wasm boundary and panic.
 * @param {number} r parsed input (may be NaN)
 * @returns {number}
 */
export const clampChunkRadius = (r) =>
  Math.min(MAX_CHUNK_RADIUS, Math.max(0, Number.isFinite(r) ? Math.trunc(r) : 0));

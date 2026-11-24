/**
 * Bookkeeping for the 1+6 chunk treadmill on `hex-stream.html`: which chunk
 * coordinates are loaded, what one step spawns and despawns, when the camera
 * has drifted far enough to step, and which seam groups to draw.
 *
 * Coordinates are `[q, r]` on the chunk lattice (`WasmChunkWorld.chunk(q, r)`),
 * not cell coordinates. No engine or wasm imports, so it runs under plain node.
 */

/** Longest frame (s) one update may integrate; a tab back from the background would otherwise replay every step it missed in one frame. */
export const MAX_FRAME_DT = 0.1;
/** Largest chunk radius the page builds; matches the input's `max`. */
export const MAX_CHUNK_RADIUS = 6;

/** The 6 axial neighbour offsets on the chunk lattice. */
export const CHUNK_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/**
 * Map key for a chunk coordinate.
 * @param {number} q
 * @param {number} r
 * @returns {string} `"q,r"`
 */
export const chunkKey = (q, r) => `${q},${r}`;

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

/**
 * Seam groups to draw: those whose owning chunk is not loaded (otherwise the
 * owner's owned stream already covers them).
 * @param {Int32Array|number[]} owners `WasmChunk.seam_owners()`, `[q0, r0, q1, r1, …]`
 * @param {Set<string>} loaded keys from {@link chunkKey}
 * @returns {number[]} group indices for `WasmChunk.seam(i)`.
 */
export const visibleSeamGroups = (owners, loaded) =>
  Array.from({ length: owners.length / 2 }, (_, i) => i)
    .filter((i) => !loaded.has(chunkKey(owners[2 * i], owners[2 * i + 1])));

/**
 * Move the camera position along `dir` for one frame, with `dt` capped at
 * {@link MAX_FRAME_DT}.
 * @param {[number, number]} pos world `(x, z)`
 * @param {[number, number]} dir world `(x, z)` direction, any non-zero length
 * @param {number} speed world units per second
 * @param {number} dt seconds since the last frame
 * @returns {[number, number]}
 */
export const advancePos = (pos, [dx, dz], speed, dt) => {
  const k = (speed * Math.min(dt, MAX_FRAME_DT)) / Math.hypot(dx, dz);
  return [pos[0] + dx * k, pos[1] + dz * k];
};

/**
 * Chunk radius from the sidebar, clamped to `0..MAX_CHUNK_RADIUS`; a negative
 * value would wrap to `u32::MAX` across the wasm boundary and panic.
 * @param {number} r parsed input (may be NaN)
 * @returns {number}
 */
export const clampChunkRadius = (r) =>
  Math.min(MAX_CHUNK_RADIUS, Math.max(0, Number.isFinite(r) ? Math.trunc(r) : 0));

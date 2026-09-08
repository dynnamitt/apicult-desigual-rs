/**
 * Seed helpers shared by the demo pages.
 *
 * Both pages build several `WasmLayout`s per render (the terrain cluster needs
 * 14 seeds, the units grid 2) but expose a single seed box, so one typed root
 * has to fan out into a stable sequence of u32s.
 */

/** A fresh random u32, for the "re-roll" / blank-seed path. */
export const randomU32 = () => Math.floor(Math.random() * 0x1_0000_0000) >>> 0;

/**
 * SplitMix32 — a cheap reversible mixer. Avalanches a counter into a
 * well-distributed u32, so consecutive roots produce unrelated seeds.
 */
export const splitmix32 = (s) => {
  s = (s + 0x9E3779B9) >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35) >>> 0;
  return (s ^ (s >>> 16)) >>> 0;
};

/**
 * `n` stable seeds derived from one root, so the same typed seed always
 * reproduces the same scene.
 *
 * @param {number} root
 * @param {number} n
 * @returns {number[]}
 */
export const seedSequence = (root, n) => {
  const out = new Array(n);
  let s = root >>> 0;
  for (let i = 0; i < n; i++) {
    s = splitmix32(s);
    out[i] = s;
  }
  return out;
};

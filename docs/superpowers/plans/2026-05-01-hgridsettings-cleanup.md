# HGridSettings cleanup: rename + relativize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `point_spacing` to `nominal_hex_radius` (matching hex-grid orthodoxy) and convert `min_hex_radius` / `max_hex_radius` from absolute world units into ratio-of-nominal fields, so `HGridSettings` types-enforce the "100% baseline" framing the README intro promises.

**Architecture:** Two semantic passes, each its own commit. Pass 1 is a pure rename — no behavior change, callers compile after a `replace_all`-style sweep. Pass 2 changes the meaning of two fields (radii become unitless ratios in `[0.0, 1.0]`), the noise-sample call site multiplies by `nominal_hex_radius`, and defaults rescale (`0.2 → 0.05`, `2.6 → 0.65`) so identical visual output is preserved.

**Tech Stack:** Rust 2024, single-crate library, `cargo test` + `cargo run --example geo_export`, `wasm-pack build --target web --features wasm` for the wasm sanity check, `make preview` for the visual smoke test.

---

## Old vs new shape (proposal at a glance)

### Before (current `src/layout.rs:14-37`)

```rust
pub struct HGridSettings {
    pub radius: u32,
    /// Distance in world-units between adjacent hex centers.   ← WRONG: this is center-to-corner
    pub point_spacing: f32,
    pub height_noise_seed: u32,
    pub radius_noise_seed: u32,
    pub height_noise_octaves: usize,
    pub radius_noise_octaves: usize,
    pub height_noise_scale: f64,
    pub radius_noise_scale: f64,
    pub max_height: f32,
    /// Smallest visual hex radius (noise-derived per cell).    ← world units, ambiguous
    pub min_hex_radius: f32,
    /// Largest visual hex radius (noise-derived per cell).
    pub max_hex_radius: f32,
}
```

Defaults: `point_spacing: 4.0`, `min_hex_radius: 0.2`, `max_hex_radius: 2.6`.

### After

```rust
pub struct HGridSettings {
    pub radius: u32,
    /// Hex size — center-to-corner distance of a 100% / normal-form cell, in world units.
    /// Pointy-top width is √3·nominal_hex_radius; flat-top width is 2·nominal_hex_radius.
    /// Drives `HexLayout.scale`.
    pub nominal_hex_radius: f32,
    pub height_noise_seed: u32,
    pub radius_noise_seed: u32,
    pub height_noise_octaves: usize,
    pub radius_noise_octaves: usize,
    pub height_noise_scale: f64,
    pub radius_noise_scale: f64,
    pub max_height: f32,
    /// Lower bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0`. Cell radii below 1.0 leave room for bridge geometry.
    pub min_radius_ratio: f32,
    /// Upper bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0` (`> 1.0` causes neighbor overlap).
    pub max_radius_ratio: f32,
}
```

Defaults: `nominal_hex_radius: 4.0`, `min_radius_ratio: 0.05`, `max_radius_ratio: 0.65`.

Key rule (`src/layout.rs:131`): the per-cell radius is now `nominal_hex_radius × map_noise_to_range(r_noise, min_radius_ratio, max_radius_ratio)`. Identical numerical output to today, because `4.0 × 0.05 = 0.2` and `4.0 × 0.65 = 2.6`.

The accessor at `src/layout.rs:384` is renamed `point_spacing()` → `nominal_hex_radius()`. Its single caller at `src/serialize.rs:166` follows.

### Impact surface (every site that needs touching)

| File | Line(s) | What |
|---|---|---|
| `src/layout.rs` | 18 | field def: `point_spacing` → `nominal_hex_radius` |
| `src/layout.rs` | 34 | field def: `min_hex_radius` → `min_radius_ratio` |
| `src/layout.rs` | 36 | field def: `max_hex_radius` → `max_radius_ratio` |
| `src/layout.rs` | 43 | default: `point_spacing: 4.0` → `nominal_hex_radius: 4.0` |
| `src/layout.rs` | 51 | default: `min_hex_radius: 0.2` → `min_radius_ratio: 0.05` |
| `src/layout.rs` | 52 | default: `max_hex_radius: 2.6` → `max_radius_ratio: 0.65` |
| `src/layout.rs` | 103 | `scale: Vec2::splat(g.point_spacing)` → uses `nominal_hex_radius` |
| `src/layout.rs` | 131 | per-cell radius compute changes (multiplies by nominal) |
| `src/layout.rs` | 384 | accessor rename: `point_spacing()` → `nominal_hex_radius()` |
| `src/serialize.rs` | 166 | caller: `layout.point_spacing()` → `layout.nominal_hex_radius()` |
| `examples/geo_export.rs` | 49 | field literal: `point_spacing: 4.0` → `nominal_hex_radius: 4.0` |
| `web/hex-seam.js` | 5, 42 | comment-only: derivation prose mentions `point_spacing` |

`src/wasm.rs:148-153` and `src/serialize.rs:259-262` use `..HGridSettings::default()` and don't touch the renamed fields directly — they need no changes.

---

## File Structure

No new files. All changes are renames + a single arithmetic change inside `HGridLayout::new`. The two-pass split lives in commit boundaries, not in directory layout.

---

## Task 1: Pass 1 — pure rename `point_spacing` → `nominal_hex_radius`

Goal: warning-clean compile + green tests after a mechanical rename. No semantic change.

**Files:**
- Modify: `src/layout.rs:14-55`, `src/layout.rs:103`, `src/layout.rs:383-386`
- Modify: `src/serialize.rs:166`
- Modify: `examples/geo_export.rs:49`
- Modify: `web/hex-seam.js:5, 42` (comments only, no executable code change)

- [ ] **Step 1.1: Capture a reference SVG hash for visual-regression baseline**

The plan rests on "no behavior change" claims. Capture proof now so Pass 1 and Pass 2 each have a checkpoint.

Run:

```bash
cargo run --example geo_export -- 5 2.0 --seed 42 --format svg-rich > /tmp/before.svg
cargo run --example geo_export -- 5 2.0 --seed 42 --format json-v2 > /tmp/before.json
sha256sum /tmp/before.svg /tmp/before.json
```

Expected: two checksums printed. Save them in your scratchpad — Task 1 step 1.7 and Task 2 step 2.6 will compare against them.

- [ ] **Step 1.2: Add a regression test asserting the public field/method names exist**

Append at the bottom of `src/layout.rs`, inside the existing `#[cfg(test)] mod tests { ... }` block (or create one if missing — check `src/layout.rs` for the closing `}`):

```rust
#[test]
fn nominal_hex_radius_field_and_accessor_exist() {
    let s = HGridSettings {
        nominal_hex_radius: 4.0,
        ..HGridSettings::default()
    };
    let layout = HGridLayout::new(&s, &[], &[]);
    assert_eq!(layout.nominal_hex_radius(), 4.0);
}
```

- [ ] **Step 1.3: Run the test to verify it fails**

Run: `cargo test nominal_hex_radius_field_and_accessor_exist`

Expected: compile error — `no field 'nominal_hex_radius' on type 'HGridSettings'` and `no method named 'nominal_hex_radius' found`.

- [ ] **Step 1.4: Rename the struct field, default, and internal use site**

In `src/layout.rs` line 17-18, replace:

```rust
    /// Distance in world-units between adjacent hex centers.
    pub point_spacing: f32,
```

with:

```rust
    /// Hex size — center-to-corner distance of a 100% / normal-form cell, in world units.
    /// Pointy-top width is √3·nominal_hex_radius; flat-top width is 2·nominal_hex_radius.
    /// Drives `HexLayout.scale`.
    pub nominal_hex_radius: f32,
```

In `src/layout.rs:43`, replace `point_spacing: 4.0,` with `nominal_hex_radius: 4.0,`.

In `src/layout.rs:103`, replace `scale: Vec2::splat(g.point_spacing),` with `scale: Vec2::splat(g.nominal_hex_radius),`.

- [ ] **Step 1.5: Rename the accessor**

In `src/layout.rs:383-386`, replace:

```rust
    /// World-units between adjacent hex centers (the layout `scale.x`).
    pub fn point_spacing(&self) -> f32 {
        self.layout.scale.x
    }
```

with:

```rust
    /// Nominal hex radius (center-to-corner of a 100% cell), reading the layout's `scale.x`.
    pub fn nominal_hex_radius(&self) -> f32 {
        self.layout.scale.x
    }
```

- [ ] **Step 1.6: Update the two callers**

In `src/serialize.rs:166`, replace:

```rust
        let font = layout.point_spacing() * 0.22;
```

with:

```rust
        let font = layout.nominal_hex_radius() * 0.22;
```

In `examples/geo_export.rs:49`, replace:

```rust
        point_spacing: 4.0,
```

with:

```rust
        nominal_hex_radius: 4.0,
```

- [ ] **Step 1.7: Update the prose comments in `web/hex-seam.js`**

In `web/hex-seam.js:5`, replace:

```
// at distance 3 * R * point_spacing — exactly the offset that makes its
```

with:

```
// at distance 3 * R * nominal_hex_radius — exactly the offset that makes its
```

In `web/hex-seam.js:42`, replace:

```
// distance 1.5 * R * point_spacing. So petal distance = 3 * R * point_spacing.
```

with:

```
// distance 1.5 * R * nominal_hex_radius. So petal distance = 3 * R * nominal_hex_radius.
```

- [ ] **Step 1.8: Run the full test suite (incl. doctests)**

Run: `cargo test`

Expected: all tests pass, including the new `nominal_hex_radius_field_and_accessor_exist` and any doctest in `math.rs`. Zero warnings (Cargo denies `unused` and `clippy::all`).

- [ ] **Step 1.9: Run the example to confirm output is byte-identical**

Run:

```bash
cargo run --example geo_export -- 5 2.0 --seed 42 --format svg-rich > /tmp/after-pass1.svg
cargo run --example geo_export -- 5 2.0 --seed 42 --format json-v2 > /tmp/after-pass1.json
diff /tmp/before.svg /tmp/after-pass1.svg && echo "SVG identical"
diff /tmp/before.json /tmp/after-pass1.json && echo "JSON identical"
```

Expected: both `diff` exit 0 and print "identical" — pure rename, byte-identical output.

- [ ] **Step 1.10: Wasm sanity build**

Run: `wasm-pack build --target web --features wasm --release`

Expected: builds clean, writes `web/pkg/apicult_desigual.js`, `_bg.wasm`, `.d.ts`. (No JS-side field references means no runtime test needed; compile-clean is enough.)

- [ ] **Step 1.11: Commit**

```bash
git add src/layout.rs src/serialize.rs examples/geo_export.rs web/hex-seam.js
git commit -m "refactor(layout): rename point_spacing → nominal_hex_radius"
```

---

## Task 2: Pass 2 — relativize `min_hex_radius`/`max_hex_radius` into ratios

Goal: change the *meaning* of the radius bounds from absolute world units into unitless fractions of `nominal_hex_radius`. The arithmetic at the noise-sample site changes; defaults rescale so visual output stays identical.

**Files:**
- Modify: `src/layout.rs:33-37` (field defs)
- Modify: `src/layout.rs:51-52` (defaults)
- Modify: `src/layout.rs:131` (multiply by nominal at sample time)

- [ ] **Step 2.1: Add a regression test asserting the new ratio fields produce the same per-cell radii as before**

Append to the same `#[cfg(test)] mod tests` block in `src/layout.rs`:

```rust
#[test]
fn ratio_bounds_produce_legacy_world_radii() {
    // With nominal=4.0 and ratio bounds 0.05..0.65, per-cell radii must land
    // in [0.2, 2.6] — the same world-space interval the old absolute fields used.
    let s = HGridSettings {
        nominal_hex_radius: 4.0,
        min_radius_ratio: 0.05,
        max_radius_ratio: 0.65,
        radius: 5,
        ..HGridSettings::default()
    };
    let layout = HGridLayout::new(&s, &[], &[]);

    let mut min_r = f32::INFINITY;
    let mut max_r = f32::NEG_INFINITY;
    for cell in layout.cells_iter() {
        if cell.radius < min_r { min_r = cell.radius; }
        if cell.radius > max_r { max_r = cell.radius; }
    }

    assert!(min_r >= 0.2 - 1e-4, "min radius {} below floor", min_r);
    assert!(max_r <= 2.6 + 1e-4, "max radius {} above ceiling", max_r);
}
```

If `cells_iter()` doesn't exist, replace the loop with whatever public iteration the layout exposes — check `src/layout.rs` accessors first; if none, sample a few hexes by `Hex::new(q, r)` and read `cell.radius` via the existing accessor pattern used elsewhere in the test module.

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `cargo test ratio_bounds_produce_legacy_world_radii`

Expected: compile error — `no field 'min_radius_ratio' on type 'HGridSettings'` (and `max_radius_ratio`).

- [ ] **Step 2.3: Rename the field defs in the struct**

In `src/layout.rs:33-36`, replace:

```rust
    /// Smallest visual hex radius (noise-derived per cell).
    pub min_hex_radius: f32,
    /// Largest visual hex radius (noise-derived per cell).
    pub max_hex_radius: f32,
```

with:

```rust
    /// Lower bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0`. Cell radii below 1.0 leave room for bridge geometry.
    pub min_radius_ratio: f32,
    /// Upper bound for noise-sampled per-cell radius, as a fraction of `nominal_hex_radius`.
    /// Range `0.0..=1.0` (`> 1.0` causes neighbor overlap).
    pub max_radius_ratio: f32,
```

- [ ] **Step 2.4: Rescale the defaults**

In `src/layout.rs:51-52`, replace:

```rust
            min_hex_radius: 0.2,
            max_hex_radius: 2.6,
```

with:

```rust
            min_radius_ratio: 0.05,
            max_radius_ratio: 0.65,
```

- [ ] **Step 2.5: Multiply by nominal at the sample site**

In `src/layout.rs:131`, replace:

```rust
                radius: math::map_noise_to_range(r_noise, g.min_hex_radius, g.max_hex_radius),
```

with:

```rust
                radius: g.nominal_hex_radius
                    * math::map_noise_to_range(r_noise, g.min_radius_ratio, g.max_radius_ratio),
```

- [ ] **Step 2.6: Run all tests**

Run: `cargo test`

Expected: all pass, including the new `ratio_bounds_produce_legacy_world_radii`. The existing layout/math/serialize tests must remain green — if any fails, the rescaling math is off; verify `0.2 / 4.0 = 0.05` and `2.6 / 4.0 = 0.65` exactly (these are clean f32 values, no precision drift).

- [ ] **Step 2.7: Run the example and diff against the Pass 1 output**

Run:

```bash
cargo run --example geo_export -- 5 2.0 --seed 42 --format svg-rich > /tmp/after-pass2.svg
cargo run --example geo_export -- 5 2.0 --seed 42 --format json-v2 > /tmp/after-pass2.json
diff /tmp/before.svg /tmp/after-pass2.svg && echo "SVG byte-identical to pre-cleanup"
diff /tmp/before.json /tmp/after-pass2.json && echo "JSON byte-identical to pre-cleanup"
```

Expected: both diff exit 0. The whole point of the rescaling-of-defaults is byte-identical output.

If they differ: the most likely culprit is `map_noise_to_range` not producing the same value when both endpoints are scaled by the same factor and the result is then multiplied by that factor — verify by hand that `4.0 * map_to(noise, 0.05, 0.65) == map_to(noise, 0.2, 2.6)` for a few `noise` values. If `map_noise_to_range` is `(noise + 1) * 0.5 * (max - min) + min`, the algebra works out exactly.

- [ ] **Step 2.8: Wasm + preview smoke**

Run:

```bash
wasm-pack build --target web --features wasm --release
make HSEED=42 RADIUS=5 preview
```

Expected: wasm builds clean. The `target/svg-preview/` bundle renders. Open `target/svg-preview/hex-terrain.html` in a browser and confirm the terrain looks visually identical to a `git stash` baseline (eyeball check — the byte-identical SVG/JSON in step 2.7 is the rigorous proof; this is the WebGL-side belt-and-braces).

- [ ] **Step 2.9: Commit**

```bash
git add src/layout.rs
git commit -m "refactor(layout): radius bounds become nominal-relative ratios"
```

---

## Task 3: Update README intro to reflect type-enforced framing

The README intro currently reads "each cell can shrink below its normal-form (100%) size." Pass 2 makes this *literally true at the type level* (the ratio fields are bounded `0.0..=1.0`). One sentence in the intro should make this connection explicit so the documentation closes the loop.

**Files:**
- Modify: `README.md:7`

- [ ] **Step 3.1: Tighten the intro sentence**

In `README.md`, locate the intro paragraph (around line 7):

```markdown
**apicult(desigual)** is a hexagonal layout system where each cell can shrink below its normal-form (100%) size, with bridge geometry filling the gaps to its neighbors. Random seeds drive per-cell size and 3D height.
```

Replace with:

```markdown
**apicult(desigual)** is a hexagonal layout system where each cell can shrink below its normal-form (100%) size — controlled by `min_radius_ratio` / `max_radius_ratio` in `[0.0, 1.0]` — with bridge geometry filling the gaps to its neighbors. Random seeds drive per-cell size and 3D height.
```

- [ ] **Step 3.2: Update the `Usage` snippet to use a renamed field if present**

`README.md:22-34` (the `Usage` block) does not currently set `point_spacing`, `min_hex_radius`, or `max_hex_radius` directly — it uses `..HGridSettings::default()`. Verify with `grep` and skip this step if no rename is needed:

```bash
grep -n "point_spacing\|min_hex_radius\|max_hex_radius" README.md
```

Expected: no matches (the README block only sets `radius`). If matches appear, rename them in the snippet to the new names.

- [ ] **Step 3.3: Commit**

```bash
git add README.md
git commit -m "docs: README intro names the new ratio knobs"
```

---

## Self-review checklist (run before handing off)

- **Spec coverage:** every "Impact surface" row maps to a concrete step. Yes — Task 1 covers all `point_spacing` rows; Task 2 covers all `min_hex_radius`/`max_hex_radius` rows; Task 3 covers documentation.
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to above"/"write tests for the above" remain. The one conditional ("if `cells_iter()` doesn't exist…" in Task 2 step 2.1) gives a fallback strategy with concrete steps, not a placeholder.
- **Type consistency:** `nominal_hex_radius` (struct field + accessor), `min_radius_ratio`, `max_radius_ratio` — all three names are used identically across all tasks. The arithmetic site `g.nominal_hex_radius * map_noise_to_range(r_noise, g.min_radius_ratio, g.max_radius_ratio)` matches the field names. Defaults `4.0`/`0.05`/`0.65` consistent throughout.
- **Test ownership:** Task 1 adds `nominal_hex_radius_field_and_accessor_exist` (compile-time guard). Task 2 adds `ratio_bounds_produce_legacy_world_radii` (semantic guard). Visual-regression checkpoint via SVG/JSON byte-diff in steps 1.9 and 2.7.
- **Frequent commits:** one commit per task, each green-on-tests.
- **Out-of-scope (deliberate non-goals):** changing the default value of `nominal_hex_radius` from `4.0` to `1.0`; making `max_height` a ratio; renaming `point_spacing()` callers we don't own (none exist outside the crate).

---

## Open question for the user (non-blocking, can be deferred)

Once Pass 2 ships, `nominal_hex_radius`'s only remaining job is *world scale*. The `0.05`/`0.65` ratios stay constant if the user picks `1.0`, `4.0`, or `100.0` for nominal. That makes `nominal_hex_radius` a candidate to either:
1. Stay at `4.0` (current default, preserves all examples and demo camera distances) — **recommended for this plan's scope**.
2. Drop to `1.0` (cleaner mental model: "one unit per hex"), but requires coordinated rescale of `max_height: 20.0 → 5.0`, `height_noise_scale: 50.0 → 12.5`, `radius_noise_scale: 30.0 → 7.5`, and the three.js camera distance in `web/hex-terrain.html`.

Option 2 belongs in a separate plan if/when the user wants to commit to the bigger coordinate-system change.

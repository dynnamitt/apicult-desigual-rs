// Sidebar control wiring, shared by the demo pages. Reads the input values
// into a settings object, emits onLive (debounced) for cheap visual updates
// and onApply for knobs that require rebuilding the wasm meshes.
//
// A page describes its own sidebar with a schema: which inputs exist and how
// to parse them, which fields force a rebuild, which are live, and which
// toggle buttons to bind. Everything below is schema-driven, so a new page
// only adds a schema.

/**
 * @typedef {object} ControlSchema
 * @property {{id: string, field: string, parse: (raw: string) => unknown}[]} inputs
 *   `<input>` id → settings field, with the coercion from its string value.
 * @property {string[]} toggles Toggle-button keys; each binds `#btn-<key>`.
 * @property {Set<string>} rebuild Fields whose change needs `onApply`.
 * @property {Set<string>} live Fields that stream through `onLive`.
 */

/** Sidebar of `hex-terrain.html` (the three.js flower cluster). */
export const TERRAIN_SCHEMA = {
  inputs: [
    { id: "ctl-radius",          field: "radius",              parse: parseInt   },
    { id: "ctl-seed",            field: "seed",                parse: parseSeed  },
    { id: "ctl-nominal-hex-radius", field: "nominalHexRadius",  parse: parseFloat },
    { id: "ctl-petal-distance",  field: "petalDistanceFactor", parse: parseFloat },
    { id: "ctl-bloom-strength",  field: "bloomStrength",       parse: parseFloat },
    { id: "ctl-bloom-radius",    field: "bloomRadius",         parse: parseFloat },
    { id: "ctl-bloom-threshold", field: "bloomThreshold",      parse: parseFloat },
    { id: "ctl-dash-speed",      field: "dashSpeed",           parse: parseFloat },
    { id: "ctl-line-width",      field: "lineWidth",           parse: parseFloat },
  ],
  toggles: ["fill", "wire", "shader", "bands", "bridge", "flat"],
  rebuild: new Set(["radius", "seed", "nominalHexRadius", "petalDistanceFactor"]),
  live: new Set([
    "bloomStrength", "bloomRadius", "bloomThreshold", "dashSpeed", "lineWidth",
  ]),
};

/** Sidebar of `hex-crawler.html` (the Phaser crawler). */
export const CRAWLER_SCHEMA = {
  inputs: [
    { id: "ctl-radius",     field: "radius",    parse: parseInt   },
    { id: "ctl-seed",       field: "seed",      parse: parseSeed  },
    { id: "ctl-tempo",      field: "tempo",     parse: parseFloat },
    { id: "ctl-climb",      field: "climbK",    parse: parseFloat },
    { id: "ctl-band-speed", field: "bandSpeed", parse: parseFloat },
  ],
  toggles: ["trail", "bands", "base"],
  // Only the grid is baked into GPU buffers; pace and climb bite from the next
  // stage boundary, band speed from the next frame.
  rebuild: new Set(["radius", "seed"]),
  live: new Set(["tempo", "climbK", "bandSpeed"]),
};

/** Sidebar of `hex-units.html` (the Babylon.js units demo). */
export const UNITS_SCHEMA = {
  inputs: [
    { id: "ctl-radius",     field: "radius",    parse: parseInt   },
    { id: "ctl-seed",       field: "seed",      parse: parseSeed  },
    { id: "ctl-unit-count", field: "unitCount", parse: parseInt   },
    { id: "ctl-speed",      field: "speed",     parse: parseFloat },
    { id: "ctl-climb",      field: "maxClimb",  parse: parseFloat },
  ],
  toggles: ["trails", "wire", "glow"],
  // Terrain shape is baked into the wasm meshes; the unit knobs are all live —
  // count spawns/despawns, speed and climb apply from the next leg onward.
  rebuild: new Set(["radius", "seed"]),
  live: new Set(["unitCount", "speed", "maxClimb"]),
};

function parseSeed(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? (n >>> 0) : null;
}

/**
 * Snapshot the current settings from the DOM. Used at boot and on every change.
 *
 * @param {HTMLElement} rootEl The `.controls` element.
 * @param {ControlSchema} [schema] Defaults to the terrain sidebar.
 */
export function readSettingsFromDOM(rootEl, schema = TERRAIN_SCHEMA) {
  const out = {};
  for (const spec of schema.inputs) {
    const el = rootEl.querySelector(`#${spec.id}`);
    out[spec.field] = spec.parse(el?.value ?? "");
  }
  // Display flags reflect the current button .on state.
  for (const k of schema.toggles) {
    const btn = rootEl.querySelector(`#btn-${k}`);
    out[k] = !!btn?.classList.contains("on");
  }
  return out;
}

const debounce = (fn, ms) => {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
};

/**
 * Wire up all sidebar inputs and buttons.
 *
 * @param {HTMLElement} rootEl - the .controls element.
 * @param {object} cb
 * @param {object} cb.initialSettings - the snapshot used to mount the scene.
 * @param {(settings: object) => void} cb.onApply  - rebuild knobs.
 * @param {(settings: object) => void} cb.onLive   - live (visual) knobs.
 * @param {(key: string, on: boolean) => void} cb.onToggle - display flags.
 * @param {ControlSchema} [cb.schema] - the page's control surface; defaults to
 *   the terrain sidebar.
 */
export function bindControls(
  rootEl,
  { initialSettings, onApply, onLive, onToggle, schema = TERRAIN_SCHEMA },
) {
  const read = () => readSettingsFromDOM(rootEl, schema);
  const liveDispatch = debounce(() => onLive(read()), 80);

  for (const spec of schema.inputs) {
    const el = rootEl.querySelector(`#${spec.id}`);
    if (!el) continue;

    if (schema.live.has(spec.field)) {
      // Number inputs respond to both arrow-stepping (input event) and typing.
      el.addEventListener("input", liveDispatch);
    }
    if (schema.rebuild.has(spec.field)) {
      // Pressing Enter inside a rebuild input triggers Apply, mirroring the
      // common form-submit muscle memory.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onApply(read());
        }
      });
    }
  }

  rootEl.querySelector("#btn-apply")?.addEventListener("click", () => {
    onApply(read());
  });

  // Re-roll: blank the seed input so the next Apply picks fresh randomness,
  // then immediately apply.
  rootEl.querySelector("#btn-regen")?.addEventListener("click", () => {
    const seedEl = rootEl.querySelector("#ctl-seed");
    if (seedEl) seedEl.value = "";
    onApply(read());
  });

  for (const k of schema.toggles) {
    const btn = rootEl.querySelector(`#btn-${k}`);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      const next = !btn.classList.contains("on");
      btn.classList.toggle("on", next);
      onToggle(k, next);
    });
  }

  // initialSettings is the boot snapshot — captured before this binder runs;
  // accepted for symmetry and possible future use (e.g. reset-to-defaults).
  void initialSettings;
}

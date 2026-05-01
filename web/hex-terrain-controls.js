// Sidebar control wiring. Reads the textbox values into a settings object,
// emits onLive (debounced) for cheap visual updates and onApply for knobs
// that require rebuilding the wasm meshes.

const REBUILD_KEYS = new Set([
  "radius", "seed", "nominalHexRadius", "petalDistanceFactor",
]);

const LIVE_KEYS = new Set([
  "bloomStrength", "bloomRadius", "bloomThreshold", "dashSpeed", "lineWidth",
  "speed",
]);

const TOGGLE_KEYS = ["fill", "wire", "shader", "flat"];

// Wire and shader-wire are mutually exclusive — turning one on flips the
// other off. The map encodes both directions for symmetric lookup.
const WIRE_EXCLUSIVE_PAIR = { wire: "shader", shader: "wire" };

// id → (DOM value → settings field) mapping. Strings come out of <input>;
// the parser does the type coercion (number, integer, or null for empty seed).
const INPUT_SPECS = [
  { id: "ctl-radius",          field: "radius",              parse: parseInt   },
  { id: "ctl-seed",            field: "seed",                parse: parseSeed  },
  { id: "ctl-nominal-hex-radius", field: "nominalHexRadius",  parse: parseFloat },
  { id: "ctl-petal-distance",  field: "petalDistanceFactor", parse: parseFloat },
  { id: "ctl-bloom-strength",  field: "bloomStrength",       parse: parseFloat },
  { id: "ctl-bloom-radius",    field: "bloomRadius",         parse: parseFloat },
  { id: "ctl-bloom-threshold", field: "bloomThreshold",      parse: parseFloat },
  { id: "ctl-dash-speed",      field: "dashSpeed",           parse: parseFloat },
  { id: "ctl-line-width",      field: "lineWidth",           parse: parseFloat },
  { id: "ctl-speed",           field: "speed",               parse: parseFloat },
];

function parseSeed(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? (n >>> 0) : null;
}

/** Snapshot the current settings from the DOM. Used at boot and on every change. */
export function readSettingsFromDOM(rootEl) {
  const out = {};
  for (const spec of INPUT_SPECS) {
    const el = rootEl.querySelector(`#${spec.id}`);
    out[spec.field] = spec.parse(el?.value ?? "");
  }
  // Display flags reflect the current button .on state.
  for (const k of TOGGLE_KEYS) {
    const btn = rootEl.querySelector(`#btn-${k}`);
    out[k] = !!btn?.classList.contains("on");
  }
  // Active direction button. Default 0 if none is highlighted.
  const activeDirBtn = rootEl.querySelector(".dir-picker .dir.on");
  out.dirIndex = activeDirBtn ? parseInt(activeDirBtn.dataset.dir, 10) : 0;
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
 */
export function bindControls(rootEl, {
  initialSettings,
  onApply,
  onLive,
  onToggle,
  onDirection,
}) {
  const liveDispatch = debounce(() => onLive(readSettingsFromDOM(rootEl)), 80);

  for (const spec of INPUT_SPECS) {
    const el = rootEl.querySelector(`#${spec.id}`);
    if (!el) continue;

    if (LIVE_KEYS.has(spec.field)) {
      // Number inputs respond to both arrow-stepping (input event) and typing.
      el.addEventListener("input", liveDispatch);
    }
    if (REBUILD_KEYS.has(spec.field)) {
      // Pressing Enter inside a rebuild input triggers Apply, mirroring the
      // common form-submit muscle memory.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onApply(readSettingsFromDOM(rootEl));
        }
      });
    }
  }

  rootEl.querySelector("#btn-apply")?.addEventListener("click", () => {
    onApply(readSettingsFromDOM(rootEl));
  });

  // Re-roll: blank the seed input so the next Apply picks fresh randomness,
  // then immediately apply.
  rootEl.querySelector("#btn-regen")?.addEventListener("click", () => {
    const seedEl = rootEl.querySelector("#ctl-seed");
    if (seedEl) seedEl.value = "";
    onApply(readSettingsFromDOM(rootEl));
  });

  for (const k of TOGGLE_KEYS) {
    const btn = rootEl.querySelector(`#btn-${k}`);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      const next = !btn.classList.contains("on");
      btn.classList.toggle("on", next);
      onToggle(k, next);
      const peer = WIRE_EXCLUSIVE_PAIR[k];
      if (peer && next) {
        const peerBtn = rootEl.querySelector(`#btn-${peer}`);
        if (peerBtn?.classList.contains("on")) {
          peerBtn.classList.remove("on");
          onToggle(peer, false);
        }
      }
    });
  }

  const dirButtons = rootEl.querySelectorAll(".dir-picker .dir");
  for (const btn of dirButtons) {
    btn.addEventListener("click", () => {
      for (const b of dirButtons) b.classList.remove("on");
      btn.classList.add("on");
      const d = parseInt(btn.dataset.dir, 10);
      onDirection?.(d);
    });
  }

  // initialSettings is the boot snapshot — captured before this binder runs;
  // accepted for symmetry and possible future use (e.g. reset-to-defaults).
  void initialSettings;
}

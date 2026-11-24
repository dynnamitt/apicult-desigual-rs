/**
 * Canvas helpers shared by the demo pages. No engine imports, so the resize
 * decision runs under plain node.
 */

/**
 * Show `msg` as an `.error-msg` paragraph right after `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {string} msg
 * @returns {void}
 */
export const showError = (canvas, msg) => {
  const p = document.createElement("p");
  p.className = "error-msg";
  p.textContent = msg;
  canvas.insertAdjacentElement("afterend", p);
};

/**
 * Whether the drawing buffer no longer matches the canvas's CSS size at
 * `pixelRatio`. Compares device px to device px: `canvas.width` is what
 * `renderer.setSize(w, h, false)` set, i.e. `floor(w * pixelRatio)`.
 * @param {{width: number, height: number, clientWidth: number, clientHeight: number}} canvas
 * @param {number} pixelRatio `renderer.getPixelRatio()`
 * @returns {boolean}
 */
export const needsResize = (canvas, pixelRatio) =>
  canvas.width !== Math.floor(canvas.clientWidth * pixelRatio)
  || canvas.height !== Math.floor(canvas.clientHeight * pixelRatio);

/**
 * Call `frame` on every animation frame. A throw stops the loop and shows
 * `label: message` after `canvas`, instead of repeating every frame unseen.
 * @param {HTMLCanvasElement} canvas
 * @param {string} label e.g. `"stream frame failed"`
 * @param {(now: number|undefined) => void} frame
 * @returns {void}
 */
export const runFrames = (canvas, label, frame) => {
  const tick = (now) => {
    try {
      frame(now);
      requestAnimationFrame(tick);
    } catch (e) {
      console.error(e);
      showError(canvas, `${label}: ${e.message}`);
    }
  };
  tick();
};

/**
 * Canvas helpers shared by the demo pages. No engine imports, so the resize
 * decision runs under plain node.
 */

/**
 * Show `msg` as an `.error-msg` paragraph right after `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {string} msg
 * @returns {HTMLParagraphElement} the inserted paragraph, so a caller can remove it.
 */
export const showError = (canvas, msg) => {
  const p = document.createElement("p");
  p.className = "error-msg";
  p.textContent = msg;
  canvas.insertAdjacentElement("afterend", p);
  return p;
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
 * Call `frame` on every animation frame. While frames throw, `label: message`
 * shows after `canvas` (logged once, not every frame); the next good frame
 * removes it, so a rebuild (Apply) can recover the page.
 * @param {HTMLCanvasElement} canvas
 * @param {string} label e.g. `"stream frame failed"`
 * @param {(now: number|undefined) => void} frame
 * @returns {void}
 */
export const runFrames = (canvas, label, frame) => {
  let shown = null;
  const tick = (now) => {
    requestAnimationFrame(tick);
    try {
      frame(now);
      shown?.remove();
      shown = null;
    } catch (e) {
      if (shown) return;
      console.error(e);
      shown = showError(canvas, `${label}: ${e.message}`);
    }
  };
  tick();
};

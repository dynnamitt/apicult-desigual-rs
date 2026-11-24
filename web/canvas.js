/**
 * Canvas helpers shared by the three.js pages. No engine imports, so the
 * resize decision runs under plain node.
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

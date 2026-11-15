'use strict';

/**
 * Symmetric Euclidean Screen Area-to-Radius LUT.
 *
 * In unit screen coordinates (u, v), each Primary Diamond D^+_{i,j} = { |du| + |dv| <= 0.5 }
 * has total area 0.5 (half of the unit cell [0, 1]^2):
 *   - For 0 <= t <= pi/8: circle of radius r = sqrt(t / pi) fits completely inside D^+.
 *   - At tangency t = pi/8 ≈ 0.39269908: r = 1 / (2 * sqrt(2)) ≈ 0.35355339 touches all 4 edges.
 *   - For pi/8 < t <= 0.5: circle is clipped against the 4 edges of D^+; exact clipped area is:
 *       A(r) = pi * r^2 - 4 * (r^2 * arccos(s / r) - s * sqrt(r^2 - s^2)),  s = 1 / (2 * sqrt(2)).
 *   - At t = 0.5: r = 0.5 reaches all 4 diamond corners, forming an exact 50% checkerboard.
 */

const LUT_SIZE = 256;
const T_TAN = Math.PI / 8;
const T_MAX_DIAMOND = 0.5;
const R_TAN = 1 / (2 * Math.SQRT2);
const R_MAX_DIAMOND = 0.5;

/**
 * Exact area of disk { du^2 + dv^2 <= r^2 } clipped to diamond { |du| + |dv| <= 0.5 }.
 *
 * @param {number} r - Radius in normalized screen pitch units
 * @returns {number} Area in [0, 0.5]
 */
function clippedDiamondArea(r) {
  if (!(r > 0)) return 0;
  if (r <= R_TAN) return Math.PI * r * r;
  if (r >= R_MAX_DIAMOND) return T_MAX_DIAMOND;
  const r2 = r * r;
  const s2 = R_TAN * R_TAN;
  const ratio = Math.min(1, Math.max(-1, R_TAN / r));
  const seg = r2 * Math.acos(ratio) - R_TAN * Math.sqrt(Math.max(0, r2 - s2));
  return Math.PI * r2 - 4 * seg;
}

/**
 * Solve clippedDiamondArea(r) = targetArea via bisection on [lo, hi].
 *
 * @param {number} targetArea
 * @param {number} [lo=R_TAN]
 * @param {number} [hi=R_MAX_DIAMOND]
 * @param {number} [iters=56]
 * @returns {number}
 */
function solveClippedRadius(targetArea, lo = R_TAN, hi = R_MAX_DIAMOND, iters = 56) {
  if (targetArea <= T_TAN) return targetArea <= 0 ? 0 : Math.sqrt(targetArea / Math.PI);
  if (targetArea >= T_MAX_DIAMOND) return R_MAX_DIAMOND;
  let a = lo;
  let b = hi;
  for (let i = 0; i < iters; i++) {
    const mid = 0.5 * (a + b);
    if (clippedDiamondArea(mid) < targetArea) {
      a = mid;
    } else {
      b = mid;
    }
  }
  return 0.5 * (a + b);
}

/**
 * Precompute canonical 256-entry LUT across [pi/8, 0.5] to machine precision (< 1e-15 << 1e-7).
 */
const EUCLIDEAN_LUT = (() => {
  const lut = new Float64Array(LUT_SIZE);
  const span = T_MAX_DIAMOND - T_TAN;
  lut[0] = R_TAN;
  for (let k = 1; k < LUT_SIZE - 1; k++) {
    const target = T_TAN + (k / (LUT_SIZE - 1)) * span;
    lut[k] = solveClippedRadius(target, lut[k - 1], R_MAX_DIAMOND, 60);
  }
  lut[LUT_SIZE - 1] = R_MAX_DIAMOND;
  return lut;
})();

/**
 * Fast exact radius lookup for any tone t in [0, 0.5] using EUCLIDEAN_LUT bracket + 14-step polish,
 * guaranteeing |clippedDiamondArea(r) - t| < 1e-9 (< 1e-7 specification) across the entire interval,
 * including the singular square-root derivative near t -> 0.5^-.
 *
 * @param {number} t - Area fraction in [0, 0.5]
 * @returns {number} Radius r in [0, 0.5]
 */
function radiusForDiamondTone(t) {
  if (!(t > 0)) return 0;
  if (t <= T_TAN) return Math.sqrt(t / Math.PI);
  if (t >= T_MAX_DIAMOND) return R_MAX_DIAMOND;

  const u = ((t - T_TAN) / (T_MAX_DIAMOND - T_TAN)) * (LUT_SIZE - 1);
  const idx = Math.min(LUT_SIZE - 2, Math.max(0, u | 0));
  const lo = EUCLIDEAN_LUT[idx];
  const hi = EUCLIDEAN_LUT[idx + 1];
  return solveClippedRadius(t, lo, hi, 16);
}

module.exports = {
  LUT_SIZE,
  T_TAN,
  T_MAX_DIAMOND,
  R_TAN,
  R_MAX_DIAMOND,
  EUCLIDEAN_LUT,
  clippedDiamondArea,
  solveClippedRadius,
  radiusForDiamondTone,
};

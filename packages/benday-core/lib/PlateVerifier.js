'use strict';

const { getCanonicalDiskOffsets } = require('./MeshPhysics');

/**
 * Independent Morphological Opening Oracle using direct canonical disk offsets (zero shared code
 * with HalftoneEngine's row-span implementation so bugs in HalftoneEngine cannot mask themselves).
 *
 * A pixel q is 255 in openByCanonicalDisk(mask) iff there exists an anchor (ax, ay) such that
 * every (ax + off.dx, ay + off.dy) for off in diskOffsets lies inside [0, width) x [0, height)
 * and is nonzero in mask, and q is one of those covered pixels.
 *
 * @param {Uint8Array|Uint8ClampedArray} mask
 * @param {number} width
 * @param {number} height
 * @param {ReadonlyArray<{dx: number, dy: number}>} diskOffsets
 * @returns {Uint8Array}
 */
function openByCanonicalDisk(mask, width, height, diskOffsets) {
  const N = width * height;
  const out = new Uint8Array(N);
  const K = diskOffsets.length;
  if (K === 0 || N === 0) return out;

  // Order check offsets with (0, 0) first and extreme boundary points next for fast early exit,
  // using flat Int32Arrays totally independent of HalftoneEngine's span structures.
  const sorted = Array.from(diskOffsets).sort((a, b) => {
    if (a.dx === 0 && a.dy === 0) return -1;
    if (b.dx === 0 && b.dy === 0) return 1;
    return b.dx * b.dx + b.dy * b.dy - (a.dx * a.dx + a.dy * b.dy);
  });

  const offDx = new Int32Array(K);
  const offDy = new Int32Array(K);
  let minDx = 0;
  let maxDx = 0;
  let minDy = 0;
  let maxDy = 0;
  for (let k = 0; k < K; k++) {
    const dx = sorted[k].dx;
    const dy = sorted[k].dy;
    offDx[k] = dx;
    offDy[k] = dy;
    if (dx < minDx) minDx = dx;
    if (dx > maxDx) maxDx = dx;
    if (dy < minDy) minDy = dy;
    if (dy > maxDy) maxDy = dy;
  }

  const xStart = Math.max(0, -minDx);
  const xEnd = Math.min(width - 1, width - 1 - maxDx);
  const yStart = Math.max(0, -minDy);
  const yEnd = Math.min(height - 1, height - 1 - maxDy);
  if (xStart > xEnd || yStart > yEnd) return out;

  // Direct erosion + immediate stamp dilation per valid anchor
  for (let ay = yStart; ay <= yEnd; ay++) {
    for (let ax = xStart; ax <= xEnd; ax++) {
      let fits = true;
      for (let k = 0; k < K; k++) {
        if (!mask[(ay + offDy[k]) * width + (ax + offDx[k])]) {
          fits = false;
          break;
        }
      }
      if (fits) {
        for (let k = 0; k < K; k++) {
          out[(ay + offDy[k]) * width + (ax + offDx[k])] = 255;
        }
      }
    }
  }

  return out;
}

/**
 * Compute O(W * H) Chebyshev (L_infinity) neighborhood of radii (radiusX, radiusY) around srcUint8[p] > 0
 * via two separable 1D sliding-window passes.
 *
 * @param {Uint8Array|Uint8ClampedArray} srcUint8
 * @param {number} width
 * @param {number} height
 * @param {number} radiusX
 * @param {number} [radiusY=radiusX]
 * @returns {Uint8Array} 1 where Chebyshev box around (src > 0) covers pixel, else 0
 */
function computeChebyshevPositiveNeighborhood(srcUint8, width, height, radiusX, radiusY = radiusX) {
  const N = width * height;
  const rX = Math.max(0, Math.ceil(radiusX));
  const rY = Math.max(0, Math.ceil(radiusY == null ? radiusX : radiusY));
  const horiz = new Uint8Array(N);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let lastPos = -1e9;
    for (let x = 0; x < width; x++) {
      if (srcUint8[rowOff + x] > 0) lastPos = x;
      if (x - lastPos <= rX) horiz[rowOff + x] = 1;
    }
    let nextPos = 1e9;
    for (let x = width - 1; x >= 0; x--) {
      if (srcUint8[rowOff + x] > 0) nextPos = x;
      if (nextPos - x <= rX) horiz[rowOff + x] = 1;
    }
  }

  // Vertical pass
  const out = new Uint8Array(N);
  for (let x = 0; x < width; x++) {
    let lastPos = -1e9;
    for (let y = 0; y < height; y++) {
      if (horiz[y * width + x]) lastPos = y;
      if (y - lastPos <= rY) out[y * width + x] = 1;
    }
    let nextPos = 1e9;
    for (let y = height - 1; y >= 0; y--) {
      if (horiz[y * width + x]) nextPos = y;
      if (nextPos - y <= rY) out[y * width + x] = 1;
    }
  }

  return out;
}

/**
 * Independent Mathematical & Physical Invariant Auditor for Halftone Screens.
 *
 * Verifies:
 *   1. binaryPure: Every byte in plateUint8 is strictly 0 or 255.
 *   2. minDotViolations: Every foreground (255) pixel not belonging/connected to M_solid
 *      (src === 255) is covered by at least one full canonical disk B_{D_min} <= foreground.
 *   3. minHoleViolations: Every enclosed interior background (0) hole (not 4-connected to canvas
 *      exterior, excluding pure {0, 255} graphic counters bounded strictly by M_solid) is covered
 *      by full canonical disks B_{D_min} <= hole.
 *   4. solidPreservationViolations: Every src[p] === 255 pixel has plate[p] === 255.
 *   5. paperBleedViolations:
 *      - On pure {0, 255} graphic inputs: any pixel where src[p] === 0 && plate[p] !== 0.
 *      - On continuous-tone inputs: any foreground pixel that EITHER belongs to a floating
 *        component overlapping zero src > 0 pixels OR lies outside the Chebyshev (L_infinity)
 *        neighborhood of radius max(2 * dMinPx, ceil(cellPitchPx)) around src > 0.
 *
 * @param {Uint8Array|Uint8ClampedArray} plateUint8
 * @param {number} width
 * @param {number} height
 * @param {object} spec
 * @param {number} spec.dMinPx
 * @param {number} [spec.aMinPx]
 * @param {number} [spec.cellPitchPx]
 * @param {Uint8Array|Uint8ClampedArray} [spec.srcUint8]
 * @returns {object}
 */
function verifyPlateInvariants(plateUint8, width, height, spec = {}) {
  const N = width * height;
  if (!plateUint8 || plateUint8.length !== N) {
    throw new Error(
      `verifyPlateInvariants: expected length ${N}, got ${plateUint8 ? plateUint8.length : 'null'}`
    );
  }

  const dMinPxX = Math.max(1, Math.round(spec.dMinPxX || spec.dMinPx || 1));
  const dMinPxY = Math.max(1, Math.round(spec.dMinPxY || spec.dMinPx || 1));
  const dMinPx = Math.min(dMinPxX, dMinPxY);
  const diskOffsets = getCanonicalDiskOffsets(dMinPxX, dMinPxY);
  const aMinPx = spec.aMinPx || diskOffsets.length;
  const cellPitchPxX = spec.cellPitchPxX || spec.cellPitchPx || Math.SQRT2 * dMinPxX;
  const cellPitchPxY = spec.cellPitchPxY || spec.cellPitchPx || Math.SQRT2 * dMinPxY;
  const cellPitchPx = spec.cellPitchPx || Math.min(cellPitchPxX, cellPitchPxY);
  const srcUint8 = spec.srcUint8 || null;

  // 1. Binary purity check
  let nonBinaryCount = 0;
  let inkPixels = 0;
  for (let p = 0; p < N; p++) {
    const v = plateUint8[p];
    if (v === 255) {
      inkPixels++;
    } else if (v !== 0) {
      nonBinaryCount++;
    }
  }
  const binaryPure = nonBinaryCount === 0;

  // Classify srcUint8 if provided
  let solidPreservationViolations = 0;
  let isPureBinarySrc = false;
  const mSolid = new Uint8Array(N);
  const solidConnectedFg = new Uint8Array(N);

  if (srcUint8) {
    if (srcUint8.length !== N) {
      throw new Error(`verifyPlateInvariants: srcUint8 length ${srcUint8.length} !== ${N}`);
    }
    let midtones = 0;
    const queue = new Int32Array(N);
    let head = 0;
    let tail = 0;

    for (let p = 0; p < N; p++) {
      const sv = srcUint8[p];
      if (sv === 255) {
        mSolid[p] = 1;
        if (plateUint8[p] !== 255) {
          solidPreservationViolations++;
        } else {
          solidConnectedFg[p] = 1;
          queue[tail++] = p;
        }
      } else if (sv !== 0) {
        midtones++;
      }
    }
    isPureBinarySrc = midtones === 0;

    // Mark foreground pixels 8-connected to M_solid
    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (plateUint8[np] === 255 && !solidConnectedFg[np]) {
            solidConnectedFg[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }
  }

  // 2. Minimum positive dot check (independent B_{D_min} opening on non-solid foreground)
  const openedFg = openByCanonicalDisk(plateUint8, width, height, diskOffsets);
  let minDotViolations = 0;
  for (let p = 0; p < N; p++) {
    if (plateUint8[p] === 255 && !openedFg[p] && !solidConnectedFg[p]) {
      minDotViolations++;
    }
  }

  // 3. Minimum negative hole check (independent B_{D_min} opening on enclosed interior 0-holes)
  const visitedZero = new Uint8Array(N);
  const bfs = new Int32Array(N);
  let head = 0;
  let tail = 0;

  for (let x = 0; x < width; x++) {
    if (plateUint8[x] === 0 && !visitedZero[x]) {
      visitedZero[x] = 1;
      bfs[tail++] = x;
    }
    const bot = (height - 1) * width + x;
    if (plateUint8[bot] === 0 && !visitedZero[bot]) {
      visitedZero[bot] = 1;
      bfs[tail++] = bot;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    const left = y * width;
    const right = left + width - 1;
    if (plateUint8[left] === 0 && !visitedZero[left]) {
      visitedZero[left] = 1;
      bfs[tail++] = left;
    }
    if (plateUint8[right] === 0 && !visitedZero[right]) {
      visitedZero[right] = 1;
      bfs[tail++] = right;
    }
  }

  while (head < tail) {
    const p = bfs[head++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0 && plateUint8[p - 1] === 0 && !visitedZero[p - 1]) {
      visitedZero[p - 1] = 1;
      bfs[tail++] = p - 1;
    }
    if (x + 1 < width && plateUint8[p + 1] === 0 && !visitedZero[p + 1]) {
      visitedZero[p + 1] = 1;
      bfs[tail++] = p + 1;
    }
    if (y > 0 && plateUint8[p - width] === 0 && !visitedZero[p - width]) {
      visitedZero[p - width] = 1;
      bfs[tail++] = p - width;
    }
    if (y + 1 < height && plateUint8[p + width] === 0 && !visitedZero[p + width]) {
      visitedZero[p + width] = 1;
      bfs[tail++] = p + width;
    }
  }

  const enclosedHoleMask = new Uint8Array(N);
  let enclosedHoleComponents = 0;

  for (let start = 0; start < N; start++) {
    if (plateUint8[start] !== 0 || visitedZero[start]) continue;
    head = 0;
    tail = 0;
    visitedZero[start] = 2;
    bfs[tail++] = start;

    let allZeroSrc = srcUint8 ? 1 : 0;
    let boundedOnlyBySolid = srcUint8 ? 1 : 0;

    while (head < tail) {
      const p = bfs[head++];
      if (allZeroSrc && srcUint8[p] !== 0) allZeroSrc = 0;
      const x = p % width;
      const y = (p - x) / width;

      const neighbors = [];
      if (x > 0) neighbors.push(p - 1);
      if (x + 1 < width) neighbors.push(p + 1);
      if (y > 0) neighbors.push(p - width);
      if (y + 1 < height) neighbors.push(p + width);

      for (let ni = 0; ni < neighbors.length; ni++) {
        const nb = neighbors[ni];
        if (plateUint8[nb] === 0) {
          if (!visitedZero[nb]) {
            visitedZero[nb] = 2;
            bfs[tail++] = nb;
          }
        } else if (boundedOnlyBySolid && !mSolid[nb]) {
          boundedOnlyBySolid = 0;
        }
      }
    }

    if (!(allZeroSrc === 1 && boundedOnlyBySolid === 1)) {
      enclosedHoleComponents++;
      for (let k = 0; k < tail; k++) {
        enclosedHoleMask[bfs[k]] = 255;
      }
    }
  }

  const openedHoles = openByCanonicalDisk(enclosedHoleMask, width, height, diskOffsets);
  let minHoleViolations = 0;
  for (let p = 0; p < N; p++) {
    if (enclosedHoleMask[p] && !openedHoles[p]) {
      minHoleViolations++;
    }
  }

  // 4. Paper bleed check (both floating components AND spatial Chebyshev radius bound)
  let paperBleedViolations = 0;
  if (srcUint8) {
    if (isPureBinarySrc) {
      for (let p = 0; p < N; p++) {
        if (srcUint8[p] === 0 && plateUint8[p] !== 0) {
          paperBleedViolations++;
        }
      }
    } else {
      const maxBleedRadiusX = Math.max(2 * dMinPxX, Math.ceil(cellPitchPxX));
      const maxBleedRadiusY = Math.max(2 * dMinPxY, Math.ceil(cellPitchPxY));
      const nearPositiveSrc = computeChebyshevPositiveNeighborhood(
        srcUint8,
        width,
        height,
        maxBleedRadiusX,
        maxBleedRadiusY
      );
      const bleedFlagged = new Uint8Array(N);

      // Flag any ink pixel strictly outside the Chebyshev neighborhood of src > 0
      for (let p = 0; p < N; p++) {
        if (plateUint8[p] === 255 && !nearPositiveSrc[p]) {
          bleedFlagged[p] = 1;
          paperBleedViolations++;
        }
      }

      // Also flag any floating 8-connected ink component that has zero overlap with src > 0
      const seenFg = new Uint8Array(N);
      for (let start = 0; start < N; start++) {
        if (plateUint8[start] !== 255 || seenFg[start]) continue;
        head = 0;
        tail = 0;
        seenFg[start] = 1;
        bfs[tail++] = start;
        let touchesPositiveSrc = false;

        while (head < tail) {
          const p = bfs[head++];
          if (srcUint8[p] > 0) touchesPositiveSrc = true;
          const x = p % width;
          const y = (p - x) / width;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const np = ny * width + nx;
              if (plateUint8[np] === 255 && !seenFg[np]) {
                seenFg[np] = 1;
                bfs[tail++] = np;
              }
            }
          }
        }

        if (!touchesPositiveSrc) {
          for (let k = 0; k < tail; k++) {
            const q = bfs[k];
            if (!bleedFlagged[q]) {
              bleedFlagged[q] = 1;
              paperBleedViolations++;
            }
          }
        }
      }
    }
  }

  const ok =
    binaryPure &&
    minDotViolations === 0 &&
    minHoleViolations === 0 &&
    paperBleedViolations === 0 &&
    solidPreservationViolations === 0;

  return {
    ok,
    binaryPure,
    nonBinaryCount,
    minDotViolations,
    minHoleViolations,
    paperBleedViolations,
    solidPreservationViolations,
    dMinPx,
    dMinPxX,
    dMinPxY,
    aMinPx,
    cellPitchPx,
    cellPitchPxX,
    cellPitchPxY,
    inkPixels,
    inkCoverage: N > 0 ? inkPixels / N : 0,
    enclosedHoleComponents,
  };
}

module.exports = {
  openByCanonicalDisk,
  computeChebyshevPositiveNeighborhood,
  verifyPlateInvariants,
  verifyScreenInvariants: verifyPlateInvariants,
};

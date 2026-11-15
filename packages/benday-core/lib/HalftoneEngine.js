'use strict';

const { computeMeshSpec, getCanonicalDiskOffsets } = require('./MeshPhysics');
const { computeRosetteAngles, analyzeMoire, norm90 } = require('./RosetteAngles');
const { radiusForDiamondTone } = require('./EuclideanLut');

const TAIL_MODES = Object.freeze(['hybrid', 'cutoff', 'clamp']);

const CHANNEL_SEEDS = Object.freeze({
  C: 0x243f6a88,
  M: 0x85a308d3,
  Y: 0x13198a2e,
  K: 0x03707344,
});

// Cache horizontal span decompositions of canonical disk B_D for O(W*H) morphology
const _spanCache = new Map();

/**
 * Convert canonical disk B_D offsets into contiguous horizontal row spans [dxMin, dxMax] per dy.
 * Ordering places dy=0 first for fast-fail during erosion.
 *
 * @param {number} dMinPxX
 * @param {number} [dMinPxY=dMinPxX]
 * @returns {ReadonlyArray<{dy: number, dxMin: number, dxMax: number, len: number}>}
 */
function getDiskRowSpans(dMinPxX, dMinPxY = dMinPxX) {
  const DX = Math.max(1, Math.round(dMinPxX));
  const DY = Math.max(1, Math.round(dMinPxY == null ? DX : dMinPxY));
  const key = DX === DY ? DX : `${DX}x${DY}`;
  if (_spanCache.has(key)) return _spanCache.get(key);

  const offsets = getCanonicalDiskOffsets(DX, DY);
  const byDy = new Map();
  for (let i = 0; i < offsets.length; i++) {
    const { dx, dy } = offsets[i];
    const cur = byDy.get(dy);
    if (!cur) {
      byDy.set(dy, { dxMin: dx, dxMax: dx });
    } else {
      if (dx < cur.dxMin) cur.dxMin = dx;
      if (dx > cur.dxMax) cur.dxMax = dx;
    }
  }

  const spans = [];
  for (const [dy, { dxMin, dxMax }] of byDy.entries()) {
    spans.push(Object.freeze({ dy, dxMin, dxMax, len: dxMax - dxMin + 1 }));
  }
  // Put dy = 0 first, then extreme top/bottom rows for fastest early exit in erosion
  spans.sort((a, b) => {
    if (a.dy === 0) return -1;
    if (b.dy === 0) return 1;
    return Math.abs(b.dy) - Math.abs(a.dy);
  });

  const frozen = Object.freeze(spans);
  _spanCache.set(key, frozen);
  return frozen;
}

/**
 * Exact O(W * H) morphological erosion of binary mask (nonzero = 1) by canonical disk B_D.
 * An anchor (x, y) is 1 iff (x + dx, y + dy) is in-bounds and nonzero in mask for all (dx, dy) in B_D.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {ReadonlyArray<{dy: number, dxMin: number, dxMax: number, len: number}>} spans
 * @returns {Uint8Array}
 */
function erodeByDiskSpans(mask, width, height, spans) {
  const N = width * height;
  const runLen = new Int32Array(N);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let run = 0;
    for (let x = 0; x < width; x++) {
      if (mask[rowOff + x]) {
        run++;
      } else {
        run = 0;
      }
      runLen[rowOff + x] = run;
    }
  }

  const eroded = new Uint8Array(N);
  const spanCount = spans.length;

  // Determine safe y bounds so ny is always inside [0, height)
  let minDy = 0;
  let maxDy = 0;
  let minDx = 0;
  let maxDx = 0;
  for (let s = 0; s < spanCount; s++) {
    const sp = spans[s];
    if (sp.dy < minDy) minDy = sp.dy;
    if (sp.dy > maxDy) maxDy = sp.dy;
    if (sp.dxMin < minDx) minDx = sp.dxMin;
    if (sp.dxMax > maxDx) maxDx = sp.dxMax;
  }

  const yStart = Math.max(0, -minDy);
  const yEnd = Math.min(height - 1, height - 1 - maxDy);
  const xStart = Math.max(0, -minDx);
  const xEnd = Math.min(width - 1, width - 1 - maxDx);

  if (yStart > yEnd || xStart > xEnd) {
    return eroded;
  }

  for (let y = yStart; y <= yEnd; y++) {
    const rowOff = y * width;
    for (let x = xStart; x <= xEnd; x++) {
      let ok = 1;
      for (let s = 0; s < spanCount; s++) {
        const sp = spans[s];
        const endX = x + sp.dxMax;
        if (runLen[(y + sp.dy) * width + endX] < sp.len) {
          ok = 0;
          break;
        }
      }
      eroded[rowOff + x] = ok;
    }
  }

  return eroded;
}

/**
 * Exact O(W * H) morphological dilation of anchor mask (nonzero = 1) by canonical disk B_D.
 * Precomputes compact horizontal runs per source row and reuses a single L1-cached row difference
 * buffer (width + 2 ints), keeping scratch memory tiny even on 7200x10800 posters.
 * Outputs 255 for foreground, 0 for background.
 *
 * @param {Uint8Array} anchors
 * @param {number} width
 * @param {number} height
 * @param {ReadonlyArray<{dy: number, dxMin: number, dxMax: number, len: number}>} spans
 * @returns {Uint8Array}
 */
function dilateByDiskSpans(anchors, width, height, spans) {
  const N = width * height;
  const out = new Uint8Array(N);
  const spanCount = spans.length;

  // Extract contiguous 1-runs [x0, x1] per source row
  const rowRuns = new Array(height);
  let anyRun = false;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let runs = null;
    let x = 0;
    while (x < width) {
      if (!anchors[rowOff + x]) {
        x++;
        continue;
      }
      const x0 = x;
      while (x + 1 < width && anchors[rowOff + x + 1]) {
        x++;
      }
      const x1 = x;
      x++;
      if (!runs) runs = [];
      runs.push(x0, x1);
      anyRun = true;
    }
    rowRuns[y] = runs;
  }

  if (!anyRun) return out;

  const rowDiff = new Int32Array(width + 2);

  for (let ty = 0; ty < height; ty++) {
    let touched = false;
    for (let s = 0; s < spanCount; s++) {
      const sp = spans[s];
      const sy = ty - sp.dy;
      if (sy < 0 || sy >= height) continue;
      const runs = rowRuns[sy];
      if (!runs) continue;
      for (let r = 0; r < runs.length; r += 2) {
        const left = Math.max(0, runs[r] + sp.dxMin);
        const right = Math.min(width - 1, runs[r + 1] + sp.dxMax);
        if (left <= right) {
          rowDiff[left] += 1;
          rowDiff[right + 1] -= 1;
          touched = true;
        }
      }
    }

    if (touched) {
      const oRow = ty * width;
      let cov = 0;
      for (let x = 0; x < width; x++) {
        cov += rowDiff[x];
        rowDiff[x] = 0;
        if (cov > 0) out[oRow + x] = 255;
      }
      rowDiff[width] = 0;
      rowDiff[width + 1] = 0;
    }
  }

  return out;
}

/**
 * Exact morphological opening gamma_{B_D}(mask) = dilate(erode(mask, B_D), B_D).
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {ReadonlyArray<{dy: number, dxMin: number, dxMax: number, len: number}>} spans
 * @returns {Uint8Array}
 */
function openByDiskSpans(mask, width, height, spans) {
  const eroded = erodeByDiskSpans(mask, width, height, spans);
  return dilateByDiskSpans(eroded, width, height, spans);
}

/**
 * Deterministic 32-bit integer hash jitter in [-0.03, +0.03] seeded by (channelSeed, i, j).
 *
 * @param {number} channelSeed
 * @param {number} i
 * @param {number} j
 * @returns {number}
 */
function hashJitter(channelSeed, i, j) {
  let h = (channelSeed ^ Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(j | 0, 0x85ebca77)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  const u32 = (h ^ (h >>> 16)) >>> 0;
  return ((u32 / 4294967295) * 2 - 1) * 0.03;
}

/**
 * Resolve deterministic 32-bit seed from channelKey ('C', 'M', 'Y', 'K' or arbitrary string).
 *
 * @param {string} channelKey
 * @returns {number}
 */
function getChannelSeed(channelKey) {
  if (channelKey && Object.prototype.hasOwnProperty.call(CHANNEL_SEEDS, channelKey)) {
    return CHANNEL_SEEDS[channelKey];
  }
  const str = String(channelKey || 'K');
  let h = 0x811c9dc5;
  for (let idx = 0; idx < str.length; idx++) {
    h ^= str.charCodeAt(idx);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Snap continuous center (cx, cy) to canonical integer anchor (ax, ay) for disk B_D:
 *   - Odd D:  B_D centered at (ax + 0.5, ay + 0.5) => ax = floor(cx), ay = floor(cy)
 *   - Even D: B_D centered at (ax, ay)             => ax = round(cx), ay = round(cy)
 */
function snapAnchorX(cx, isOddD) {
  return isOddD ? Math.floor(cx) : Math.round(cx);
}
function snapAnchorY(cy, isOddD) {
  return isOddD ? Math.floor(cy) : Math.round(cy);
}

/**
 * Identify enclosed interior background (plate === 0) components via 4-connected border flood-fill,
 * separating halftone shadow holes from pure {0, 255} graphic counters bounded strictly by M_solid.
 *
 * @param {Uint8Array} plate
 * @param {Uint8Array} srcUint8
 * @param {Uint8Array} mSolid
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} Mask (255 = enclosed halftone hole pixel, 0 = exterior or pure graphic counter)
 */
function extractHalftoneEnclosedHoles(plate, srcUint8, mSolid, width, height) {
  const N = width * height;
  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;

  // 1. Mark all 0-pixels reachable from the 4 canvas borders (exterior paper)
  for (let x = 0; x < width; x++) {
    if (plate[x] === 0 && !visited[x]) {
      visited[x] = 1;
      queue[tail++] = x;
    }
    const bot = (height - 1) * width + x;
    if (plate[bot] === 0 && !visited[bot]) {
      visited[bot] = 1;
      queue[tail++] = bot;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    const left = y * width;
    const right = left + width - 1;
    if (plate[left] === 0 && !visited[left]) {
      visited[left] = 1;
      queue[tail++] = left;
    }
    if (plate[right] === 0 && !visited[right]) {
      visited[right] = 1;
      queue[tail++] = right;
    }
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0 && plate[p - 1] === 0 && !visited[p - 1]) {
      visited[p - 1] = 1;
      queue[tail++] = p - 1;
    }
    if (x + 1 < width && plate[p + 1] === 0 && !visited[p + 1]) {
      visited[p + 1] = 1;
      queue[tail++] = p + 1;
    }
    if (y > 0 && plate[p - width] === 0 && !visited[p - width]) {
      visited[p - width] = 1;
      queue[tail++] = p - width;
    }
    if (y + 1 < height && plate[p + width] === 0 && !visited[p + width]) {
      visited[p + width] = 1;
      queue[tail++] = p + width;
    }
  }

  // 2. Inspect each remaining enclosed 0-component
  const holeMask = new Uint8Array(N);
  for (let start = 0; start < N; start++) {
    if (plate[start] !== 0 || visited[start]) continue;

    head = 0;
    tail = 0;
    visited[start] = 2;
    queue[tail++] = start;

    let allZeroSrc = srcUint8 ? 1 : 0;
    let boundedOnlyBySolid = srcUint8 ? 1 : 0;

    while (head < tail) {
      const p = queue[head++];
      if (allZeroSrc && srcUint8[p] !== 0) {
        allZeroSrc = 0;
      }

      const x = p % width;
      const y = (p - x) / width;

      // 4-neighbors: either part of this 0-component or a bounding 255 pixel
      if (x > 0) {
        const nb = p - 1;
        if (plate[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (boundedOnlyBySolid && !mSolid[nb]) {
          boundedOnlyBySolid = 0;
        }
      }
      if (x + 1 < width) {
        const nb = p + 1;
        if (plate[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (boundedOnlyBySolid && !mSolid[nb]) {
          boundedOnlyBySolid = 0;
        }
      }
      if (y > 0) {
        const nb = p - width;
        if (plate[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (boundedOnlyBySolid && !mSolid[nb]) {
          boundedOnlyBySolid = 0;
        }
      }
      if (y + 1 < height) {
        const nb = p + width;
        if (plate[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (boundedOnlyBySolid && !mSolid[nb]) {
          boundedOnlyBySolid = 0;
        }
      }
    }

    const isPureGraphicCounter = allZeroSrc === 1 && boundedOnlyBySolid === 1;
    if (!isPureGraphicCounter) {
      for (let k = 0; k < tail; k++) {
        holeMask[queue[k]] = 255;
      }
    }
  }

  return holeMask;
}

/**
 * Extract pure {0, 255} graphic counters directly from source ink & M_solid (enclosed 4-connected
 * components of srcUint8 === 0 whose non-zero 4-neighbors all belong to M_solid) so neither cell
 * rasterization nor Stage 6 bridge-stamping ever plugs fine knockout type/marks inside solid ink.
 */
function extractPureGraphicCounters(srcUint8, mSolid, width, height) {
  const N = width * height;
  const counterMask = new Uint8Array(N);
  if (!srcUint8) return counterMask;

  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0;
  let tail = 0;

  for (let x = 0; x < width; x++) {
    if (srcUint8[x] === 0 && !visited[x]) {
      visited[x] = 1;
      queue[tail++] = x;
    }
    const bot = (height - 1) * width + x;
    if (srcUint8[bot] === 0 && !visited[bot]) {
      visited[bot] = 1;
      queue[tail++] = bot;
    }
  }
  for (let y = 1; y < height - 1; y++) {
    const left = y * width;
    const right = left + width - 1;
    if (srcUint8[left] === 0 && !visited[left]) {
      visited[left] = 1;
      queue[tail++] = left;
    }
    if (srcUint8[right] === 0 && !visited[right]) {
      visited[right] = 1;
      queue[tail++] = right;
    }
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0 && srcUint8[p - 1] === 0 && !visited[p - 1]) {
      visited[p - 1] = 1;
      queue[tail++] = p - 1;
    }
    if (x + 1 < width && srcUint8[p + 1] === 0 && !visited[p + 1]) {
      visited[p + 1] = 1;
      queue[tail++] = p + 1;
    }
    if (y > 0 && srcUint8[p - width] === 0 && !visited[p - width]) {
      visited[p - width] = 1;
      queue[tail++] = p - width;
    }
    if (y + 1 < height && srcUint8[p + width] === 0 && !visited[p + width]) {
      visited[p + width] = 1;
      queue[tail++] = p + width;
    }
  }

  for (let start = 0; start < N; start++) {
    if (srcUint8[start] !== 0 || visited[start]) continue;
    head = 0;
    tail = 0;
    visited[start] = 2;
    queue[tail++] = start;

    let boundedOnlyBySolid = 1;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = (p - x) / width;

      if (x > 0) {
        const nb = p - 1;
        if (srcUint8[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (!mSolid[nb]) boundedOnlyBySolid = 0;
      }
      if (x + 1 < width) {
        const nb = p + 1;
        if (srcUint8[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (!mSolid[nb]) boundedOnlyBySolid = 0;
      }
      if (y > 0) {
        const nb = p - width;
        if (srcUint8[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (!mSolid[nb]) boundedOnlyBySolid = 0;
      }
      if (y + 1 < height) {
        const nb = p + width;
        if (srcUint8[nb] === 0) {
          if (!visited[nb]) {
            visited[nb] = 2;
            queue[tail++] = nb;
          }
        } else if (!mSolid[nb]) boundedOnlyBySolid = 0;
      }
    }

    if (boundedOnlyBySolid === 1) {
      for (let k = 0; k < tail; k++) {
        counterMask[queue[k]] = 1;
      }
    }
  }

  return counterMask;
}

const INVSQRT8 = 1 / (2 * Math.SQRT2); // Inscribed circle radius 0.35355339 (area pi/8 = 0.392699)
const _calibrationCache = new Map();
const MAX_CALIBRATION_CACHE = 128;

/**
 * Piecewise-monotone bracket lookup for target coverage `t` in calibrated table `(F, U)`.
 */
function lookupCalibratedBracket(t, F, U) {
  const n = F.length;
  if (n === 0) {
    return { loU: t, hiU: t, loF: t, hiF: t, frac: 0, gap: 0 };
  }
  if (n === 1 || t <= F[0]) {
    return { loU: U[0], hiU: U[0], loF: F[0], hiF: F[0], frac: 0, gap: 0 };
  }
  if (t >= F[n - 1]) {
    return { loU: U[n - 1], hiU: U[n - 1], loF: F[n - 1], hiF: F[n - 1], frac: 0, gap: 0 };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (F[mid] <= t) lo = mid;
    else hi = mid;
  }
  const gap = F[hi] - F[lo];
  const frac = gap > 1e-9 ? (t - F[lo]) / gap : 0;
  return { loU: U[lo], hiU: U[hi], loF: F[lo], hiF: F[hi], frac, gap };
}

/**
 * Build (and cache) a 1D empirical discrete tone calibration LUT for a specific
 * `(pitchX, pitchY, angleDeg, dMinPxX, dMinPxY)` configuration by evaluating a compact
 * periodic tile through the exact rasterizer + Stage 4 + Stage 6 morphological pipeline.
 */
function getChannelCalibrationLut(meshSpec, angleDeg) {
  const pitchX = meshSpec.cellPitchPxX || meshSpec.cellPitchPx;
  const pitchY = meshSpec.cellPitchPxY || meshSpec.cellPitchPx;
  const dMinPxX = meshSpec.dMinPxX || meshSpec.dMinPx;
  const dMinPxY = meshSpec.dMinPxY || meshSpec.dMinPx;
  const tMin = meshSpec.tMin;
  const tMax = meshSpec.tMax;

  if (tMax <= tMin + 0.01) {
    return null;
  }

  const key = `${pitchX.toFixed(4)}_${pitchY.toFixed(4)}_${angleDeg.toFixed(3)}_${dMinPxX}_${dMinPxY}`;
  if (_calibrationCache.has(key)) {
    return _calibrationCache.get(key);
  }

  const angleRadCal = (norm90(angleDeg) * Math.PI) / 180;
  const effPeriodX = Math.abs(Math.sin(2 * angleRadCal)) > 0.7 ? Math.SQRT2 * pitchX : pitchX;
  const effPeriodY = Math.abs(Math.sin(2 * angleRadCal)) > 0.7 ? Math.SQRT2 * pitchY : pitchY;
  const marginX = Math.max(12, dMinPxX + Math.ceil(pitchX) + 2);
  const marginY = Math.max(12, dMinPxY + Math.ceil(pitchY) + 2);
  const periodsX = Math.max(5, Math.min(12, Math.round(76 / effPeriodX)));
  const periodsY = Math.max(5, Math.min(12, Math.round(76 / effPeriodY)));
  const innerW = Math.max(44, Math.round(periodsX * effPeriodX));
  const innerH = Math.max(44, Math.round(periodsY * effPeriodY));
  const calW = innerW + 2 * marginX;
  const calH = innerH + 2 * marginY;
  const innerArea = innerW * innerH;
  const probeSrc = new Uint8Array(calW * calH).fill(128);

  const measureProbe = (probeState) => {
    const plate = halftoneChannel(probeSrc, calW, calH, {
      meshSpec,
      angleDeg,
      tailMode: 'clamp',
      channelKey: 'K',
      _probeState: probeState,
    });
    let ink = 0;
    for (let y = marginY; y < calH - marginY; y++) {
      const rowOff = y * calW;
      for (let x = marginX; x < calW - marginX; x++) {
        if (plate[rowOff + x] === 255) ink++;
      }
    }
    return ink / innerArea;
  };

  // 1. Positive unbridged dot sweep across [tMin, 0.50]
  const POS_SAMPLES = 18;
  const uPos = [];
  const fPos = [];
  const posEnd = Math.max(tMin, 0.5);
  for (let s = 0; s < POS_SAMPLES; s++) {
    const u =
      POS_SAMPLES === 1 ? tMin : tMin + (s / (POS_SAMPLES - 1)) * (posEnd - tMin);
    const f = measureProbe({ mode: 'pos', u });
    if (fPos.length === 0 || f > fPos[fPos.length - 1] + 5e-4) {
      uPos.push(u);
      fPos.push(f);
    }
  }
  const fMaxUnbridged = fPos[fPos.length - 1];

  // 2. Bridged shadow hole sweep across [max(0.51, min(tMax, 1 - pi/8)), tMax]
  const SHAD_SAMPLES = 18;
  const shadStart = Math.min(tMax, Math.max(0.51, 1.0 - Math.PI / 8));
  const rawShadU = [];
  const rawShadF = [];
  for (let s = 0; s < SHAD_SAMPLES; s++) {
    const u =
      SHAD_SAMPLES === 1 || tMax <= shadStart + 1e-6
        ? tMax
        : shadStart + (s / (SHAD_SAMPLES - 1)) * (tMax - shadStart);
    const f = measureProbe({ mode: 'shad', u });
    rawShadU.push(u);
    rawShadF.push(f);
    if (tMax <= shadStart + 1e-6) break;
  }

  // Filter backward from tMax so any premature bridge collapse or Stage-6 cusp overshoot is rejected
  const revU = [];
  const revF = [];
  for (let s = rawShadU.length - 1; s >= 0; s--) {
    const u = rawShadU[s];
    const f = rawShadF[s];
    if (f <= fMaxUnbridged + 0.012) continue;
    if (revF.length === 0) {
      revU.push(u);
      revF.push(f);
    } else if (f < revF[revF.length - 1] - 5e-4) {
      revU.push(u);
      revF.push(f);
    }
  }
  revU.reverse();
  revF.reverse();

  // Fallback if tMax was extremely close to fMaxUnbridged
  if (revU.length === 0) {
    const fTop = rawShadF[rawShadF.length - 1];
    revU.push(tMax);
    revF.push(Math.max(fMaxUnbridged + 0.01, fTop));
  }

  const uShad = revU;
  const fShad = revF;
  const uBridgeMin = uShad[0];
  const fMinBridged = fShad[0];

  // 3. Measure exact serpentine bridge-dither transfer curve across alpha in [0, 1]
  // Note: 2D percolation saturates f(alpha) -> fMinBridged around alpha ≈ 0.60..0.70, so anchor
  // the top knot at the first alpha that reaches fMinBridged rather than 1.0!
  const bridgeAlphas = [0.08, 0.16, 0.24, 0.32, 0.40, 0.48, 0.54, 0.60, 0.66, 0.74, 0.85];
  const alphaBridge = [0.0];
  const fBridge = [fMaxUnbridged];
  let topAlpha = 1.0;
  for (let i = 0; i < bridgeAlphas.length; i++) {
    const a = bridgeAlphas[i];
    const f = measureProbe({ mode: 'bridge', u: uBridgeMin, alpha: a });
    if (f >= fMinBridged - 5e-4) {
      topAlpha = a;
      break;
    }
    if (f > fBridge[fBridge.length - 1] + 5e-4) {
      alphaBridge.push(a);
      fBridge.push(f);
    }
  }
  alphaBridge.push(topAlpha);
  fBridge.push(Math.max(fBridge[fBridge.length - 1] + 1e-4, fMinBridged));

  const lut = Object.freeze({
    uPos: Float64Array.from(uPos),
    fPos: Float64Array.from(fPos),
    uShad: Float64Array.from(uShad),
    fShad: Float64Array.from(fShad),
    alphaBridge: Float64Array.from(alphaBridge),
    fBridge: Float64Array.from(fBridge),
    fMaxUnbridged,
    fMinBridged,
    uBridgeMin,
  });

  if (_calibrationCache.size >= MAX_CALIBRATION_CACHE) {
    const oldestKey = _calibrationCache.keys().next().value;
    _calibrationCache.delete(oldestKey);
  }
  _calibrationCache.set(key, lut);
  return lut;
}

/**
 * Halftone a single continuous-tone ink channel (0 = 0% paper, 255 = 100% solid ink)
 * into a discrete {0, 255} screen satisfying mesh minimum dot & shadow-hole physics.
 *
 * @param {Uint8Array|Uint8ClampedArray} srcUint8 - Input ink values [0..255], length = width * height
 * @param {number} width
 * @param {number} height
 * @param {object} options
 * @param {object} [options.meshSpec] - Precomputed computeMeshSpec() result (or mesh params below)
 * @param {number} [options.meshTpi=230]
 * @param {number} [options.threadDiaUm]
 * @param {number} [options.ruleOfN=5.0]
 * @param {number} [options.dpi=600]
 * @param {number|null} [options.lpiOverride=null]
 * @param {number} [options.angleDeg=45]
 * @param {'hybrid'|'cutoff'|'clamp'} [options.tailMode='hybrid']
 * @param {string} [options.channelKey='K']
 * @returns {Uint8Array} Binary {0, 255} screen buffer of length width * height
 */
function halftoneChannel(srcUint8, width, height, options = {}) {
  if (!srcUint8 || srcUint8.length !== width * height) {
    throw new Error(
      `halftoneChannel: expected buffer of length ${width * height}, got ${srcUint8 ? srcUint8.length : 'null'}`
    );
  }
  if (!(width > 0) || !(height > 0)) {
    return new Uint8Array(0);
  }

  const tailMode = options.tailMode || 'hybrid';
  if (!TAIL_MODES.includes(tailMode)) {
    throw new Error(`Invalid tailMode "${tailMode}". Expected one of: ${TAIL_MODES.join(', ')}`);
  }

  const meshSpec =
    options.meshSpec ||
    computeMeshSpec({
      meshTpi: options.meshTpi == null ? 230 : options.meshTpi,
      threadDiaUm: options.threadDiaUm,
      ruleOfN: options.ruleOfN,
      dpi: options.dpi == null ? 600 : options.dpi,
      dpiX: options.dpiX,
      dpiY: options.dpiY,
      lpiOverride: options.lpiOverride,
    });

  const N = width * height;
  const mSolid = new Uint8Array(N);
  let hasNonZero = false;
  let hasMidtone = false;

  for (let p = 0; p < N; p++) {
    const v = srcUint8[p];
    if (v > 0) {
      hasNonZero = true;
      if (v === 255) {
        mSolid[p] = 1;
      } else {
        hasMidtone = true;
      }
    }
  }

  // Fast-path 1: Pure 0% paper
  if (!hasNonZero) {
    return new Uint8Array(N);
  }

  // Fast-path 2: Pure {0, 255} graphic linework — 1px native sovereignty bit-for-bit
  if (!hasMidtone) {
    const exact = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      if (mSolid[p]) exact[p] = 255;
    }
    return exact;
  }

  const angleDeg = norm90(options.angleDeg == null ? 45 : options.angleDeg);
  const angleRad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  const pitchX = meshSpec.cellPitchPxX || meshSpec.cellPitchPx;
  const pitchY = meshSpec.cellPitchPxY || meshSpec.cellPitchPx;
  const invPitchX = 1 / pitchX;
  const invPitchY = 1 / pitchY;
  const dMinPxX = meshSpec.dMinPxX || meshSpec.dMinPx;
  const dMinPxY = meshSpec.dMinPxY || meshSpec.dMinPx;
  const dMinPx = Math.min(dMinPxX, dMinPxY);
  const isOddDX = (dMinPxX & 1) === 1;
  const isOddDY = (dMinPxY & 1) === 1;
  const diskOffsets = meshSpec.diskOffsets;
  const diskSpans = getDiskRowSpans(dMinPxX, dMinPxY);
  const tMin = meshSpec.tMin;
  const tMax = meshSpec.tMax;
  const channelSeed = getChannelSeed(options.channelKey || 'K');

  const x0 = options.originX != null ? Number(options.originX) : width * 0.5;
  const y0 = options.originY != null ? Number(options.originY) : height * 0.5;

  // Compute bounding integer lattice range [iMin..iMax, jMin..jMax] covering canvas corners + 2 cell margin
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ];
  let uMinF = Infinity;
  let uMaxF = -Infinity;
  let vMinF = Infinity;
  let vMaxF = -Infinity;
  for (let c = 0; c < 4; c++) {
    const dxCell = (corners[c][0] - x0) * invPitchX;
    const dyCell = (corners[c][1] - y0) * invPitchY;
    const u = dxCell * cosA + dyCell * sinA;
    const v = -dxCell * sinA + dyCell * cosA;
    if (u < uMinF) uMinF = u;
    if (u > uMaxF) uMaxF = u;
    if (v < vMinF) vMinF = v;
    if (v > vMaxF) vMaxF = v;
  }

  const iMin = Math.floor(uMinF) - 2;
  const iMax = Math.ceil(uMaxF) + 2;
  const jMin = Math.floor(vMinF) - 2;
  const jMax = Math.ceil(vMaxF) + 2;
  const gWidth = iMax - iMin + 1;
  const gHeight = jMax - jMin + 1;
  const gTotal = gWidth * gHeight;

  // Stage 1: Integrate continuous tone strictly over non-solid pixels (src[p] < 255)
  const primSum = new Float64Array(gTotal);
  const primCount = new Int32Array(gTotal);
  const primNonZero = new Uint8Array(gTotal);

  const dualSum = new Float64Array(gTotal);
  const dualCount = new Int32Array(gTotal);
  const dualNonZero = new Uint8Array(gTotal);

  const duDx = cosA * invPitchX;
  const dvDx = -sinA * invPitchX;
  const startDxCell = (0.5 - x0) * invPitchX;

  for (let y = 0; y < height; y++) {
    const dyCell = (y + 0.5 - y0) * invPitchY;
    let u = startDxCell * cosA + dyCell * sinA;
    let v = -startDxCell * sinA + dyCell * cosA;
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const val = srcUint8[rowOff + x];
      if (val < 255) {
        const ip = Math.round(u) - iMin;
        const jp = Math.round(v) - jMin;
        const pIdx = jp * gWidth + ip;
        primSum[pIdx] += val;
        primCount[pIdx] += 1;
        if (val > 0) primNonZero[pIdx] = 1;

        const id = Math.floor(u) - iMin;
        const jd = Math.floor(v) - jMin;
        const dIdx = jd * gWidth + id;
        dualSum[dIdx] += val;
        dualCount[dIdx] += 1;
        if (val > 0) dualNonZero[dIdx] = 1;
      }
      u += duDx;
      v += dvDx;
    }
  }

  const primTone = new Float64Array(gTotal);
  const dualTone = new Float64Array(gTotal);
  const inv255 = 1 / 255;

  for (let idx = 0; idx < gTotal; idx++) {
    if (primCount[idx] > 0 && primNonZero[idx]) {
      primTone[idx] = (primSum[idx] * inv255) / primCount[idx];
    }
    if (dualCount[idx] > 0 && dualNonZero[idx]) {
      dualTone[idx] = (dualSum[idx] * inv255) / dualCount[idx];
    }
  }

  // Helper: map screen coordinates (u, v) -> continuous canvas coordinates (cx, cy)
  // Since [u; v] = R * [dx; dy] / pitch, [dx; dy] = pitch * R^T * [u; v]
  const canPlaceDiskInBounds = (ax, ay, margin) => {
    for (let k = 0; k < diskOffsets.length; k++) {
      const nx = ax + diskOffsets[k].dx;
      const ny = ay + diskOffsets[k].dy;
      if (nx < margin || nx >= width - margin || ny < margin || ny >= height - margin) {
        return false;
      }
    }
    return true;
  };

  const diskOverlapsPositiveSrc = (ax, ay) => {
    for (let k = 0; k < diskOffsets.length; k++) {
      const nx = ax + diskOffsets[k].dx;
      const ny = ay + diskOffsets[k].dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        if (srcUint8[ny * width + nx] > 0) return true;
      }
    }
    return false;
  };

  const diskAvoidsSolid = (ax, ay) => {
    for (let k = 0; k < diskOffsets.length; k++) {
      const nx = ax + diskOffsets[k].dx;
      const ny = ay + diskOffsets[k].dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return false;
      if (mSolid[ny * width + nx]) return false;
    }
    return true;
  };

  // Stage 2: Resolve effective cell tones & discrete B_{D_min} stamps per cell under tailMode
  const minPitch = Math.min(pitchX, pitchY);
  const maxDMin = Math.max(dMinPxX, dMinPxY);
  // Keep unbridged positive dots > sqrt(2) px apart across necks so they never accidentally 8-connect
  const rMaxUnbridged = Math.max(0.28, Math.min(0.495, 0.5 - 0.78 / minPitch));
  const rMaxUnbridgedSq = rMaxUnbridged * rMaxUnbridged;
  // Cap Dual-Diamond shadow holes at the inscribed circle (r <= 1/(2*sqrt(2))) so 90° diamond cusps never form
  const rMaxHole = INVSQRT8;
  const canStampNeckBridges = 0.5 * minPitch >= maxDMin + 0.25;

  const probeState = options._probeState || null;
  const calLut = probeState ? null : getChannelCalibrationLut(meshSpec, angleDeg);

  const primRadiusSq = new Float64Array(gTotal);    // > 0 when continuous Euclidean dot active
  const primStampMin = new Uint8Array(gTotal);      // 1 when canonical B_{D_min} dot stamped
  const primBridgeReady = new Uint8Array(gTotal);   // 1 when D^+ quadrants bordering active D^- cells fill 100%

  const dualActive = new Uint8Array(gTotal);        // 1 when Dual Diamond D^- carries shadow ink
  const dualHoleRadSq = new Float64Array(gTotal);   // > 0 when continuous Euclidean hole active
  const dualStampHole = new Uint8Array(gTotal);     // 1 when canonical B_{D_min} hole cleared

  const jitterScale = Math.min(1.0, (0.25 * tMin) / 0.03);
  const holeSeed = (channelSeed ^ 0x5bd1e995) | 0;
  const midSeed = (channelSeed ^ 0x27d4eb2f) | 0;

  if (probeState) {
    // Fast exact uniform / serpentine-bridge calibration probe
    const uCmd = probeState.u;
    const probeBridgeErr = probeState.mode === 'bridge' ? new Float64Array(gTotal) : null;
    for (let jj = 0; jj < gHeight; jj++) {
      const jLat = jMin + jj;
      const serpRight = (jj & 1) === 0;
      const iStart = serpRight ? 0 : gWidth - 1;
      const iEnd = serpRight ? gWidth : -1;
      const iStep = serpRight ? 1 : -1;

      for (let ii = iStart; ii !== iEnd; ii += iStep) {
        const idx = jj * gWidth + ii;
        const iLat = iMin + ii;
        const cx = x0 + pitchX * (iLat * cosA - jLat * sinA);
        const cy = y0 + pitchY * (iLat * sinA + jLat * cosA);
        const ax = snapAnchorX(cx, isOddDX);
        const ay = snapAnchorY(cy, isOddDY);

        if (probeState.mode === 'pos') {
          const r = Math.min(rMaxUnbridged, radiusForDiamondTone(Math.min(0.5, uCmd)));
          primRadiusSq[idx] = r * r;
          if (canPlaceDiskInBounds(ax, ay, 0)) primStampMin[idx] = 1;
        } else {
          primBridgeReady[idx] = 1;
          primRadiusSq[idx] = rMaxUnbridgedSq;
          if (canPlaceDiskInBounds(ax, ay, 0)) primStampMin[idx] = 1;

          let activeCell = true;
          if (probeState.mode === 'bridge') {
            const isOuterFrame =
              ii <= 1 || ii >= gWidth - 2 || jj <= 1 || jj >= gHeight - 2;
            const acc = probeState.alpha + probeBridgeErr[idx];
            const jit = hashJitter(midSeed, iLat, jLat) * 0.10;
            activeCell = isOuterFrame || acc + jit >= 0.5;
            if (!isOuterFrame) {
              let err = acc - (activeCell ? 1.0 : 0.0);
              if (err > 1.0) err = 1.0;
              if (err < -1.0) err = -1.0;
              const fwd = ii + iStep;
              const bwd = ii - iStep;
              if (fwd >= 0 && fwd < gWidth) probeBridgeErr[jj * gWidth + fwd] += err * (7 / 16);
              if (jj + 1 < gHeight) {
                const rowNext = (jj + 1) * gWidth;
                if (bwd >= 0 && bwd < gWidth) probeBridgeErr[rowNext + bwd] += err * (3 / 16);
                probeBridgeErr[rowNext + ii] += err * (5 / 16);
                if (fwd >= 0 && fwd < gWidth) probeBridgeErr[rowNext + fwd] += err * (1 / 16);
              }
            }
          }

          if (activeCell) {
            dualActive[idx] = 1;
            const h = Math.max(tMin, 1.0 - uCmd);
            const uCenter = iLat + 0.5;
            const vCenter = jLat + 0.5;
            const dcx = x0 + pitchX * (uCenter * cosA - vCenter * sinA);
            const dcy = y0 + pitchY * (uCenter * sinA + vCenter * cosA);
            const dax = snapAnchorX(dcx, isOddDX);
            const day = snapAnchorY(dcy, isOddDY);
            if (canPlaceDiskInBounds(dax, day, 1)) {
              const rH = Math.min(rMaxHole, radiusForDiamondTone(Math.min(0.5, h)));
              dualHoleRadSq[idx] = rH * rH;
              dualStampHole[idx] = 1;
            }
          }
        }
      }
    }
  } else {
    const fMaxUnbridged = calLut ? calLut.fMaxUnbridged : 0.5;
    const fMinBridged = calLut ? calLut.fMinBridged : 0.5;
    const uBridgeMin = calLut ? calLut.uBridgeMin : 0.5;

    const primErr = new Float64Array(gTotal);
    const primMidErr = new Float64Array(gTotal);

    for (let jj = 0; jj < gHeight; jj++) {
      const jLat = jMin + jj;
      const serpRight = (jj & 1) === 0;
      const iStart = serpRight ? 0 : gWidth - 1;
      const iEnd = serpRight ? gWidth : -1;
      const iStep = serpRight ? 1 : -1;

      for (let ii = iStart; ii !== iEnd; ii += iStep) {
        const idx = jj * gWidth + ii;
        const t = primTone[idx];
        if (t <= 0) continue; // Pure 0% paper lock (or 100% solid cell handled by mSolid)

        const iLat = iMin + ii;
        const cx = x0 + pitchX * (iLat * cosA - jLat * sinA);
        const cy = y0 + pitchY * (iLat * sinA + jLat * cosA);
        const ax = snapAnchorX(cx, isOddDX);
        const ay = snapAnchorY(cy, isOddDY);
        const canStamp = canPlaceDiskInBounds(ax, ay, 0) && diskOverlapsPositiveSrc(ax, ay);

        if (t > fMaxUnbridged) {
          primBridgeReady[idx] = 1;
          primRadiusSq[idx] = rMaxUnbridgedSq;
          if (canStamp) primStampMin[idx] = 1;
          continue;
        }

        if (t >= tMin) {
          let uCmd = t;
          if (calLut) {
            const br = lookupCalibratedBracket(t, calLut.fPos, calLut.uPos);
            if (br.gap > 0.025) {
              const target = Math.max(br.loF, Math.min(br.hiF, t + primMidErr[idx]));
              const prob = (target - br.loF) / br.gap;
              const jit = hashJitter(midSeed, iLat, jLat) * 0.12;
              let achieved;
              if (prob + jit >= 0.5) {
                uCmd = br.hiU;
                achieved = br.hiF;
              } else {
                uCmd = br.loU;
                achieved = br.loF;
              }
              let err = t + primMidErr[idx] - achieved;
              if (err > br.gap) err = br.gap;
              if (err < -br.gap) err = -br.gap;
              const fwd = ii + iStep;
              const bwd = ii - iStep;
              if (fwd >= 0 && fwd < gWidth) {
                const nb = jj * gWidth + fwd;
                if (primTone[nb] >= tMin && primTone[nb] <= fMaxUnbridged) {
                  primMidErr[nb] += err * (7 / 16);
                }
              }
              if (jj + 1 < gHeight) {
                const rowNext = (jj + 1) * gWidth;
                if (bwd >= 0 && bwd < gWidth) {
                  const nb = rowNext + bwd;
                  if (primTone[nb] >= tMin && primTone[nb] <= fMaxUnbridged) {
                    primMidErr[nb] += err * (3 / 16);
                  }
                }
                {
                  const nb = rowNext + ii;
                  if (primTone[nb] >= tMin && primTone[nb] <= fMaxUnbridged) {
                    primMidErr[nb] += err * (5 / 16);
                  }
                }
                if (fwd >= 0 && fwd < gWidth) {
                  const nb = rowNext + fwd;
                  if (primTone[nb] >= tMin && primTone[nb] <= fMaxUnbridged) {
                    primMidErr[nb] += err * (1 / 16);
                  }
                }
              }
            } else {
              uCmd = br.loU + br.frac * (br.hiU - br.loU);
            }
          }
          const r = Math.min(rMaxUnbridged, radiusForDiamondTone(Math.min(0.5, uCmd)));
          primRadiusSq[idx] = r * r;
          if (canStamp) primStampMin[idx] = 1;
          continue;
        }

        // Highlight tail: 0 < t < tMin
        if (tailMode === 'cutoff') {
          continue;
        }

        if (tailMode === 'clamp') {
          if (canStamp) primStampMin[idx] = 1;
          continue;
        }

        // tailMode === 'hybrid': Serpentine Floyd-Steinberg over highlight tail cells
        const acc = t + primErr[idx];
        const jit = hashJitter(channelSeed, iLat, jLat) * jitterScale;
        let placed = 0;
        if (canStamp && acc + jit >= 0.5 * tMin) {
          primStampMin[idx] = 1;
          placed = tMin;
        }

        let err = acc - placed;
        if (err > tMin) err = tMin;
        if (err < -tMin) err = -tMin;

        // Diffuse only into neighboring active highlight-tail cells (0 < nbTone < tMin)
        const fwd = ii + iStep;
        const bwd = ii - iStep;
        if (fwd >= 0 && fwd < gWidth) {
          const nb = jj * gWidth + fwd;
          if (primTone[nb] > 0 && primTone[nb] < tMin) primErr[nb] += err * (7 / 16);
        }
        if (jj + 1 < gHeight) {
          const rowNext = (jj + 1) * gWidth;
          if (bwd >= 0 && bwd < gWidth) {
            const nb = rowNext + bwd;
            if (primTone[nb] > 0 && primTone[nb] < tMin) primErr[nb] += err * (3 / 16);
          }
          {
            const nb = rowNext + ii;
            if (primTone[nb] > 0 && primTone[nb] < tMin) primErr[nb] += err * (5 / 16);
          }
          if (fwd >= 0 && fwd < gWidth) {
            const nb = rowNext + fwd;
            if (primTone[nb] > 0 && primTone[nb] < tMin) primErr[nb] += err * (1 / 16);
          }
        }
      }
    }

    // Dual cells: transition bridges (fMaxUnbridged, fMinBridged) + shadow holes [fMinBridged, 1)
    const dualErr = new Float64Array(gTotal);
    const bridgeErr = new Float64Array(gTotal);
    const shadMidErr = new Float64Array(gTotal);

    for (let jj = 0; jj < gHeight; jj++) {
      const jLat = jMin + jj;
      const serpRight = (jj & 1) === 0;
      const iStart = serpRight ? 0 : gWidth - 1;
      const iEnd = serpRight ? gWidth : -1;
      const iStep = serpRight ? 1 : -1;

      for (let ii = iStart; ii !== iEnd; ii += iStep) {
        const idx = jj * gWidth + ii;
        const t = dualTone[idx];
        if (t <= fMaxUnbridged) continue;

        const uCenter = iMin + ii + 0.5;
        const vCenter = jLat + 0.5;
        const cx = x0 + pitchX * (uCenter * cosA - vCenter * sinA);
        const cy = y0 + pitchY * (uCenter * sinA + vCenter * cosA);
        const ax = snapAnchorX(cx, isOddDX);
        const ay = snapAnchorY(cy, isOddDY);
        const safeHole = canPlaceDiskInBounds(ax, ay, 1) && diskAvoidsSolid(ax, ay);

        // Band 2: Discrete dot-to-hole topological bridge transition (fMaxUnbridged < t < fMinBridged)
        if (calLut && t < fMinBridged) {
          const br = lookupCalibratedBracket(t, calLut.fBridge, calLut.alphaBridge);
          const alphaTarget = br.loU + br.frac * (br.hiU - br.loU);
          const acc = alphaTarget + bridgeErr[idx];
          const jit = hashJitter(midSeed, iMin + ii, jLat) * 0.10;
          let placedAlpha = 0;
          if (acc + jit >= 0.5) {
            placedAlpha = 1.0;
            dualActive[idx] = 1;
            if (safeHole) {
              const hBridge = Math.max(tMin, 1.0 - uBridgeMin);
              const rH = Math.min(rMaxHole, radiusForDiamondTone(Math.min(0.5, hBridge)));
              dualHoleRadSq[idx] = rH * rH;
              dualStampHole[idx] = 1;
            }
          }

          let err = acc - placedAlpha;
          if (err > 1.0) err = 1.0;
          if (err < -1.0) err = -1.0;

          const fwd = ii + iStep;
          const bwd = ii - iStep;
          if (fwd >= 0 && fwd < gWidth) {
            const nb = jj * gWidth + fwd;
            if (dualTone[nb] > fMaxUnbridged && dualTone[nb] < fMinBridged) {
              bridgeErr[nb] += err * (7 / 16);
            }
          }
          if (jj + 1 < gHeight) {
            const rowNext = (jj + 1) * gWidth;
            if (bwd >= 0 && bwd < gWidth) {
              const nb = rowNext + bwd;
              if (dualTone[nb] > fMaxUnbridged && dualTone[nb] < fMinBridged) {
                bridgeErr[nb] += err * (3 / 16);
              }
            }
            {
              const nb = rowNext + ii;
              if (dualTone[nb] > fMaxUnbridged && dualTone[nb] < fMinBridged) {
                bridgeErr[nb] += err * (5 / 16);
              }
            }
            if (fwd >= 0 && fwd < gWidth) {
              const nb = rowNext + fwd;
              if (dualTone[nb] > fMaxUnbridged && dualTone[nb] < fMinBridged) {
                bridgeErr[nb] += err * (1 / 16);
              }
            }
          }
          continue;
        }

        // Band 3 & Shadow Tail: t >= fMinBridged
        dualActive[idx] = 1;
        const hRaw = 1.0 - t;
        if (hRaw <= 0) continue;

        if (!safeHole) {
          continue; // Dual cell stays solid 255
        }

        if (hRaw >= tMin) {
          let uCmd = t;
          if (calLut) {
            const br = lookupCalibratedBracket(t, calLut.fShad, calLut.uShad);
            if (br.gap > 0.025) {
              const target = Math.max(br.loF, Math.min(br.hiF, t + shadMidErr[idx]));
              const prob = (target - br.loF) / br.gap;
              const jit = hashJitter(holeSeed, iMin + ii, jLat) * 0.12;
              let achieved;
              if (prob + jit >= 0.5) {
                uCmd = br.hiU;
                achieved = br.hiF;
              } else {
                uCmd = br.loU;
                achieved = br.loF;
              }
              let err = t + shadMidErr[idx] - achieved;
              if (err > br.gap) err = br.gap;
              if (err < -br.gap) err = -br.gap;
              const fwd = ii + iStep;
              const bwd = ii - iStep;
              if (fwd >= 0 && fwd < gWidth) {
                const nb = jj * gWidth + fwd;
                if (dualTone[nb] >= fMinBridged && dualTone[nb] <= tMax) {
                  shadMidErr[nb] += err * (7 / 16);
                }
              }
              if (jj + 1 < gHeight) {
                const rowNext = (jj + 1) * gWidth;
                if (bwd >= 0 && bwd < gWidth) {
                  const nb = rowNext + bwd;
                  if (dualTone[nb] >= fMinBridged && dualTone[nb] <= tMax) {
                    shadMidErr[nb] += err * (3 / 16);
                  }
                }
                {
                  const nb = rowNext + ii;
                  if (dualTone[nb] >= fMinBridged && dualTone[nb] <= tMax) {
                    shadMidErr[nb] += err * (5 / 16);
                  }
                }
                if (fwd >= 0 && fwd < gWidth) {
                  const nb = rowNext + fwd;
                  if (dualTone[nb] >= fMinBridged && dualTone[nb] <= tMax) {
                    shadMidErr[nb] += err * (1 / 16);
                  }
                }
              }
            } else {
              uCmd = br.loU + br.frac * (br.hiU - br.loU);
            }
          }
          const hCal = Math.max(tMin, Math.min(0.5, 1.0 - uCmd));
          const r = Math.min(rMaxHole, radiusForDiamondTone(hCal));
          dualHoleRadSq[idx] = r * r;
          dualStampHole[idx] = 1;
          continue;
        }

        // Shadow tail: tMax < t < 1  <=>  0 < hRaw < tMin
        if (tailMode === 'cutoff') {
          continue; // Collapses to solid 100%
        }

        if (tailMode === 'clamp') {
          dualStampHole[idx] = 1;
          continue;
        }

        // tailMode === 'hybrid': Serpentine Floyd-Steinberg over shadow-hole tail
        const acc = hRaw + dualErr[idx];
        const jit = hashJitter(holeSeed, iMin + ii, jLat) * jitterScale;
        let placed = 0;
        if (acc + jit >= 0.5 * tMin) {
          dualStampHole[idx] = 1;
          placed = tMin;
        }

        let err = acc - placed;
        if (err > tMin) err = tMin;
        if (err < -tMin) err = -tMin;

        const fwd = ii + iStep;
        const bwd = ii - iStep;
        if (fwd >= 0 && fwd < gWidth) {
          const nb = jj * gWidth + fwd;
          const nbH = 1.0 - dualTone[nb];
          if (dualTone[nb] > 0.5 && nbH > 0 && nbH < tMin) dualErr[nb] += err * (7 / 16);
        }
        if (jj + 1 < gHeight) {
          const rowNext = (jj + 1) * gWidth;
          if (bwd >= 0 && bwd < gWidth) {
            const nb = rowNext + bwd;
            const nbH = 1.0 - dualTone[nb];
            if (dualTone[nb] > 0.5 && nbH > 0 && nbH < tMin) dualErr[nb] += err * (3 / 16);
          }
          {
            const nb = rowNext + ii;
            const nbH = 1.0 - dualTone[nb];
            if (dualTone[nb] > 0.5 && nbH > 0 && nbH < tMin) dualErr[nb] += err * (5 / 16);
          }
          if (fwd >= 0 && fwd < gWidth) {
            const nb = rowNext + fwd;
            const nbH = 1.0 - dualTone[nb];
            if (dualTone[nb] > 0.5 && nbH > 0 && nbH < tMin) dualErr[nb] += err * (1 / 16);
          }
        }
      }
    }
  }

  // Stage 3: Rasterize continuous Euclidean diamonds + snapped canonical B_{D_min} dots & holes
  const halftoneFg = new Uint8Array(N);

  for (let y = 0; y < height; y++) {
    const dyCell = (y + 0.5 - y0) * invPitchY;
    let u = startDxCell * cosA + dyCell * sinA;
    let v = -startDxCell * sinA + dyCell * cosA;
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const m = Math.round(u + v);
      const n = Math.round(u - v);
      if (((m + n) & 1) === 0) {
        // Primary Diamond D^+_{iLat, jLat}
        const iLat = (m + n) >> 1;
        const jLat = (m - n) >> 1;
        const ii = iLat - iMin;
        const jj = jLat - jMin;
        if (ii >= 0 && ii < gWidth && jj >= 0 && jj < gHeight) {
          const idx = jj * gWidth + ii;
          const du = u - iLat;
          const dv = v - jLat;
          let filled = false;
          if (primBridgeReady[idx]) {
            const dII = du >= 0 ? ii : ii - 1;
            const dJJ = dv >= 0 ? jj : jj - 1;
            if (
              dII >= 0 &&
              dII < gWidth &&
              dJJ >= 0 &&
              dJJ < gHeight &&
              dualActive[dJJ * gWidth + dII]
            ) {
              filled = true;
            }
          }
          if (filled) {
            halftoneFg[rowOff + x] = 255;
          } else {
            const rSq = primRadiusSq[idx];
            if (rSq > 0 && du * du + dv * dv <= rSq) {
              halftoneFg[rowOff + x] = 255;
            }
          }
        }
      } else {
        // Dual Diamond D^-_{iLat, jLat} centered at (iLat + 0.5, jLat + 0.5)
        const iLat = (m + n - 1) >> 1;
        const jLat = (m - n - 1) >> 1;
        const ii = iLat - iMin;
        const jj = jLat - jMin;
        if (ii >= 0 && ii < gWidth && jj >= 0 && jj < gHeight) {
          const idx = jj * gWidth + ii;
          if (dualActive[idx]) {
            const du = u - (iLat + 0.5);
            const dv = v - (jLat + 0.5);
            const rSq = dualHoleRadSq[idx];
            if (rSq <= 0 || du * du + dv * dv > rSq) {
              // Step-edge corner triangle gate: near a corner of D^-, ensure the two
              // flanking Primary Diamonds are active before placing tiny corner bridge ink
              let allowBridge = true;
              if (rSq > 0.08) {
                const nearRight = du > 0.25;
                const nearLeft = du < -0.25;
                const nearBottom = dv > 0.25;
                const nearTop = dv < -0.25;
                if (nearRight || nearLeft || nearBottom || nearTop) {
                  const p00 = jj * gWidth + ii;
                  const p10 = ii + 1 < gWidth ? jj * gWidth + (ii + 1) : -1;
                  const p01 = jj + 1 < gHeight ? (jj + 1) * gWidth + ii : -1;
                  const p11 =
                    ii + 1 < gWidth && jj + 1 < gHeight ? (jj + 1) * gWidth + (ii + 1) : -1;
                  if (
                    nearRight &&
                    (p10 < 0 || p11 < 0 || (!primBridgeReady[p10] && !primBridgeReady[p11]))
                  ) {
                    allowBridge = false;
                  } else if (
                    nearLeft &&
                    !primBridgeReady[p00] &&
                    (p01 < 0 || !primBridgeReady[p01])
                  ) {
                    allowBridge = false;
                  } else if (
                    nearBottom &&
                    (p01 < 0 || p11 < 0 || (!primBridgeReady[p01] && !primBridgeReady[p11]))
                  ) {
                    allowBridge = false;
                  } else if (
                    nearTop &&
                    !primBridgeReady[p00] &&
                    (p10 < 0 || !primBridgeReady[p10])
                  ) {
                    allowBridge = false;
                  }
                }
              }
              if (allowBridge) {
                halftoneFg[rowOff + x] = 255;
              }
            }
          }
        }
      }

      u += duDx;
      v += dvDx;
    }
  }

  // Stamp canonical snapped B_{D_min} positive dots (guarantees subpixel-dropout immunity)
  for (let jj = 0; jj < gHeight; jj++) {
    const jLat = jMin + jj;
    for (let ii = 0; ii < gWidth; ii++) {
      const idx = jj * gWidth + ii;
      if (!primStampMin[idx]) continue;
      const iLat = iMin + ii;
      const cx = x0 + pitchX * (iLat * cosA - jLat * sinA);
      const cy = y0 + pitchY * (iLat * sinA + jLat * cosA);
      const ax = snapAnchorX(cx, isOddDX);
      const ay = snapAnchorY(cy, isOddDY);
      for (let k = 0; k < diskOffsets.length; k++) {
        const nx = ax + diskOffsets[k].dx;
        const ny = ay + diskOffsets[k].dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          halftoneFg[ny * width + nx] = 255;
        }
      }
    }
  }

  // Stamp canonical B_{D_min} neck bridges on active Dual cells so isolated transition bridges survive Stage 4
  if (canStampNeckBridges) {
    const neckUV = [
      [0.5, 0.0, 0, 0, 1, 0],
      [0.5, 1.0, 0, 1, 1, 1],
      [0.0, 0.5, 0, 0, 0, 1],
      [1.0, 0.5, 1, 0, 1, 1],
    ];
    for (let jj = 0; jj < gHeight; jj++) {
      const jLat = jMin + jj;
      for (let ii = 0; ii < gWidth; ii++) {
        const idx = jj * gWidth + ii;
        if (!dualActive[idx]) continue;
        const iLat = iMin + ii;
        for (let nIdx = 0; nIdx < 4; nIdx++) {
          const nk = neckUV[nIdx];
          const pAII = ii + nk[2];
          const pAJJ = jj + nk[3];
          const pBII = ii + nk[4];
          const pBJJ = jj + nk[5];
          if (
            pAII < 0 ||
            pAII >= gWidth ||
            pAJJ < 0 ||
            pAJJ >= gHeight ||
            pBII < 0 ||
            pBII >= gWidth ||
            pBJJ < 0 ||
            pBJJ >= gHeight
          ) {
            continue;
          }
          if (
            !primBridgeReady[pAJJ * gWidth + pAII] ||
            !primBridgeReady[pBJJ * gWidth + pBII]
          ) {
            continue;
          }
          const nu = iLat + nk[0];
          const nv = jLat + nk[1];
          const ncx = x0 + pitchX * (nu * cosA - nv * sinA);
          const ncy = y0 + pitchY * (nu * sinA + nv * cosA);
          const nax = snapAnchorX(ncx, isOddDX);
          const nay = snapAnchorY(ncy, isOddDY);
          if (!canPlaceDiskInBounds(nax, nay, 0)) continue;
          if (!probeState && !diskOverlapsPositiveSrc(nax, nay)) continue;
          for (let k = 0; k < diskOffsets.length; k++) {
            const nx = nax + diskOffsets[k].dx;
            const ny = nay + diskOffsets[k].dy;
            halftoneFg[ny * width + nx] = 255;
          }
        }
      }
    }
  }

  // Clear canonical snapped B_{D_min} shadow holes
  for (let jj = 0; jj < gHeight; jj++) {
    const jLat = jMin + jj;
    for (let ii = 0; ii < gWidth; ii++) {
      const idx = jj * gWidth + ii;
      if (!dualStampHole[idx]) continue;
      const uCenter = iMin + ii + 0.5;
      const vCenter = jLat + 0.5;
      const cx = x0 + pitchX * (uCenter * cosA - vCenter * sinA);
      const cy = y0 + pitchY * (uCenter * sinA + vCenter * cosA);
      const ax = snapAnchorX(cx, isOddDX);
      const ay = snapAnchorY(cy, isOddDY);
      for (let k = 0; k < diskOffsets.length; k++) {
        const nx = ax + diskOffsets[k].dx;
        const ny = ay + diskOffsets[k].dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          halftoneFg[ny * width + nx] = 0;
        }
      }
    }
  }

  // Stage 4: Exact Morphological Openness & Paper-Bleed Guard on Halftone Foreground
  // Only retain B_{D_min} anchors that fit completely in halftoneFg AND overlap at least one src > 0 pixel
  const fgAnchors = erodeByDiskSpans(halftoneFg, width, height, diskSpans);
  if (dMinPx >= 1) {
    // Build dilation of (src > 0) by reflected B_{D_min} so anchor overlap check is O(1)
    const reflectedSpans = diskSpans.map((sp) => ({
      dy: -sp.dy,
      dxMin: -sp.dxMax,
      dxMax: -sp.dxMin,
      len: sp.len,
    }));
    const srcPositive = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      if (srcUint8[p] > 0) srcPositive[p] = 1;
    }
    const anchorHitsSrc = dilateByDiskSpans(srcPositive, width, height, reflectedSpans);
    for (let p = 0; p < N; p++) {
      if (fgAnchors[p] && !anchorHitsSrc[p]) {
        fgAnchors[p] = 0;
      }
    }
  }
  const cleanHalftoneFg = dilateByDiskSpans(fgAnchors, width, height, diskSpans);

  // Stage 5: Stamp 100% Solid Linework Sovereignty (M_solid) at native 1px precision
  // while keeping pure {0, 255} graphic counters enclosed by M_solid completely clear of cell-averaged ink
  const pureGraphicCounters = extractPureGraphicCounters(srcUint8, mSolid, width, height);
  const plate = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    if (!pureGraphicCounters[p] && (cleanHalftoneFg[p] || mSolid[p])) {
      plate[p] = 255;
    }
  }

  // Stage 6: Monotone Knaster-Tarski Fixed-Point Closure on Enclosed Shadow Holes & Bridges
  // Guarantees BOTH minHoleViolations === 0 AND minDotViolations === 0 simultaneously, while
  // protecting pure {0, 255} graphic counters inside M_solid linework.
  if (Math.max(dMinPxX, dMinPxY) > 1 && width >= dMinPxX && height >= dMinPxY) {

    let minOffX = 0;
    let maxOffX = 0;
    let minOffY = 0;
    let maxOffY = 0;
    for (let k = 0; k < diskOffsets.length; k++) {
      const off = diskOffsets[k];
      if (off.dx < minOffX) minOffX = off.dx;
      if (off.dx > maxOffX) maxOffX = off.dx;
      if (off.dy < minOffY) minOffY = off.dy;
      if (off.dy > maxOffY) maxOffY = off.dy;
    }
    const axMin = -minOffX;
    const axMax = width - 1 - maxOffX;
    const ayMin = -minOffY;
    const ayMax = height - 1 - maxOffY;

    const notCounter = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      notCounter[p] = pureGraphicCounters[p] ? 0 : 1;
    }
    const validBridgeAnchor = erodeByDiskSpans(notCounter, width, height, diskSpans);
    const rowPrefix = new Int32Array((width + 1) * height);

    const centeredOffsets = Array.from(diskOffsets).sort(
      (a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy)
    );
    const MAX_CLOSURE_PASSES = 256;
    const bfs = new Int32Array(N);
    let convergedEarly = false;

    for (let pass = 0; pass < MAX_CLOSURE_PASSES; pass++) {
      // Op A: Open all enclosed halftone 0-holes by B_{D_min} (fill sub-mesh pinholes/tips to 255)
      const holeMask = extractHalftoneEnclosedHoles(plate, srcUint8, mSolid, width, height);
      const openHoles = openByDiskSpans(holeMask, width, height, diskSpans);
      let changedA = 0;
      for (let p = 0; p < N; p++) {
        if (holeMask[p] && !openHoles[p] && !pureGraphicCounters[p]) {
          plate[p] = 255;
          changedA++;
        }
      }

      if (changedA === 0 && pass > 0) {
        convergedEarly = true;
        break;
      }

      // Compute M_solid-connected foreground so 1px linework bridges are never thickened unnecessarily
      const solidConn = new Uint8Array(N);
      let qHead = 0;
      let qTail = 0;
      for (let p = 0; p < N; p++) {
        if (mSolid[p]) {
          solidConn[p] = 1;
          bfs[qTail++] = p;
        }
      }
      while (qHead < qTail) {
        const p = bfs[qHead++];
        const px = p % width;
        const py = (p - px) / width;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const np = ny * width + nx;
            if (plate[np] === 255 && !solidConn[np]) {
              solidConn[np] = 1;
              bfs[qTail++] = np;
            }
          }
        }
      }

      // Op B: Any newly filled pixel p not covered by B_{D_min} in plate gets an in-bounds B_{D_min} bridge stamp.
      // Choose the covering anchor (ax, ay) = (x - off.dx, y - off.dy) disjoint from pureGraphicCounters that
      // maximizes overlap with existing plate === 255 ink (tie-broken by proximity to (x, y)), tucking the
      // bridge inward into existing ink rather than marching outward into 0% paper.
      const openPlate = openByDiskSpans(plate, width, height, diskSpans);
      const pStride = width + 1;
      for (let y = 0; y < height; y++) {
        const rOff = y * width;
        const pOff = y * pStride;
        let sum = 0;
        for (let x = 0; x < width; x++) {
          if (plate[rOff + x] === 255) sum++;
          rowPrefix[pOff + x + 1] = sum;
        }
      }

      let changedB = 0;
      const spanCount = diskSpans.length;
      for (let y = 0; y < height; y++) {
        const rowOff = y * width;
        for (let x = 0; x < width; x++) {
          const p = rowOff + x;
          if (plate[p] === 255 && !solidConn[p] && !openPlate[p]) {
            let bestAx = Math.max(axMin, Math.min(axMax, x));
            let bestAy = Math.max(ayMin, Math.min(ayMax, y));
            let bestScore = -1;

            for (let c = 0; c < centeredOffsets.length; c++) {
              const candAx = x - centeredOffsets[c].dx;
              const candAy = y - centeredOffsets[c].dy;
              if (candAx < axMin || candAx > axMax || candAy < ayMin || candAy > ayMax) continue;
              if (!validBridgeAnchor[candAy * width + candAx]) continue;
              let existingInk = 0;
              for (let s = 0; s < spanCount; s++) {
                const sp = diskSpans[s];
                const pOff = (candAy + sp.dy) * pStride;
                existingInk += rowPrefix[pOff + candAx + sp.dxMax + 1] - rowPrefix[pOff + candAx + sp.dxMin];
              }
              if (existingInk > bestScore) {
                bestScore = existingInk;
                bestAx = candAx;
                bestAy = candAy;
              }
            }

            for (let k = 0; k < diskOffsets.length; k++) {
              const nx = bestAx + diskOffsets[k].dx;
              const ny = bestAy + diskOffsets[k].dy;
              const np = ny * width + nx;
              if (!pureGraphicCounters[np] && plate[np] !== 255) {
                plate[np] = 255;
                changedB++;
              }
            }
          }
        }
      }

      if (changedB === 0) {
        convergedEarly = true;
        break;
      }
    }

    // Final safety Op A pass if MAX_CLOSURE_PASSES was reached
    if (!convergedEarly) {
      const holeMask = extractHalftoneEnclosedHoles(plate, srcUint8, mSolid, width, height);
      const openHoles = openByDiskSpans(holeMask, width, height, diskSpans);
      for (let p = 0; p < N; p++) {
        if (holeMask[p] && !openHoles[p] && !pureGraphicCounters[p]) {
          plate[p] = 255;
        }
      }
    }
  }

  return plate;
}

/**
 * Halftone all 4 CMYK continuous-tone channels into discrete {0, 255} screens.
 *
 * Returns canonical Phase-2-ready structure:
 *   { plates: { C, M, Y, K }, meshSpec, moireReport, angles }
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} channels
 * @param {number} width
 * @param {number} height
 * @param {object} [config]
 * @param {number} [config.meshTpi=230]
 * @param {number} [config.threadDiaUm]
 * @param {number} [config.ruleOfN=5.0]
 * @param {number} [config.dpi=600]
 * @param {number|null} [config.lpiOverride=null]
 * @param {number} [config.meshAngleDeg=0]
 * @param {{ C: number, M: number, Y: number, K: number }|null} [config.anglesOverride=null]
 * @param {'hybrid'|'cutoff'|'clamp'} [config.tailMode='hybrid']
 * @param {number} [config.slopDeg=2.0]
 * @returns {{ plates: { C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }, meshSpec: object, moireReport: object, angles: { C: number, M: number, Y: number, K: number } }}
 */
function halftoneCmyk(channels, width, height, config = {}) {
  if (!channels || !channels.C || !channels.M || !channels.Y || !channels.K) {
    throw new Error('halftoneCmyk requires { C, M, Y, K } Uint8Array channel buffers');
  }

  const meshSpec = computeMeshSpec({
    meshTpi: config.meshTpi == null ? 230 : config.meshTpi,
    threadDiaUm: config.threadDiaUm,
    ruleOfN: config.ruleOfN,
    dpi: config.dpi == null ? 600 : config.dpi,
    dpiX: config.dpiX,
    dpiY: config.dpiY,
    lpiOverride: config.lpiOverride,
  });

  const meshAngleDeg = config.meshAngleDeg == null ? 0 : config.meshAngleDeg;
  const baseAngles = config.anglesOverride || computeRosetteAngles(meshAngleDeg);
  const angles = {
    C: norm90(baseAngles.C),
    M: norm90(baseAngles.M),
    Y: norm90(baseAngles.Y),
    K: norm90(baseAngles.K),
  };

  const moireReport = analyzeMoire({
    meshTpi: meshSpec.meshTpi,
    threadDiaUm: meshSpec.threadDiaUm,
    lpi: meshSpec.lpiActive,
    angles,
    meshAngleDeg,
    slopDeg: config.slopDeg == null ? 2.0 : config.slopDeg,
  });

  const tailMode = config.tailMode || 'hybrid';
  const originX = config.originX;
  const originY = config.originY;
  const plates = {
    C: halftoneChannel(channels.C, width, height, {
      meshSpec,
      angleDeg: angles.C,
      tailMode,
      channelKey: 'C',
      originX,
      originY,
    }),
    M: halftoneChannel(channels.M, width, height, {
      meshSpec,
      angleDeg: angles.M,
      tailMode,
      channelKey: 'M',
      originX,
      originY,
    }),
    Y: halftoneChannel(channels.Y, width, height, {
      meshSpec,
      angleDeg: angles.Y,
      tailMode,
      channelKey: 'Y',
      originX,
      originY,
    }),
    K: halftoneChannel(channels.K, width, height, {
      meshSpec,
      angleDeg: angles.K,
      tailMode,
      channelKey: 'K',
      originX,
      originY,
    }),
  };

  return {
    plates,
    meshSpec,
    moireReport,
    angles,
  };
}

module.exports = {
  TAIL_MODES,
  CHANNEL_SEEDS,
  getDiskRowSpans,
  erodeByDiskSpans,
  dilateByDiskSpans,
  openByDiskSpans,
  hashJitter,
  getChannelCalibrationLut,
  halftoneChannel,
  halftoneCmyk,
};

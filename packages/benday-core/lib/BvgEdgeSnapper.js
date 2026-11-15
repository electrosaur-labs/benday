'use strict';

/**
 * Bimodal Variance-Gated (BVG) Crisp Type & Linework Conditioner.
 *
 * Pure zero-dependency TypedArray implementation:
 *   - Stage A (snapCmykEdges): O(W*H) 2-pass Rosenfeld-Pfaltz 3-4 Chamfer Distance
 *     morphological opening separating wide Rich-Black fills (>= 2 * cellPitchPx, preserved
 *     100% untouched) from narrow Rich-Black text/linework strokes (< 2 * cellPitchPx)
 *     adjacent to high-contrast light backgrounds, promoting narrow strokes to solo K=255, CMY=0.
 *   - Stage B (snapChannelEdges): 5x5 exact Otsu separability (eta >= 0.82, delta >= 128,
 *     valley sparsity <= 7) with 3x3 antipodal ridge/valley topology guards protecting
 *     1 px dark hairlines and 1 px open letter counters (e, a, o), and strict 0-pixel
 *     modification on continuous photographic gradients and Gaussian film grain.
 */

const CHAMFER_INF = 0x3fffffff;

/**
 * Stage B: Snap anti-aliased graphic/type transition pixels on a single 8-bit ink channel
 * while leaving continuous-tone photographic gradients, film grain, 0% paper, and 100% solids
 * untouched.
 *
 * @param {Uint8Array|Uint8ClampedArray} srcUint8
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {Uint8Array|null} [options.protectMask=null] - Optional mask (1 = keep src[p] untouched)
 * @returns {Uint8Array}
 */
function snapChannelEdges(srcUint8, width, height, options = {}) {
  const N = width * height;
  if (!srcUint8 || srcUint8.length !== N) {
    throw new Error(
      `snapChannelEdges: expected buffer of length ${N}, got ${srcUint8 ? srcUint8.length : 'null'}`
    );
  }
  if (!(width > 0) || !(height > 0)) {
    return new Uint8Array(0);
  }

  const protectMask = options.protectMask || null;
  const out = new Uint8Array(N);
  const win = new Uint8Array(25);
  const sorted = new Uint8Array(25);

  for (let y = 0; y < height; y++) {
    const y0 = y > 1 ? y - 2 : 0;
    const y1 = y > 0 ? y - 1 : 0;
    const y2 = y;
    const y3 = y + 1 < height ? y + 1 : height - 1;
    const y4 = y + 2 < height ? y + 2 : height - 1;

    const r0 = y0 * width;
    const r1 = y1 * width;
    const r2 = y2 * width;
    const r3 = y3 * width;
    const r4 = y4 * width;

    for (let x = 0; x < width; x++) {
      const p = r2 + x;
      const v = srcUint8[p];

      // Strict fixed points: 0% paper, 100% solid, or explicitly protected pixels
      if (v === 0 || v === 255 || (protectMask && protectMask[p])) {
        out[p] = v;
        continue;
      }

      const x0 = x > 1 ? x - 2 : 0;
      const x1 = x > 0 ? x - 1 : 0;
      const x2 = x;
      const x3 = x + 1 < width ? x + 1 : width - 1;
      const x4 = x + 2 < width ? x + 2 : width - 1;

      win[0] = srcUint8[r0 + x0];
      win[1] = srcUint8[r0 + x1];
      win[2] = srcUint8[r0 + x2];
      win[3] = srcUint8[r0 + x3];
      win[4] = srcUint8[r0 + x4];

      win[5] = srcUint8[r1 + x0];
      win[6] = srcUint8[r1 + x1];
      win[7] = srcUint8[r1 + x2];
      win[8] = srcUint8[r1 + x3];
      win[9] = srcUint8[r1 + x4];

      win[10] = srcUint8[r2 + x0];
      win[11] = srcUint8[r2 + x1];
      win[12] = v;
      win[13] = srcUint8[r2 + x3];
      win[14] = srcUint8[r2 + x4];

      win[15] = srcUint8[r3 + x0];
      win[16] = srcUint8[r3 + x1];
      win[17] = srcUint8[r3 + x2];
      win[18] = srcUint8[r3 + x3];
      win[19] = srcUint8[r3 + x4];

      win[20] = srcUint8[r4 + x0];
      win[21] = srcUint8[r4 + x1];
      win[22] = srcUint8[r4 + x2];
      win[23] = srcUint8[r4 + x3];
      win[24] = srcUint8[r4 + x4];

      let iMin = 255;
      let iMax = 0;
      let sum = 0;
      let sumSq = 0;
      for (let k = 0; k < 25; k++) {
        const s = win[k];
        if (s < iMin) iMin = s;
        if (s > iMax) iMax = s;
        sum += s;
        sumSq += s * s;
      }

      const delta = iMax - iMin;
      // Gate 1 & Gate 2: Local dynamic range >= 128 and anchored near paper (<= 16) or solid (>= 239)
      if (delta < 128 || (iMin > 16 && iMax < 239)) {
        out[p] = v;
        continue;
      }

      // Gate 3: Valley sparsity (at most 7 intermediate anti-aliased ramp pixels in middle 50% band)
      const midLo = iMin + 0.25 * delta;
      const midHi = iMax - 0.25 * delta;
      let nMid = 0;
      for (let k = 0; k < 25; k++) {
        const s = win[k];
        if (s > midLo && s < midHi) {
          nMid++;
          if (nMid > 7) break;
        }
      }
      if (nMid > 7) {
        out[p] = v;
        continue;
      }

      // Gate 4: Exact 25-sample Otsu inter-class variance ratio eta = sigma_B,max^2 / sigma_T^2 >= 0.82
      const totalVarScaled = 25 * sumSq - sum * sum;
      if (totalVarScaled <= 0) {
        out[p] = v;
        continue;
      }

      // Insertion sort 25 samples into sorted[]
      sorted[0] = win[0];
      for (let k = 1; k < 25; k++) {
        const key = win[k];
        let j = k - 1;
        while (j >= 0 && sorted[j] > key) {
          sorted[j + 1] = sorted[j];
          j--;
        }
        sorted[j + 1] = key;
      }

      let maxNum = -1;
      let bestDenom = 1;
      let bestThresh = 127.5;
      let s0 = 0;
      for (let k = 0; k < 24; k++) {
        s0 += sorted[k];
        if (sorted[k] === sorted[k + 1]) continue;
        const c0 = k + 1;
        const c1 = 25 - c0;
        const diff = 25 * s0 - c0 * sum;
        const num = diff * diff;
        const denom = c0 * c1;
        if (num * bestDenom > maxNum * denom) {
          maxNum = num;
          bestDenom = denom;
          bestThresh = 0.5 * (sorted[k] + sorted[k + 1]);
        }
      }

      if (maxNum < 0) {
        out[p] = v;
        continue;
      }

      const eta = maxNum / (bestDenom * totalVarScaled);
      if (eta < 0.82) {
        out[p] = v;
        continue;
      }

      // Gate 5: 3x3 antipodal ridge/valley topology guards (INV-BVG-2)
      // Protect 1 px dark hairlines from snapping down to 0, and 1 px open letter counters
      // (e, a, o) from snapping up to 255.
      const nW = win[11];
      const nE = win[13];
      const nN = win[7];
      const nS = win[17];
      const nNW = win[6];
      const nSE = win[18];
      const nNE = win[8];
      const nSW = win[16];

      const isDarkHairlineRidge =
        v >= 64 &&
        ((v - nW >= 48 && v - nE >= 48) ||
          (v - nN >= 48 && v - nS >= 48) ||
          (v - nNW >= 48 && v - nSE >= 48) ||
          (v - nNE >= 48 && v - nSW >= 48));

      const isLightCounterValley =
        v <= 191 &&
        ((nW - v >= 48 && nE - v >= 48) ||
          (nN - v >= 48 && nS - v >= 48) ||
          (nNW - v >= 48 && nSE - v >= 48) ||
          (nNE - v >= 48 && nSW - v >= 48));

      if (isDarkHairlineRidge && !isLightCounterValley) {
        out[p] = v >= 96 ? 255 : v;
      } else if (isLightCounterValley && !isDarkHairlineRidge) {
        out[p] = v <= 159 ? 0 : v;
      } else {
        out[p] = v > bestThresh ? 255 : 0;
      }
    }
  }

  return out;
}

/**
 * Exact 2-pass Rosenfeld-Pfaltz 3-4 Chamfer Distance Transform in-place on Int32Array.
 * Pixels initialized to 0 act as zero-distance sources; positive entries (CHAMFER_INF)
 * receive shortest 3-4 chamfer distance without injecting artificial 0-distance at canvas borders.
 *
 * @param {Int32Array} dist
 * @param {number} width
 * @param {number} height
 */
function runChamfer34(dist, width, height) {
  // Pass 1: Forward (top-left -> bottom-right)
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const p = rowOff + x;
      let d = dist[p];
      if (d === 0) continue;
      if (x > 0) {
        const cand = dist[p - 1] + 3;
        if (cand < d) d = cand;
      }
      if (y > 0) {
        const up = p - width;
        let cand = dist[up] + 3;
        if (cand < d) d = cand;
        if (x > 0) {
          cand = dist[up - 1] + 4;
          if (cand < d) d = cand;
        }
        if (x + 1 < width) {
          cand = dist[up + 1] + 4;
          if (cand < d) d = cand;
        }
      }
      dist[p] = d;
    }
  }

  // Pass 2: Backward (bottom-right -> top-left)
  for (let y = height - 1; y >= 0; y--) {
    const rowOff = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const p = rowOff + x;
      let d = dist[p];
      if (d === 0) continue;
      if (x + 1 < width) {
        const cand = dist[p + 1] + 3;
        if (cand < d) d = cand;
      }
      if (y + 1 < height) {
        const dn = p + width;
        let cand = dist[dn] + 3;
        if (cand < d) d = cand;
        if (x + 1 < width) {
          cand = dist[dn + 1] + 4;
          if (cand < d) d = cand;
        }
        if (x > 0) {
          cand = dist[dn - 1] + 4;
          if (cand < d) d = cand;
        }
      }
      dist[p] = d;
    }
  }
}

/**
 * Stage A + Stage B CMYK Edge Conditioning:
 *   1. Separates wide Rich-Black fills (>= 2 * cellPitchPx, preserved 100% untouched)
 *      from narrow Rich-Black text/linework strokes (< 2 * cellPitchPx) adjacent to
 *      high-contrast light backgrounds, promoting narrow strokes to solo K = 255, C = M = Y = 0
 *      and stripping 1-px achromatic CMY fringe.
 *   2. Runs snapChannelEdges on C, M, Y, K outside protected wide Rich-Black fills.
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} channels
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.cellPitchPx=6.5]
 * @returns {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }}
 */
function snapCmykEdges(channels, width, height, options = {}) {
  if (!channels || !channels.C || !channels.M || !channels.Y || !channels.K) {
    throw new Error('snapCmykEdges: expected channels object with { C, M, Y, K } buffers');
  }
  const N = width * height;
  if (!(width > 0) || !(height > 0)) {
    return {
      C: new Uint8Array(0),
      M: new Uint8Array(0),
      Y: new Uint8Array(0),
      K: new Uint8Array(0),
    };
  }

  const srcC = channels.C;
  const srcM = channels.M;
  const srcY = channels.Y;
  const srcK = channels.K;
  if (srcC.length !== N || srcM.length !== N || srcY.length !== N || srcK.length !== N) {
    throw new Error(`snapCmykEdges: all C, M, Y, K buffers must have length ${N}`);
  }

  const outC = new Uint8Array(srcC);
  const outM = new Uint8Array(srcM);
  const outY = new Uint8Array(srcY);
  const outK = new Uint8Array(srcK);

  const cellPitchPx = Math.max(1.0, Number(options.cellPitchPx) || 6.5);
  const tHalf = Math.max(3, Math.floor(3 * cellPitchPx));
  // Diagonal corner reconstruction radius covers +6 margin and 4/3 diagonal chamfer ratio
  const reconRadius = Math.max(tHalf + 6, Math.ceil((4 * tHalf) / 3));

  // Step 1: Identify candidate Rich-Black core pixels R_core
  const rCore = new Uint8Array(N);
  let rCoreCount = 0;
  for (let p = 0; p < N; p++) {
    const k = srcK[p];
    if (k < 204) continue;
    const c = srcC[p];
    const m = srcM[p];
    const y = srcY[p];
    const maxCmy = c >= m ? (c >= y ? c : y) : m >= y ? m : y;
    if (maxCmy < 89) continue;
    const minCmy = c <= m ? (c <= y ? c : y) : m <= y ? m : y;
    if (maxCmy - minCmy <= 46) {
      rCore[p] = 1;
      rCoreCount++;
    }
  }

  const wWideProtect = new Uint8Array(N);

  if (rCoreCount > 0) {
    // Step 2: 2-pass 3-4 Chamfer Distance morphological opening (canvas-border bleed safe)
    const dist = new Int32Array(N);
    let hasZero = false;
    for (let p = 0; p < N; p++) {
      if (rCore[p]) {
        dist[p] = CHAMFER_INF;
      } else {
        dist[p] = 0;
        hasZero = true;
      }
    }

    const wWide = new Uint8Array(N);
    if (!hasZero) {
      // Entire canvas is solid Rich Black -> 100% wide fill
      wWide.fill(1);
    } else {
      runChamfer34(dist, width, height);

      // Seed wide interiors where dist >= tHalf and reconstruct back across R_core
      let seedCount = 0;
      for (let p = 0; p < N; p++) {
        if (rCore[p] && dist[p] >= tHalf) {
          dist[p] = 0;
          seedCount++;
        } else {
          dist[p] = CHAMFER_INF;
        }
      }

      if (seedCount > 0) {
        runChamfer34(dist, width, height);
        const queue = new Int32Array(N);
        let head = 0;
        let tail = 0;
        for (let p = 0; p < N; p++) {
          if (rCore[p] && dist[p] <= reconRadius) {
            wWide[p] = 1;
            queue[tail++] = p;
          }
        }
        // Geodesic closure across any corners/lobes connected to wide Rich-Black regions
        // within <= 4 px chamfer margin so wide rectangle corners stay 100% intact
        while (head < tail) {
          const cur = queue[head++];
          if (dist[cur] > reconRadius + 6) continue;
          const cx = cur % width;
          const cy = (cur - cx) / width;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= height) continue;
            const nRow = ny * width;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= width) continue;
              const np = nRow + nx;
              if (rCore[np] && !wWide[np] && dist[np] <= reconRadius + 6) {
                wWide[np] = 1;
                queue[tail++] = np;
              }
            }
          }
        }
      }
    }

    // Protect wide Rich-Black interiors + 2-px anti-aliased halo from any modification
    for (let y = 0; y < height; y++) {
      const rOff = y * width;
      for (let x = 0; x < width; x++) {
        if (!wWide[rOff + x]) continue;
        const yLo = y > 1 ? y - 2 : 0;
        const yHi = y + 2 < height ? y + 2 : height - 1;
        const xLo = x > 1 ? x - 2 : 0;
        const xHi = x + 2 < width ? x + 2 : width - 1;
        for (let ny = yLo; ny <= yHi; ny++) {
          const nRow = ny * width;
          for (let nx = xLo; nx <= xHi; nx++) {
            wWideProtect[nRow + nx] = 1;
          }
        }
      }
    }

    // Step 3: Narrow Rich-Black candidate strokes adjacent to high-contrast light backgrounds
    const rNarrow = new Uint8Array(N);
    const promoted = new Uint8Array(N);
    const bfs = new Int32Array(N);
    let qHead = 0;
    let qTail = 0;

    for (let y = 0; y < height; y++) {
      const rOff = y * width;
      for (let x = 0; x < width; x++) {
        const p = rOff + x;
        if (!rCore[p] || wWide[p]) continue;
        rNarrow[p] = 1;

        // Check 5x5 K contrast >= 96 and light background pole <= 32
        const yLo = y > 1 ? y - 2 : 0;
        const yHi = y + 2 < height ? y + 2 : height - 1;
        const xLo = x > 1 ? x - 2 : 0;
        const xHi = x + 2 < width ? x + 2 : width - 1;
        let kMin = 255;
        let kMax = 0;
        for (let ny = yLo; ny <= yHi; ny++) {
          const nRow = ny * width;
          for (let nx = xLo; nx <= xHi; nx++) {
            const kv = srcK[nRow + nx];
            if (kv < kMin) kMin = kv;
            if (kv > kMax) kMax = kv;
          }
        }
        if (kMin <= 32 && kMax - kMin >= 96) {
          promoted[p] = 1;
          bfs[qTail++] = p;
        }
      }
    }

    // Propagate across connected narrow stroke components so character stem interiors promote uniformly
    while (qHead < qTail) {
      const cur = bfs[qHead++];
      const cx = cur % width;
      const cy = (cur - cx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= width) continue;
          const np = nRow + nx;
          if (rNarrow[np] && !promoted[np] && !wWideProtect[np]) {
            promoted[np] = 1;
            bfs[qTail++] = np;
          }
        }
      }
    }

    // Promote narrow Rich-Black strokes to K = 255, C = M = Y = 0 and strip 1-px achromatic CMY fringe
    if (qTail > 0) {
      for (let y = 0; y < height; y++) {
        const rOff = y * width;
        for (let x = 0; x < width; x++) {
          const p = rOff + x;
          if (promoted[p]) {
            outK[p] = 255;
            outC[p] = 0;
            outM[p] = 0;
            outY[p] = 0;
            continue;
          }
          if (wWideProtect[p]) continue;

          // Check if 8-adjacent to a promoted narrow Rich-Black stroke pixel
          let adjPromoted = false;
          const yLo = y > 0 ? y - 1 : 0;
          const yHi = y + 1 < height ? y + 1 : height - 1;
          const xLo = x > 0 ? x - 1 : 0;
          const xHi = x + 1 < width ? x + 1 : width - 1;
          for (let ny = yLo; ny <= yHi && !adjPromoted; ny++) {
            const nRow = ny * width;
            for (let nx = xLo; nx <= xHi; nx++) {
              if (promoted[nRow + nx]) {
                adjPromoted = true;
                break;
              }
            }
          }
          if (!adjPromoted) continue;

          const kv = srcK[p];
          if (kv === 0) continue;
          const c = srcC[p];
          const m = srcM[p];
          const yv = srcY[p];
          const maxCmy = c >= m ? (c >= yv ? c : yv) : m >= yv ? m : yv;
          const minCmy = c <= m ? (c <= yv ? c : yv) : m <= yv ? m : yv;
          if (maxCmy > 0 && maxCmy - minCmy <= 46) {
            outC[p] = 0;
            outM[p] = 0;
            outY[p] = 0;
          }
        }
      }
    }
  }

  return {
    C: snapChannelEdges(outC, width, height, { protectMask: wWideProtect }),
    M: snapChannelEdges(outM, width, height, { protectMask: wWideProtect }),
    Y: snapChannelEdges(outY, width, height, { protectMask: wWideProtect }),
    K: snapChannelEdges(outK, width, height, { protectMask: wWideProtect }),
  };
}

module.exports = {
  snapChannelEdges,
  snapCmykEdges,
};

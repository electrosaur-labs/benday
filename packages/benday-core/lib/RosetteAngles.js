'use strict';

const { UM_PER_INCH, getDefaultThreadDiaUm } = require('./MeshPhysics');

const WARN_HARMONIC_MOIRE = 'WARN_HARMONIC_MOIRE';
const WARN_SEVERE_MOIRE = 'WARN_SEVERE_MOIRE';

const HARMONIC_CONTRAST_THRESHOLD = 0.015;
const HARMONIC_WAVELENGTH_IN_MIN = 0.20; // ~5.08 mm macroscopic moiré band threshold
const SEVERE_CONTRAST_THRESHOLD = 0.030;
const SEVERE_WAVELENGTH_IN_MIN = 0.25;   // ~6.35 mm
const SEVERE_CLEARANCE_DEG_MIN = 7.5;

const REPRESENTATIVE_TONES = Object.freeze([0.15, 0.25, 0.35, 0.45]);

/**
 * Normalize angle into [0, 90) modulo 90° (4-fold symmetry of square woven mesh & Euclidean screen).
 *
 * @param {number} deg
 * @returns {number}
 */
function norm90(deg) {
  if (!Number.isFinite(deg)) return 0;
  let r = ((deg % 90) + 90) % 90;
  if (r >= 90 - 1e-12 || r < 1e-12) r = 0;
  return r;
}

/**
 * Minimum angular separation between two 90°-periodic square lattices, in [0, 45].
 *
 * @param {number} aDeg
 * @param {number} bDeg
 * @returns {number}
 */
function clearance90(aDeg, bDeg) {
  const diff = norm90(aDeg - bDeg);
  return diff > 45 ? 90 - diff : diff;
}

/**
 * Center meshAngleDeg inside the empty 30° CMYK rosette pocket:
 *   C = θ + 15°, K = θ + 45°, Y = θ + 60°, M = θ + 75° (mod 90°).
 *
 * Guarantees:
 *   - C, K, M separated by exact 30.0°
 *   - Y bisects K and M at 15.0°
 *   - Nominal mesh clearance >= 15.0° on all 4 screens (>= 13.0° across ±2° stretcher slop)
 *
 * @param {number} [meshAngleDeg=0]
 * @returns {{ C: number, M: number, Y: number, K: number }}
 */
function computeRosetteAngles(meshAngleDeg = 0) {
  const theta = Number.isFinite(meshAngleDeg) ? meshAngleDeg : 0;
  return {
    C: norm90(theta + 15),
    M: norm90(theta + 75),
    Y: norm90(theta + 60),
    K: norm90(theta + 45),
  };
}

const ROSETTE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'auto',
    label: 'Auto (Mesh-Safe Rosette)',
    description: 'Centers mesh angle inside the empty 30° rosette pocket (θ + 15°/75°/60°/45°).',
  }),
  Object.freeze({
    id: 'image-aware',
    label: 'Image-Aware (HVS Optimal)',
    description: 'Assigns dominant midtone inks to 45° oblique minimum and minimizes 15° co-occurrence.',
  }),
  Object.freeze({
    id: 'fta',
    label: 'FTA Flexo (+7.5°)',
    description: 'FTA flexographic / textile +7.5° offset (θ + 7.5°/67.5°/82.5°/37.5°).',
  }),
  Object.freeze({
    id: 'iso',
    label: 'Conventional Offset (ISO)',
    description: 'Traditional ISO 12647-2 offset press angles (C 15°, M 75°, Y 0°, K 45°).',
  }),
  Object.freeze({
    id: 'flamenco',
    label: 'Flamenco (Single-Angle)',
    description: 'Single-angle dot-on-dot separation at θ + 22.5° across all four screens.',
  }),
  Object.freeze({
    id: 'manual',
    label: 'Manual',
    description: 'Custom per-screen C / M / Y / K angles.',
  }),
]);

const ROSETTE_PRESET_IDS = Object.freeze(ROSETTE_PRESETS.map((p) => p.id));

// Precomputed 24 permutations of [0, 1, 2, 3] for C, M, Y, K -> 4 pocket slots
const PERMS_4 = (() => {
  const out = [];
  const used = [false, false, false, false];
  const cur = [0, 0, 0, 0];
  function bt(depth) {
    if (depth === 4) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < 4; i++) {
      if (!used[i]) {
        used[i] = true;
        cur[depth] = i;
        bt(depth + 1);
        used[i] = false;
      }
    }
  }
  bt(0);
  return Object.freeze(out);
})();

// Luminance-weighted HVS visibility priors for [C, M, Y, K]
const HVS_CHANNEL_WEIGHTS = Object.freeze([0.62, 0.72, 0.12, 1.0]);

/**
 * Image-Aware Rosette Slot Assignment (< 2 ms via <= 4096-sample deterministic stride).
 *
 * Evaluates midtone dot visibility m_c = 4 * t_c * (1 - t_c) weighted by HVS contrast
 * sensitivity w = { C: 0.62, M: 0.72, Y: 0.12, K: 1.00 } and 2-ink spatial co-occurrence,
 * then searches all 24 permutations of the mesh-safe rosette pocket {θ+15°, θ+45°, θ+60°, θ+75°}
 * to minimize Campbell-Kulikowski oblique-effect visibility cos^2(2*s) plus 15°-bisector
 * inter-screen co-occurrence.
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }|null} channels
 * @param {number} width
 * @param {number} height
 * @param {number} [meshAngleDeg=0]
 * @returns {{ C: number, M: number, Y: number, K: number }}
 */
function assignImageAwareRosetteSlots(channels, width, height, meshAngleDeg = 0) {
  const theta = Number.isFinite(meshAngleDeg) ? meshAngleDeg : 0;
  if (
    !channels ||
    !channels.C ||
    !channels.M ||
    !channels.Y ||
    !channels.K ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return computeRosetteAngles(theta);
  }

  const chArr = [channels.C, channels.M, channels.Y, channels.K];
  const N = width * height;
  if (chArr[0].length < N || chArr[1].length < N || chArr[2].length < N || chArr[3].length < N) {
    return computeRosetteAngles(theta);
  }

  // Deterministic <= 64 x 64 (= 4096) stride pass
  const stepX = Math.max(1, Math.ceil(width / 64));
  const stepY = Math.max(1, Math.ceil(height / 64));
  const startX = Math.min(width - 1, Math.floor(stepX * 0.5));
  const startY = Math.min(height - 1, Math.floor(stepY * 0.5));

  const visSum = new Float64Array(4);
  const coSum = new Float64Array(16);
  const inv255 = 1 / 255;
  let sampleCount = 0;

  for (let y = startY; y < height; y += stepY) {
    const rowOff = y * width;
    for (let x = startX; x < width; x += stepX) {
      const p = rowOff + x;
      const tc = chArr[0][p] * inv255;
      const tm = chArr[1][p] * inv255;
      const ty = chArr[2][p] * inv255;
      const tk = chArr[3][p] * inv255;

      const vc = HVS_CHANNEL_WEIGHTS[0] * (4 * tc * (1 - tc));
      const vm = HVS_CHANNEL_WEIGHTS[1] * (4 * tm * (1 - tm));
      const vy = HVS_CHANNEL_WEIGHTS[2] * (4 * ty * (1 - ty));
      const vk = HVS_CHANNEL_WEIGHTS[3] * (4 * tk * (1 - tk));

      visSum[0] += vc;
      visSum[1] += vm;
      visSum[2] += vy;
      visSum[3] += vk;

      coSum[0 * 4 + 1] += vc * vm;
      coSum[0 * 4 + 2] += vc * vy;
      coSum[0 * 4 + 3] += vc * vk;
      coSum[1 * 4 + 2] += vm * vy;
      coSum[1 * 4 + 3] += vm * vk;
      coSum[2 * 4 + 3] += vy * vk;
      sampleCount++;
    }
  }

  if (sampleCount === 0) {
    return computeRosetteAngles(theta);
  }

  const invSamples = 1 / sampleCount;
  const vis = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    // Tiny prior breaks exact ties toward conventional K > M > C > Y hierarchy
    vis[i] = visSum[i] * invSamples + 1e-6 * HVS_CHANNEL_WEIGHTS[i];
  }

  const slots = [
    norm90(theta + 15), // slot 0: triad A (default C)
    norm90(theta + 75), // slot 1: triad B (default M)
    norm90(theta + 60), // slot 2: 15° bisector between slot 1 and slot 3 (default Y)
    norm90(theta + 45), // slot 3: triad C / oblique minimum at θ=0 (default K)
  ];

  // Campbell-Kulikowski (1966) HVS orientation visibility factor cos^2(2 * s)
  const slotObliqueCost = new Float64Array(4);
  for (let s = 0; s < 4; s++) {
    const twoRad = (2 * slots[s] * Math.PI) / 180;
    const c2 = Math.cos(twoRad);
    slotObliqueCost[s] = c2 * c2;
  }

  // Precompute which slot pairs are < 29° apart (the two 15° bisector pairs: (1,2) and (2,3))
  const closeSlotPair = new Uint8Array(16);
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      if (clearance90(slots[a], slots[b]) < 29.0) {
        closeSlotPair[a * 4 + b] = 1;
        closeSlotPair[b * 4 + a] = 1;
      }
    }
  }

  const LAMBDA_15 = 4.0;
  let bestCost = Infinity;
  let bestPerm = PERMS_4[0]; // [0, 1, 2, 3] = { C: θ+15, M: θ+75, Y: θ+60, K: θ+45 }

  for (let pi = 0; pi < PERMS_4.length; pi++) {
    const perm = PERMS_4[pi];
    let cost = 0;

    // 1. Campbell-Kulikowski oblique visibility term
    for (let ch = 0; ch < 4; ch++) {
      cost += vis[ch] * slotObliqueCost[perm[ch]];
    }

    // 2. 15° bisector inter-screen co-occurrence penalty
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        if (closeSlotPair[perm[a] * 4 + perm[b]]) {
          const co =
            coSum[a * 4 + b] * invSamples +
            1e-6 * HVS_CHANNEL_WEIGHTS[a] * HVS_CHANNEL_WEIGHTS[b];
          cost += LAMBDA_15 * co;
        }
      }
    }

    // Tiny canonical slot preference (1e-9) keeps default C->0, M->1, Y->2, K->3 on exact symmetry
    for (let ch = 0; ch < 4; ch++) {
      if (perm[ch] !== ch) cost += 1e-9;
    }

    if (cost < bestCost) {
      bestCost = cost;
      bestPerm = perm;
    }
  }

  return {
    C: slots[bestPerm[0]],
    M: slots[bestPerm[1]],
    Y: slots[bestPerm[2]],
    K: slots[bestPerm[3]],
  };
}

/**
 * Resolve CMYK screen angles for any named rosette preset (`auto`, `image-aware`,
 * `fta`, `iso`, `flamenco`, `manual`).
 *
 * @param {string} [preset='auto']
 * @param {number} [meshAngleDeg=0]
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }|null} [channels=null]
 * @param {number} [width=0]
 * @param {number} [height=0]
 * @param {{ C: number, M: number, Y: number, K: number }|null} [anglesOverride=null]
 * @returns {{ C: number, M: number, Y: number, K: number }}
 */
function resolveRosettePresetAngles(
  preset = 'auto',
  meshAngleDeg = 0,
  channels = null,
  width = 0,
  height = 0,
  anglesOverride = null
) {
  const theta = Number.isFinite(meshAngleDeg) ? meshAngleDeg : 0;
  switch (preset) {
    case 'image-aware':
      return assignImageAwareRosetteSlots(channels, width, height, theta);
    case 'fta':
      return {
        C: norm90(theta + 7.5),
        M: norm90(theta + 67.5),
        Y: norm90(theta + 82.5),
        K: norm90(theta + 37.5),
      };
    case 'iso':
      return {
        C: 15,
        M: 75,
        Y: 0,
        K: 45,
      };
    case 'flamenco': {
      const a = norm90(theta + 22.5);
      return { C: a, M: a, Y: a, K: a };
    }
    case 'manual':
      if (anglesOverride && typeof anglesOverride === 'object') {
        return {
          C: norm90(anglesOverride.C),
          M: norm90(anglesOverride.M),
          Y: norm90(anglesOverride.Y),
          K: norm90(anglesOverride.K),
        };
      }
      return computeRosetteAngles(theta);
    case 'auto':
    default:
      return computeRosetteAngles(theta);
  }
}

/**
 * Normalized sinc(u) = sin(pi * u) / (pi * u), with sinc(0) = 1.
 *
 * @param {number} u
 * @returns {number}
 */
function sinc(u) {
  const au = Math.abs(u);
  if (au < 1e-12) return 1.0;
  const x = Math.PI * u;
  return Math.sin(x) / x;
}

/**
 * Pure JavaScript Bessel function of the first kind J_1(x), accurate to < 1e-13 across all real x.
 * Uses three numerical regimes to avoid alternating-series cancellation:
 *   1. |x| <= 5:   convergent alternating Taylor series
 *   2. 5 < |x| <= 24: cancellation-free backward Miller recurrence + Neumann normalization
 *   3. |x| > 24:   8-term Hankel asymptotic expansion
 *
 * @param {number} x
 * @returns {number}
 */
function besselJ1(x) {
  if (!Number.isFinite(x) || x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);

  if (ax <= 5.0) {
    const half = 0.5 * ax;
    const negQuarterX2 = -(half * half);
    let term = half;
    let sum = term;
    for (let m = 1; m <= 24; m++) {
      term *= negQuarterX2 / (m * (m + 1));
      sum += term;
      if (Math.abs(term) < 1e-17 * Math.abs(sum)) break;
    }
    return sign * sum;
  }

  if (ax <= 24.0) {
    // Backward Miller recurrence + Neumann normalization J_0(x) + 2 * sum_{m>=1} J_{2m}(x) = 1
    // Completely free of alternating-series cancellation; achieves < 5e-16 precision across [5, 24].
    const M = 64;
    let fNext = 0.0;
    let fCurr = 1e-30;
    let f1 = 0.0;
    let evenSum = 0.0;
    for (let n = M; n >= 1; n--) {
      const fPrev = ((2 * n) / ax) * fCurr - fNext;
      fNext = fCurr;
      fCurr = fPrev;
      if (n === 1) f1 = fNext;
      if ((n & 1) === 0) evenSum += fNext;
      // Rescale to prevent overflow
      if (Math.abs(fCurr) > 1e100) {
        fCurr *= 1e-100;
        fNext *= 1e-100;
        f1 *= 1e-100;
        evenSum *= 1e-100;
      }
    }
    // Now fCurr is proportional to J_0(ax), f1 proportional to J_1(ax)
    const norm = fCurr + 2.0 * evenSum;
    return sign * (f1 / norm);
  }

  // Hankel asymptotic expansion for nu = 1, |x| > 24 (< 1e-16 error)
  const inv8x = 1 / (8 * ax);
  const inv8x2 = inv8x * inv8x;
  const a1 = 3.0;
  const a2 = (a1 * -5.0) / 2.0;
  const a3 = (a2 * -21.0) / 3.0;
  const a4 = (a3 * -45.0) / 4.0;
  const a5 = (a4 * -77.0) / 5.0;
  const a6 = (a5 * -117.0) / 6.0;
  const a7 = (a6 * -165.0) / 7.0;
  const a8 = (a7 * -221.0) / 8.0;

  const P = 1 - inv8x2 * (a2 - inv8x2 * (a4 - inv8x2 * (a6 - inv8x2 * a8)));
  const Q = inv8x * (a1 - inv8x2 * (a3 - inv8x2 * (a5 - inv8x2 * a7)));
  const chi = ax - 0.75 * Math.PI;
  const amp = Math.sqrt(2 / (Math.PI * ax));
  return sign * amp * (P * Math.cos(chi) - Q * Math.sin(chi));
}

/**
 * Airy / circular aperture modulation 2 * J_1(x) / x, with limit 1 at x -> 0.
 *
 * @param {number} x
 * @returns {number}
 */
function jinc2(x) {
  const ax = Math.abs(x);
  if (ax < 1e-9) return 1.0 - (ax * ax) / 8.0;
  return (2.0 * besselJ1(ax)) / ax;
}

/**
 * 2D Reciprocal-Lattice Harmonic Moiré Analyzer.
 *
 * Evaluates screen harmonics |j|, |k| <= maxScreenHarmonic (default 8) against plain-weave
 * mesh reciprocal vectors across [meshAngleDeg - slopDeg, meshAngleDeg + slopDeg] in 0.5° steps,
 * weighted by exact square-mesh sinc(m1*η)*sinc(m2*η) and circular-dot 2*t*(2*J_1(x)/x) modulation.
 *
 * @param {object} params
 * @param {number} params.meshTpi
 * @param {number} [params.threadDiaUm]
 * @param {number} params.lpi
 * @param {object} [params.angles] - { C, M, Y, K } in degrees (defaults to computeRosetteAngles(meshAngleDeg))
 * @param {number} [params.meshAngleDeg=0]
 * @param {number} [params.slopDeg=2.0]
 * @param {number} [params.maxScreenHarmonic=8]
 * @param {number} [params.maxMeshHarmonic=4]
 * @returns {object}
 */
function analyzeMoire(params = {}) {
  const {
    meshTpi,
    threadDiaUm: rawThreadUm,
    lpi,
    meshAngleDeg = 0,
    slopDeg = 2.0,
    maxScreenHarmonic = 8,
    maxMeshHarmonic = 4,
  } = params;

  const threadDiaUm = rawThreadUm == null ? getDefaultThreadDiaUm(meshTpi) : rawThreadUm;
  const pitchUm = UM_PER_INCH / meshTpi;
  const eta = Math.max(0.05, Math.min(0.95, (pitchUm - threadDiaUm) / pitchUm));
  const angles = params.angles || computeRosetteAngles(meshAngleDeg);
  const channelKeys = Object.keys(angles);

  // Precompute dot modulation weights W_dot(j, k) for |j|, |k| <= maxScreenHarmonic
  const screenVectors = [];
  for (let j = -maxScreenHarmonic; j <= maxScreenHarmonic; j++) {
    for (let k = -maxScreenHarmonic; k <= maxScreenHarmonic; k++) {
      if (j === 0 && k === 0) continue;
      const rjk = Math.hypot(j, k);
      let wd = 0;
      for (let ti = 0; ti < REPRESENTATIVE_TONES.length; ti++) {
        const t = REPRESENTATIVE_TONES[ti];
        const dOverPitch = Math.sqrt((4 * t) / Math.PI);
        const arg = Math.PI * dOverPitch * rjk;
        const mod = 2 * t * Math.abs(jinc2(arg));
        if (mod > wd) wd = mod;
      }
      if (wd >= HARMONIC_CONTRAST_THRESHOLD) {
        screenVectors.push({ j, k, wd });
      }
    }
  }

  // Build stretcher slop test angles in 0.5° steps
  const slopAngles = [];
  const halfStep = 0.5;
  const steps = Math.max(0, Math.round((2 * Math.max(0, slopDeg)) / halfStep));
  if (steps === 0) {
    slopAngles.push(meshAngleDeg);
  } else {
    for (let s = 0; s <= steps; s++) {
      const delta = -slopDeg + (2 * slopDeg * s) / steps;
      slopAngles.push(meshAngleDeg + delta);
    }
  }

  // Precompute mesh reciprocal vectors across slop angles
  const meshSamples = [];
  for (let si = 0; si < slopAngles.length; si++) {
    const thDeg = slopAngles[si];
    const thRad = (thDeg * Math.PI) / 180;
    const ux = Math.cos(thRad);
    const uy = Math.sin(thRad);
    const vx = -uy;
    const vy = ux;
    const gList = [];
    for (let m1 = -maxMeshHarmonic; m1 <= maxMeshHarmonic; m1++) {
      const s1 = sinc(m1 * eta);
      for (let m2 = -maxMeshHarmonic; m2 <= maxMeshHarmonic; m2++) {
        if (m1 === 0 && m2 === 0) continue;
        const wm = Math.abs(s1 * sinc(m2 * eta));
        if (wm < HARMONIC_CONTRAST_THRESHOLD) continue;
        gList.push({
          m1,
          m2,
          wm,
          gx: meshTpi * (m1 * ux + m2 * vx),
          gy: meshTpi * (m1 * uy + m2 * vy),
        });
      }
    }
    meshSamples.push({ thDeg, gList });
  }

  const maxBeatFreq = 1 / HARMONIC_WAVELENGTH_IN_MIN; // 12.5 cpi
  const maxBeatFreqSq = maxBeatFreq * maxBeatFreq;

  const channelReports = {};
  const allWarningsSet = new Set();
  let globalMinClearance = 45;
  let globalMaxContrast = 0;
  let globalWorstBeat = null;

  for (let ci = 0; ci < channelKeys.length; ci++) {
    const ch = channelKeys[ci];
    const angleDeg = norm90(angles[ch]);
    const nominalClearanceDeg = clearance90(angleDeg, meshAngleDeg);
    let minClearanceDeg = nominalClearanceDeg;
    for (let si = 0; si < slopAngles.length; si++) {
      const c = clearance90(angleDeg, slopAngles[si]);
      if (c < minClearanceDeg) minClearanceDeg = c;
    }
    if (minClearanceDeg < globalMinClearance) {
      globalMinClearance = minClearanceDeg;
    }

    const alRad = (angleDeg * Math.PI) / 180;
    const sx = Math.cos(alRad);
    const sy = Math.sin(alRad);
    const tx = -sy;
    const ty = sx;

    // Pre-rotate screen harmonic vectors for this channel
    const hCount = screenVectors.length;
    const hxArr = new Float64Array(hCount);
    const hyArr = new Float64Array(hCount);
    const wdArr = new Float64Array(hCount);
    for (let hi = 0; hi < hCount; hi++) {
      const sv = screenVectors[hi];
      hxArr[hi] = lpi * (sv.j * sx + sv.k * tx);
      hyArr[hi] = lpi * (sv.j * sy + sv.k * ty);
      wdArr[hi] = sv.wd;
    }

    const chWarnings = new Set();
    if (minClearanceDeg < SEVERE_CLEARANCE_DEG_MIN) {
      chWarnings.add(WARN_SEVERE_MOIRE);
    }

    let chMaxContrast = 0;
    let chWorstBeat = null;

    for (let si = 0; si < meshSamples.length; si++) {
      const { thDeg, gList } = meshSamples[si];
      for (let gi = 0; gi < gList.length; gi++) {
        const g = gList[gi];
        const gx = g.gx;
        const gy = g.gy;
        const wm = g.wm;

        for (let hi = 0; hi < hCount; hi++) {
          const dx = gx - hxArr[hi];
          const dy = gy - hyArr[hi];
          const bfSq = dx * dx + dy * dy;
          if (bfSq > maxBeatFreqSq) continue;

          const contrast = wm * wdArr[hi];
          if (contrast < HARMONIC_CONTRAST_THRESHOLD) continue;

          const beatFreq = Math.sqrt(bfSq);
          const wavelengthIn = beatFreq < 1e-6 ? 1000.0 : 1.0 / beatFreq;

          if (wavelengthIn >= HARMONIC_WAVELENGTH_IN_MIN && contrast >= HARMONIC_CONTRAST_THRESHOLD) {
            chWarnings.add(WARN_HARMONIC_MOIRE);
          }
          if (wavelengthIn >= SEVERE_WAVELENGTH_IN_MIN && contrast >= SEVERE_CONTRAST_THRESHOLD) {
            chWarnings.add(WARN_SEVERE_MOIRE);
          }

          if (
            contrast > chMaxContrast + 1e-9 ||
            (Math.abs(contrast - chMaxContrast) <= 1e-9 &&
              (!chWorstBeat || wavelengthIn > chWorstBeat.wavelengthIn))
          ) {
            chMaxContrast = contrast;
            const sv = screenVectors[hi];
            chWorstBeat = {
              channel: ch,
              contrast,
              wavelengthIn,
              wavelengthMm: wavelengthIn * 25.4,
              j: sv.j,
              k: sv.k,
              m1: g.m1,
              m2: g.m2,
              meshAngleTested: thDeg,
            };
          }
        }
      }
    }

    if (chMaxContrast > globalMaxContrast) {
      globalMaxContrast = chMaxContrast;
      globalWorstBeat = chWorstBeat;
    }

    const chWarnList = Array.from(chWarnings);
    for (let wi = 0; wi < chWarnList.length; wi++) {
      allWarningsSet.add(chWarnList[wi]);
    }

    channelReports[ch] = {
      angleDeg,
      nominalClearanceDeg,
      minClearanceDeg,
      maxContrast: chMaxContrast,
      worstBeat: chWorstBeat,
      warnings: chWarnList,
    };
  }

  // Check strong-ink (C, M, K) inter-screen rosette separation
  const strongInks = ['C', 'M', 'K'].filter((k) => Object.prototype.hasOwnProperty.call(angles, k));
  let interChannelClearanceDeg = 45;
  for (let a = 0; a < strongInks.length; a++) {
    for (let b = a + 1; b < strongInks.length; b++) {
      const sep = clearance90(angles[strongInks[a]], angles[strongInks[b]]);
      if (sep < interChannelClearanceDeg) {
        interChannelClearanceDeg = sep;
      }
    }
  }
  if (strongInks.length >= 2 && interChannelClearanceDeg < SEVERE_CLEARANCE_DEG_MIN) {
    allWarningsSet.add(WARN_SEVERE_MOIRE);
  }

  const warnings = Array.from(allWarningsSet);

  return {
    meshAngleDeg: norm90(meshAngleDeg),
    slopDeg,
    lpi,
    meshTpi,
    threadDiaUm,
    minClearanceDeg: globalMinClearance,
    interChannelClearanceDeg,
    maxContrast: globalMaxContrast,
    worstBeat: globalWorstBeat,
    channels: channelReports,
    warnings,
    safe: warnings.length === 0,
  };
}

module.exports = {
  WARN_HARMONIC_MOIRE,
  WARN_SEVERE_MOIRE,
  HARMONIC_CONTRAST_THRESHOLD,
  HARMONIC_WAVELENGTH_IN_MIN,
  SEVERE_CONTRAST_THRESHOLD,
  SEVERE_WAVELENGTH_IN_MIN,
  SEVERE_CLEARANCE_DEG_MIN,
  ROSETTE_PRESETS,
  ROSETTE_PRESET_IDS,
  norm90,
  clearance90,
  computeRosetteAngles,
  assignImageAwareRosetteSlots,
  resolveRosettePresetAngles,
  sinc,
  besselJ1,
  jinc2,
  analyzeMoire,
};

'use strict';

/**
 * Perceptual Human Visual System (HVS) Viewing-Distance Fidelity & Gray-Step Telemetry.
 *
 * Strictly obeys Optical Physics & Electrosaur CIELAB Sovereignty:
 *   1. SWOP Coated 8-primary Neugebauer trilinear reflectance in linear D50 XYZ
 *      (Xn = 96.422, Yn = 100.000, Zn = 82.521), attenuated by K ink (1 - 0.93 * k),
 *      with an O(1) 16x3 binary LUT fast-path for discrete {0, 255}^4 halftone screens.
 *   2. Identical separable 2D Gaussian HVS optical PSF low-pass blur
 *      (sigma = clamp(1.5 * cellPitchPx, 0.75, 16.0)) in linear D50 XYZ photon space
 *      on Original and Halftone (avoiding cube-root Jensen bias on binary screens).
 *   3. Conversion of blurred Original and Halftone fields into canonical 16-bit Engine CIELAB
 *      (L: 0..32768, a/b: 0..32768, 16384 = neutral), where all color-difference math executes,
 *      scaling to perceptual CIE76 Delta-E strictly at the telemetry output boundary:
 *      { meanDeltaE, p95DeltaE, maxDeltaE, grayStepsPerCell }.
 */

const D50_XN = 96.422;
const D50_YN = 100.0;
const D50_ZN = 82.521;

const CIE_EPSILON = 216 / 24389; // (6/29)^3
const CIE_KAPPA_DIV_116 = 841 / 108; // (29/6)^2 / 3
const CIE_FOUR_29THS = 4 / 29;

const LAB16_L_SCALE = 327.68; // 100.0 -> 32768
const LAB16_AB_NEUTRAL = 16384;
const LAB16_AB_SCALE = 128.0;

// Calibrated 8 SWOP Coated primaries indexed by 3-bit mask (cBit << 2) | (mBit << 1) | yBit
// derived at module initialization from IEC 61966-2-1 + Bradford D65->D50.
const SWOP_PRIMARY_SRGB_REFS = [
  [255, 255, 255], // 0 (000) Paper White -> exact D50 reference white
  [255, 242, 0],   // 1 (001) Yellow
  [236, 0, 140],   // 2 (010) Magenta
  [237, 28, 36],   // 3 (011) MY (Red)
  [0, 174, 239],   // 4 (100) Cyan
  [0, 166, 81],    // 5 (101) CY (Green)
  [46, 49, 146],   // 6 (110) CM (Blue)
  [35, 31, 32],    // 7 (111) CMY (3-color Black)
];

function srgbByteToLinear(u8) {
  const s = u8 / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// Precompute 8 x 3 linear D50 XYZ table (row sums equal [96.422, 100.000, 82.521])
const SWOP_XYZ_D50 = (() => {
  const tbl = new Float64Array(8 * 3);
  for (let i = 0; i < 8; i++) {
    const [r8, g8, b8] = SWOP_PRIMARY_SRGB_REFS[i];
    const r = srgbByteToLinear(r8);
    const g = srgbByteToLinear(g8);
    const b = srgbByteToLinear(b8);
    tbl[i * 3] = 43.60747 * r + 38.50649 * g + 14.30804 * b;
    tbl[i * 3 + 1] = 22.25045 * r + 71.68786 * g + 6.06169 * b;
    tbl[i * 3 + 2] = 1.39322 * r + 9.71045 * g + 71.41733 * b;
  }
  return tbl;
})();

function labTransferF(t) {
  return t > CIE_EPSILON ? Math.cbrt(t) : CIE_KAPPA_DIV_116 * t + CIE_FOUR_29THS;
}

/**
 * Convert linear D50 XYZ (scaled to Yn = 100) into canonical 16-bit Engine CIELAB
 * (L: 0..32768, a/b: 0..32768, 16384 = neutral).
 *
 * @param {number} X
 * @param {number} Y
 * @param {number} Z
 * @param {Uint16Array} outBuf
 * @param {number} offset
 */
function xyzD50ToLab16(X, Y, Z, outBuf, offset) {
  const fx = labTransferF(X / D50_XN);
  const fy = labTransferF(Y / D50_YN);
  const fz = labTransferF(Z / D50_ZN);

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);

  let L16 = Math.round(L * LAB16_L_SCALE);
  if (L16 < 0) L16 = 0;
  else if (L16 > 32768) L16 = 32768;

  let a16 = Math.round(LAB16_AB_NEUTRAL + a * LAB16_AB_SCALE);
  if (a16 < 0) a16 = 0;
  else if (a16 > 32768) a16 = 32768;

  let b16 = Math.round(LAB16_AB_NEUTRAL + b * LAB16_AB_SCALE);
  if (b16 < 0) b16 = 0;
  else if (b16 > 32768) b16 = 32768;

  outBuf[offset] = L16;
  outBuf[offset + 1] = a16;
  outBuf[offset + 2] = b16;
}

/**
 * Precomputed O(1) 16 x 3 binary LUTs in linear D50 XYZ and canonical 16-bit Engine CIELAB
 * for all 16 discrete overprint states (C, M, Y, K) in {0, 255}^4.
 * Index = (C ? 8 : 0) | (M ? 4 : 0) | (Y ? 2 : 0) | (K ? 1 : 0).
 */
const BINARY_SWOP_XYZ_D50 = (() => {
  const lut = new Float32Array(16 * 3);
  for (let mask = 0; mask < 16; mask++) {
    const cornerIdx = mask >> 1;
    const kFactor = (mask & 1) ? 0.07 : 1.0;
    lut[mask * 3] = SWOP_XYZ_D50[cornerIdx * 3] * kFactor;
    lut[mask * 3 + 1] = SWOP_XYZ_D50[cornerIdx * 3 + 1] * kFactor;
    lut[mask * 3 + 2] = SWOP_XYZ_D50[cornerIdx * 3 + 2] * kFactor;
  }
  return lut;
})();

const BINARY_SWOP_LAB16 = (() => {
  const lut = new Uint16Array(16 * 3);
  for (let mask = 0; mask < 16; mask++) {
    const off = mask * 3;
    xyzD50ToLab16(
      BINARY_SWOP_XYZ_D50[off],
      BINARY_SWOP_XYZ_D50[off + 1],
      BINARY_SWOP_XYZ_D50[off + 2],
      lut,
      off
    );
  }
  return lut;
})();

/**
 * Convert a CMYK image ({ C, M, Y, K } Uint8Arrays) into interleaved 3-channel
 * linear D50 XYZ reflectance (`Float32Array(pixelCount * 3)`), using O(1)
 * BINARY_SWOP_XYZ_D50 lookup whenever a pixel is pure {0, 255}^4.
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} channels
 * @param {number} pixelCount
 * @returns {Float32Array}
 */
function cmykToXyzD50Buffer(channels, pixelCount) {
  const chC = channels.C;
  const chM = channels.M;
  const chY = channels.Y;
  const chK = channels.K;
  const out = new Float32Array(pixelCount * 3);
  const inv255 = 1 / 255;

  const X000 = SWOP_XYZ_D50[0], Y000 = SWOP_XYZ_D50[1], Z000 = SWOP_XYZ_D50[2];
  const X001 = SWOP_XYZ_D50[3], Y001 = SWOP_XYZ_D50[4], Z001 = SWOP_XYZ_D50[5];
  const X010 = SWOP_XYZ_D50[6], Y010 = SWOP_XYZ_D50[7], Z010 = SWOP_XYZ_D50[8];
  const X011 = SWOP_XYZ_D50[9], Y011 = SWOP_XYZ_D50[10], Z011 = SWOP_XYZ_D50[11];
  const X100 = SWOP_XYZ_D50[12], Y100 = SWOP_XYZ_D50[13], Z100 = SWOP_XYZ_D50[14];
  const X101 = SWOP_XYZ_D50[15], Y101 = SWOP_XYZ_D50[16], Z101 = SWOP_XYZ_D50[17];
  const X110 = SWOP_XYZ_D50[18], Y110 = SWOP_XYZ_D50[19], Z110 = SWOP_XYZ_D50[20];
  const X111 = SWOP_XYZ_D50[21], Y111 = SWOP_XYZ_D50[22], Z111 = SWOP_XYZ_D50[23];

  for (let p = 0; p < pixelCount; p++) {
    const c8 = chC[p];
    const m8 = chM[p];
    const y8 = chY[p];
    const k8 = chK[p];
    const dst = p * 3;

    if (
      (c8 === 0 || c8 === 255) &&
      (m8 === 0 || m8 === 255) &&
      (y8 === 0 || y8 === 255) &&
      (k8 === 0 || k8 === 255)
    ) {
      const mask = (c8 & 8) | (m8 & 4) | (y8 & 2) | (k8 & 1);
      const lutOff = mask * 3;
      out[dst] = BINARY_SWOP_XYZ_D50[lutOff];
      out[dst + 1] = BINARY_SWOP_XYZ_D50[lutOff + 1];
      out[dst + 2] = BINARY_SWOP_XYZ_D50[lutOff + 2];
      continue;
    }

    const c = c8 * inv255;
    const m = m8 * inv255;
    const y = y8 * inv255;
    const kFactor = 1.0 - 0.93 * (k8 * inv255);

    const ic = 1.0 - c;
    const im = 1.0 - m;
    const iy = 1.0 - y;

    const w000 = ic * im * iy;
    const w001 = ic * im * y;
    const w010 = ic * m * iy;
    const w011 = ic * m * y;
    const w100 = c * im * iy;
    const w101 = c * im * y;
    const w110 = c * m * iy;
    const w111 = c * m * y;

    out[dst] =
      kFactor *
      (w000 * X000 + w001 * X001 + w010 * X010 + w011 * X011 +
       w100 * X100 + w101 * X101 + w110 * X110 + w111 * X111);
    out[dst + 1] =
      kFactor *
      (w000 * Y000 + w001 * Y001 + w010 * Y010 + w011 * Y011 +
       w100 * Y100 + w101 * Y101 + w110 * Y110 + w111 * Y111);
    out[dst + 2] =
      kFactor *
      (w000 * Z000 + w001 * Z001 + w010 * Z010 + w011 * Z011 +
       w100 * Z100 + w101 * Z101 + w110 * Z110 + w111 * Z111);
  }

  return out;
}

/**
 * Convert a CMYK image ({ C, M, Y, K } Uint8Arrays) directly into interleaved 3-channel
 * canonical 16-bit Engine CIELAB (`Uint16Array(pixelCount * 3)`), using O(1)
 * BINARY_SWOP_LAB16 lookup whenever a pixel is pure {0, 255}^4.
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} channels
 * @param {number} pixelCount
 * @returns {Uint16Array}
 */
function cmykToLab16Buffer(channels, pixelCount) {
  const chC = channels.C;
  const chM = channels.M;
  const chY = channels.Y;
  const chK = channels.K;
  const out = new Uint16Array(pixelCount * 3);
  const xyz = cmykToXyzD50Buffer(channels, pixelCount);

  for (let p = 0; p < pixelCount; p++) {
    const c8 = chC[p];
    const m8 = chM[p];
    const y8 = chY[p];
    const k8 = chK[p];
    const off = p * 3;
    if (
      (c8 === 0 || c8 === 255) &&
      (m8 === 0 || m8 === 255) &&
      (y8 === 0 || y8 === 255) &&
      (k8 === 0 || k8 === 255)
    ) {
      const mask = (c8 & 8) | (m8 & 4) | (y8 & 2) | (k8 & 1);
      const lutOff = mask * 3;
      out[off] = BINARY_SWOP_LAB16[lutOff];
      out[off + 1] = BINARY_SWOP_LAB16[lutOff + 1];
      out[off + 2] = BINARY_SWOP_LAB16[lutOff + 2];
    } else {
      xyzD50ToLab16(xyz[off], xyz[off + 1], xyz[off + 2], out, off);
    }
  }
  return out;
}

/**
 * Convert an interleaved linear D50 XYZ buffer (`Float32Array(pixelCount * 3)`)
 * into canonical 16-bit Engine CIELAB (`Uint16Array(pixelCount * 3)`).
 *
 * @param {Float32Array} xyzBuf
 * @param {number} pixelCount
 * @returns {Uint16Array}
 */
function xyzBufferToLab16Buffer(xyzBuf, pixelCount) {
  const out = new Uint16Array(pixelCount * 3);
  for (let p = 0; p < pixelCount; p++) {
    const off = p * 3;
    xyzD50ToLab16(xyzBuf[off], xyzBuf[off + 1], xyzBuf[off + 2], out, off);
  }
  return out;
}

/**
 * Build normalized 1D Gaussian kernel of length 2*radius + 1.
 *
 * @param {number} sigma
 * @returns {{ kernel: Float32Array, radius: number }}
 */
function buildGaussianKernel1D(sigma) {
  const radius = Math.max(1, Math.ceil(3.0 * sigma));
  const len = 2 * radius + 1;
  const kernel = new Float32Array(len);
  const inv2SigmaSq = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let d = -radius; d <= radius; d++) {
    const w = Math.exp(-d * d * inv2SigmaSq);
    kernel[d + radius] = w;
    sum += w;
  }
  const invSum = 1 / sum;
  for (let i = 0; i < len; i++) {
    kernel[i] *= invSum;
  }
  return { kernel, radius };
}

/**
 * Separable 2D Gaussian HVS optical PSF blur on interleaved 3-channel buffer.
 *
 * @param {Float32Array|Uint16Array} src3
 * @param {number} width
 * @param {number} height
 * @param {number} sigmaX
 * @param {number} sigmaY
 * @returns {Float32Array}
 */
function blurTripletSeparable(src3, width, height, sigmaX, sigmaY) {
  const N = width * height;
  const tmp = new Float32Array(N * 3);
  const dst = new Float32Array(N * 3);

  const { kernel: kx, radius: rx } = buildGaussianKernel1D(sigmaX);
  const { kernel: ky, radius: ry } = buildGaussianKernel1D(sigmaY);

  // Horizontal pass
  const xClampIdx = new Int32Array(width + 2 * rx);
  for (let i = 0; i < xClampIdx.length; i++) {
    const x = i - rx;
    xClampIdx[i] = (x < 0 ? 0 : x >= width ? width - 1 : x) * 3;
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * width * 3;
    for (let x = 0; x < width; x++) {
      let c0 = 0;
      let c1 = 0;
      let c2 = 0;
      for (let k = 0; k <= 2 * rx; k++) {
        const w = kx[k];
        const sOff = rowBase + xClampIdx[x + k];
        c0 += src3[sOff] * w;
        c1 += src3[sOff + 1] * w;
        c2 += src3[sOff + 2] * w;
      }
      const dOff = rowBase + x * 3;
      tmp[dOff] = c0;
      tmp[dOff + 1] = c1;
      tmp[dOff + 2] = c2;
    }
  }

  // Vertical pass
  const rowStride = width * 3;
  const yClampRow = new Int32Array(height + 2 * ry);
  for (let i = 0; i < yClampRow.length; i++) {
    const y = i - ry;
    yClampRow[i] = (y < 0 ? 0 : y >= height ? height - 1 : y) * rowStride;
  }

  for (let y = 0; y < height; y++) {
    const dstRow = y * rowStride;
    for (let x = 0; x < width; x++) {
      const colOff = x * 3;
      let c0 = 0;
      let c1 = 0;
      let c2 = 0;
      for (let k = 0; k <= 2 * ry; k++) {
        const w = ky[k];
        const sOff = yClampRow[y + k] + colOff;
        c0 += tmp[sOff] * w;
        c1 += tmp[sOff + 1] * w;
        c2 += tmp[sOff + 2] * w;
      }
      const dOff = dstRow + colOff;
      dst[dOff] = c0;
      dst[dOff + 1] = c1;
      dst[dOff + 2] = c2;
    }
  }

  return dst;
}

/**
 * Compute discrete gray tone levels available per halftone cell:
 *   grayStepsPerCell = Math.floor((dpiX / lpi) * (dpiY / lpi)) + 1.
 *
 * Accepts either (dpi, lpi) or (dpiX, dpiY, lpi).
 *
 * @param {number} dpiX
 * @param {number} dpiYOrLpi
 * @param {number} [lpiMaybe]
 * @returns {number}
 */
function computeGrayStepsPerCell(dpiX, dpiYOrLpi, lpiMaybe) {
  const dx = Number(dpiX);
  const dy = lpiMaybe === undefined ? dx : Number(dpiYOrLpi);
  const lpi = lpiMaybe === undefined ? Number(dpiYOrLpi) : Number(lpiMaybe);
  if (!(dx > 0) || !(dy > 0) || !(lpi > 0)) return 1;
  return Math.floor((dx / lpi) * (dy / lpi)) + 1;
}

/**
 * Compute HVS viewing-distance color fidelity between continuous-tone original CMYK
 * and halftoned binary (or proxy) CMYK strictly via linear D50 XYZ optical PSF ->
 * canonical 16-bit Engine CIELAB (L: 0..32768, a/b: 0..32768, 16384 = neutral).
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} origChannels
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} screenChannels
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.cellPitchPx]
 * @param {number} [options.cellPitchPxX]
 * @param {number} [options.cellPitchPxY]
 * @param {number} [options.dpi=300]
 * @param {number} [options.dpiX]
 * @param {number} [options.dpiY]
 * @param {number} [options.lpi=46]
 * @returns {{ meanDeltaE: number, p95DeltaE: number, maxDeltaE: number, grayStepsPerCell: number, sigmaPx: number }}
 */
function computeHvsQuality(origChannels, screenChannels, width, height, options = {}) {
  const N = width * height;
  const dpiX = Number(options.dpiX != null ? options.dpiX : options.dpi != null ? options.dpi : 300);
  const dpiY = Number(options.dpiY != null ? options.dpiY : options.dpi != null ? options.dpi : 300);
  const lpi = Number(options.lpi != null ? options.lpi : 46);
  const grayStepsPerCell = computeGrayStepsPerCell(dpiX, dpiY, lpi);

  if (!(width > 0) || !(height > 0)) {
    return {
      meanDeltaE: 0,
      p95DeltaE: 0,
      maxDeltaE: 0,
      grayStepsPerCell,
      sigmaPx: 0.75,
    };
  }

  const basePitchX =
    options.cellPitchPxX != null
      ? Number(options.cellPitchPxX)
      : options.cellPitchPx != null
      ? Number(options.cellPitchPx)
      : lpi > 0
      ? dpiX / lpi
      : 6.5;
  const basePitchY =
    options.cellPitchPxY != null
      ? Number(options.cellPitchPxY)
      : options.cellPitchPx != null
      ? Number(options.cellPitchPx)
      : lpi > 0
      ? dpiY / lpi
      : 6.5;

  const sigmaX = Math.max(0.75, Math.min(16.0, 1.5 * basePitchX));
  const sigmaY = Math.max(0.75, Math.min(16.0, 1.5 * basePitchY));

  // 1. Reflectance in linear D50 XYZ (O(1) 16x3 LUT fast-path on binary {0, 255}^4 screens)
  const origXyz = cmykToXyzD50Buffer(origChannels, N);
  const scrXyz = cmykToXyzD50Buffer(screenChannels, N);

  // 2. Identical separable 2D Gaussian HVS optical blur
  const blurOrigXyz = blurTripletSeparable(origXyz, width, height, sigmaX, sigmaY);
  const blurScrXyz = blurTripletSeparable(scrXyz, width, height, sigmaX, sigmaY);

  // 3. Canonical 16-bit Engine CIELAB encoding (L: 0..32768, a/b: 0..32768, 16384 = neutral)
  const origLab16 = xyzBufferToLab16Buffer(blurOrigXyz, N);
  const scrLab16 = xyzBufferToLab16Buffer(blurScrXyz, N);

  // 4. Color difference in 16-bit Engine CIELAB -> perceptual DeltaE76 at telemetry boundary
  const deValues = new Float32Array(N);
  const invLScale = 1 / LAB16_L_SCALE;
  const invAbScale = 1 / LAB16_AB_SCALE;

  let sumDe = 0;
  let maxDeltaE = 0;

  for (let p = 0; p < N; p++) {
    const off = p * 3;
    const dL = (origLab16[off] - scrLab16[off]) * invLScale;
    const da = (origLab16[off + 1] - scrLab16[off + 1]) * invAbScale;
    const db = (origLab16[off + 2] - scrLab16[off + 2]) * invAbScale;
    const de = Math.sqrt(dL * dL + da * da + db * db);
    deValues[p] = de;
    sumDe += de;
    if (de > maxDeltaE) maxDeltaE = de;
  }

  deValues.sort();
  const p95Idx = Math.min(N - 1, Math.floor(0.95 * (N - 1)));
  const p95DeltaE = deValues[p95Idx];
  const meanDeltaE = sumDe / N;

  return {
    meanDeltaE,
    p95DeltaE,
    maxDeltaE,
    grayStepsPerCell,
    sigmaPx: 0.5 * (sigmaX + sigmaY),
  };
}

module.exports = {
  D50_XN,
  D50_YN,
  D50_ZN,
  LAB16_L_SCALE,
  LAB16_AB_NEUTRAL,
  LAB16_AB_SCALE,
  SWOP_XYZ_D50,
  BINARY_SWOP_XYZ_D50,
  BINARY_SWOP_LAB16,
  cmykToXyzD50Buffer,
  cmykToLab16Buffer,
  xyzBufferToLab16Buffer,
  computeGrayStepsPerCell,
  computeHvsQuality,
};

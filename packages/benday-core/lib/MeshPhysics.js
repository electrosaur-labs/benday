'use strict';

const UM_PER_INCH = 25400;

/**
 * Standard monofilament plain-weave polyester roll catalog: meshTpi -> threadDiaUm
 */
const STANDARD_THREAD_UM = Object.freeze({
  110: 80,
  156: 64,
  196: 55,
  200: 55,
  230: 48,
  280: 40,
  305: 34,
  355: 34,
  380: 31,
  420: 27,
});

const STANDARD_MESH_TPI = Object.freeze(
  Object.keys(STANDARD_THREAD_UM)
    .map(Number)
    .sort((a, b) => a - b)
);

function createMeshPreset(meshTpi, threadDiaUm, hiR = false) {
  const pitchUm = UM_PER_INCH / meshTpi;
  const openPct = Math.round(Math.pow((pitchUm - threadDiaUm) / pitchUm, 2) * 100);
  const id = `${meshTpi}-${threadDiaUm}`;
  const tag = hiR ? `${openPct}% open · Hi-R` : `${openPct}% open`;
  return Object.freeze({
    id,
    meshTpi,
    threadDiaUm,
    openAreaPct: openPct,
    label: `${id} (${tag})`,
  });
}

/**
 * Official SAATI plain-weave polyester monofilament (TPI - µm) catalog pairs.
 * Default press-room baseline: 230-48 (32% open).
 */
const SAATI_MESH_PRESETS = Object.freeze([
  createMeshPreset(110, 80, false),
  createMeshPreset(110, 70, true),
  createMeshPreset(156, 64, false),
  createMeshPreset(156, 48, true),
  createMeshPreset(196, 55, false),
  createMeshPreset(196, 48, true),
  createMeshPreset(230, 48, false),
  createMeshPreset(230, 40, true),
  createMeshPreset(280, 40, false),
  createMeshPreset(280, 34, true),
  createMeshPreset(280, 31, true),
  createMeshPreset(305, 40, false),
  createMeshPreset(305, 34, false),
  createMeshPreset(305, 31, true),
  createMeshPreset(355, 34, false),
  createMeshPreset(355, 31, true),
  createMeshPreset(380, 34, false),
  createMeshPreset(380, 31, true),
  createMeshPreset(420, 31, false),
  createMeshPreset(420, 27, true),
]);

/**
 * Open-area reference baseline anchored to 230 TPI / 48 µm:
 *   pitch_230 = 25400 / 230 ≈ 110.4348 µm
 *   F_OPEN_REF = ((pitch_230 - 48) / pitch_230)^2 ≈ 0.319628
 */
const PITCH_230 = UM_PER_INCH / 230;
const F_OPEN_REF = Math.pow((PITCH_230 - 48) / PITCH_230, 2);

const RULE_OF_N_DEFAULT = 5.0;
const RULE_OF_N_MIN = 2.0;
const RULE_OF_N_MAX = 10.0;
const T_REF_DEFAULT = 0.12;
const MIN_DPI_FLOOR = 72;

const ERR_INVALID_MESH_GEOMETRY = 'ERR_INVALID_MESH_GEOMETRY';
const ERR_DPI_TOO_LOW = 'ERR_DPI_TOO_LOW';
const ERR_LPI_EXCEEDS_MESH_LIMIT = 'ERR_LPI_EXCEEDS_MESH_LIMIT';
const WARN_NARROW_AM_RANGE = 'WARN_NARROW_AM_RANGE';
const WARN_LOW_DPI = 'WARN_LOW_DPI';

class BendayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BendayError';
    this.code = code;
  }
}

/**
 * Look up standard thread diameter (µm) for a given mesh count (TPI).
 * Falls back to reference open-area scaling if a non-catalog TPI is supplied.
 *
 * @param {number} meshTpi
 * @returns {number}
 */
function getDefaultThreadDiaUm(meshTpi) {
  if (!Number.isFinite(meshTpi) || meshTpi <= 0) {
    throw new BendayError(ERR_INVALID_MESH_GEOMETRY, `Invalid meshTpi: ${meshTpi}`);
  }
  const rounded = Math.round(meshTpi);
  if (Object.prototype.hasOwnProperty.call(STANDARD_THREAD_UM, rounded) && Math.abs(meshTpi - rounded) < 1e-6) {
    return STANDARD_THREAD_UM[rounded];
  }
  const pitchUm = UM_PER_INCH / meshTpi;
  return Math.max(15, Math.round((1 - Math.sqrt(F_OPEN_REF)) * pitchUm));
}

// Cache canonical discrete disks by integer diameter D or anisotropic "DXxDY"
const _diskCache = new Map();

/**
 * Compute canonical discrete snapped disk (or physical-inch anisotropic ellipse) offsets B_D
 * for integer pixel diameters dMinPxX >= 1 and dMinPxY >= 1.
 *
 * When dMinPxX === dMinPxY === D:
 * - Odd D:  centered at pixel center (0.5, 0.5): dx^2 + dy^2 <= (D/2)^2
 * - Even D: centered at pixel corner (0, 0):     (dx + 0.5)^2 + (dy + 0.5)^2 <= (D/2)^2
 *
 * When dMinPxX !== dMinPxY (anisotropic DPI, e.g. 600x1200 DPI):
 * - Normalized physical disk: (ux / (DX/2))^2 + (uy / (DY/2))^2 <= 1, where ux = dx (odd DX) or dx + 0.5 (even DX),
 *   and uy = dy (odd DY) or dy + 0.5 (even DY), producing a physically circular dot in real inches.
 *
 * Yields exact symmetric pixel counts with zero 1px '+' spikes:
 *   D=1 -> 1 px, D=2 -> 4 px, D=3 -> 9 px, D=4 -> 12 px, D=5 -> 21 px.
 *
 * @param {number} dMinPxX
 * @param {number} [dMinPxY=dMinPxX]
 * @returns {ReadonlyArray<{dx: number, dy: number}>}
 */
function getCanonicalDiskOffsets(dMinPxX, dMinPxY = dMinPxX) {
  const DX = Math.max(1, Math.round(dMinPxX));
  const DY = Math.max(1, Math.round(dMinPxY == null ? DX : dMinPxY));
  const key = DX === DY ? DX : `${DX}x${DY}`;
  if (_diskCache.has(key)) {
    return _diskCache.get(key);
  }

  const offsets = [];
  if (DX === DY) {
    const D = DX;
    const rSq = (D * 0.5) * (D * 0.5);
    const limit = Math.ceil(D * 0.5) + 1;
    if (D % 2 === 1) {
      for (let dy = -limit; dy <= limit; dy++) {
        for (let dx = -limit; dx <= limit; dx++) {
          if (dx * dx + dy * dy <= rSq) {
            offsets.push(Object.freeze({ dx, dy }));
          }
        }
      }
    } else {
      for (let dy = -limit; dy <= limit; dy++) {
        for (let dx = -limit; dx <= limit; dx++) {
          const ux = dx + 0.5;
          const uy = dy + 0.5;
          if (ux * ux + uy * uy <= rSq) {
            offsets.push(Object.freeze({ dx, dy }));
          }
        }
      }
    }
  } else {
    const rx = DX * 0.5;
    const ry = DY * 0.5;
    const limitX = Math.ceil(rx) + 1;
    const limitY = Math.ceil(ry) + 1;
    const oddX = (DX & 1) === 1;
    const oddY = (DY & 1) === 1;
    for (let dy = -limitY; dy <= limitY; dy++) {
      const uy = oddY ? dy : dy + 0.5;
      const nySq = (uy / ry) * (uy / ry);
      for (let dx = -limitX; dx <= limitX; dx++) {
        const ux = oddX ? dx : dx + 0.5;
        const nxSq = (ux / rx) * (ux / rx);
        if (nxSq + nySq <= 1 + 1e-12) {
          offsets.push(Object.freeze({ dx, dy }));
        }
      }
    }
  }

  const frozen = Object.freeze(offsets);
  _diskCache.set(key, frozen);
  return frozen;
}

/**
 * Compute full physical mesh aperture, minimum printable dot/hole diameter,
 * discrete canonical disk B_{D_min}, natural LPI, and upper LPI safety bounds.
 *
 * @param {object} params
 * @param {number} params.meshTpi - Mesh threads per inch (e.g. 230, 305, 355)
 * @param {number} [params.threadDiaUm] - Thread diameter in µm (defaults to catalog)
 * @param {number} [params.ruleOfN=5.0] - Rule of N threads per halftone cell in [2.0, 10.0]
 * @param {number} [params.dpi=600] - Document resolution in pixels per inch
 * @param {number|null} [params.lpiOverride=null] - Optional manual LPI override
 * @param {number} [params.tRef=0.12] - Highlight reference area fraction for natural LPI
 * @returns {object}
 */
function computeMeshSpec(params = {}) {
  const {
    meshTpi,
    threadDiaUm: rawThreadUm,
    ruleOfN = RULE_OF_N_DEFAULT,
    dpi: rawDpi = 600,
    dpiX: rawDpiX = null,
    dpiY: rawDpiY = null,
    lpiOverride = null,
    tRef = T_REF_DEFAULT,
  } = params;

  const dpiX = rawDpiX == null ? rawDpi : rawDpiX;
  const dpiY = rawDpiY == null ? rawDpi : rawDpiY;
  const dpi = dpiX === dpiY ? dpiX : Math.min(dpiX, dpiY);

  if (!Number.isFinite(meshTpi) || meshTpi <= 0) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `meshTpi must be a positive number (got ${meshTpi})`
    );
  }

  const threadDiaUm = rawThreadUm == null ? getDefaultThreadDiaUm(meshTpi) : rawThreadUm;
  if (!Number.isFinite(threadDiaUm) || threadDiaUm <= 0) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `threadDiaUm must be a positive number (got ${threadDiaUm})`
    );
  }

  if (!Number.isFinite(ruleOfN) || ruleOfN < RULE_OF_N_MIN - 1e-9 || ruleOfN > RULE_OF_N_MAX + 1e-9) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `ruleOfN must be within [${RULE_OF_N_MIN}, ${RULE_OF_N_MAX}] (got ${ruleOfN})`
    );
  }

  if (!Number.isFinite(tRef) || tRef <= 0 || tRef >= 0.5) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `tRef must be in (0, 0.5) (got ${tRef})`
    );
  }

  const pitchIn = 1 / meshTpi;
  const pitchUm = UM_PER_INCH / meshTpi;
  const threadIn = threadDiaUm / UM_PER_INCH;
  const clearOpeningUm = pitchUm - threadDiaUm;
  const clearOpeningIn = pitchIn - threadIn;

  if (clearOpeningUm <= 0) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `Thread diameter (${threadDiaUm} µm) closes or exceeds mesh pitch (${pitchUm.toFixed(1)} µm at ${meshTpi} TPI)`
    );
  }

  const openArea = Math.pow(clearOpeningUm / pitchUm, 2);
  if (openArea < 0.02) {
    throw new BendayError(
      ERR_INVALID_MESH_GEOMETRY,
      `Mesh open area (${(openArea * 100).toFixed(1)}%) is physically choked below 2%`
    );
  }

  const openAreaScale = Math.sqrt(F_OPEN_REF / openArea);
  const cellPitchNatIn = (ruleOfN / meshTpi) * openAreaScale;
  const knuckleFloorIn = (pitchIn + threadIn) * openAreaScale;
  const highlightDotIn = Math.sqrt((4 * tRef) / Math.PI) * cellPitchNatIn;
  const dMinIn = Math.max(knuckleFloorIn, highlightDotIn);
  const dMinUm = dMinIn * UM_PER_INCH;
  const minValidDpi = Math.max(
    MIN_DPI_FLOOR,
    Math.ceil(0.75 / dMinIn - 1e-9),
    lpiOverride != null
      ? Math.ceil(4.0 * lpiOverride - 1e-9)
      : Math.ceil(4.0 / cellPitchNatIn - 1e-9)
  );

  if (
    !Number.isFinite(dpiX) ||
    !Number.isFinite(dpiY) ||
    dpiX < MIN_DPI_FLOOR ||
    dpiY < MIN_DPI_FLOOR
  ) {
    throw new BendayError(
      ERR_DPI_TOO_LOW,
      `Document is ${dpiX}x${dpiY} DPI — need >= ${minValidDpi} DPI for ${meshTpi} TPI at N=${ruleOfN}`
    );
  }

  // Sub-pixel check: document DPI along both axes must resolve dMin without massive quantization collapse
  if (dMinIn * Math.min(dpiX, dpiY) < 0.75) {
    throw new BendayError(
      ERR_DPI_TOO_LOW,
      `Document is ${Math.round(dpi)} DPI — need >= ${minValidDpi} DPI to resolve ${dMinUm.toFixed(0)} µm min dot (${meshTpi} TPI, N=${ruleOfN})`
    );
  }

  const minKnucklePxX = Math.max(1, Math.ceil(knuckleFloorIn * dpiX - 1e-9));
  const minKnucklePxY = Math.max(1, Math.ceil(knuckleFloorIn * dpiY - 1e-9));
  const dMinPxX = Math.max(minKnucklePxX, Math.round(dMinIn * dpiX));
  const dMinPxY = Math.max(minKnucklePxY, Math.round(dMinIn * dpiY));
  const dMinPx = Math.min(dMinPxX, dMinPxY);
  const diskOffsets = getCanonicalDiskOffsets(dMinPxX, dMinPxY);
  const aMinPx = diskOffsets.length;

  const lpiMaxContinuous = 1 / (Math.SQRT2 * dMinIn);
  const lpiMaxDiscrete = Math.min(
    dpiX / Math.max(4.0, Math.SQRT2 * dMinPxX),
    dpiY / Math.max(4.0, Math.SQRT2 * dMinPxY)
  );
  const lpiMax = Math.min(lpiMaxContinuous, lpiMaxDiscrete);
  const rawLpiNatural = 1 / cellPitchNatIn;
  const cellResolvableAtDpi = dpiX * cellPitchNatIn >= 4.0 - 1e-9 && dpiY * cellPitchNatIn >= 4.0 - 1e-9;
  const lpiNatural = cellResolvableAtDpi ? Math.min(rawLpiNatural, lpiMax) : rawLpiNatural;

  if (lpiOverride == null && lpiNatural > lpiMax + 1e-9) {
    throw new BendayError(
      ERR_DPI_TOO_LOW,
      `Document is ${Math.round(dpi)} DPI — need >= ${minValidDpi} DPI for ${lpiNatural.toFixed(1)} LPI (${meshTpi} TPI, N=${ruleOfN}), or set LPI <= ${lpiMax.toFixed(1)}`
    );
  }

  let lpiActive = lpiNatural;
  if (lpiOverride != null) {
    if (!Number.isFinite(lpiOverride) || lpiOverride <= 0) {
      throw new BendayError(
        ERR_LPI_EXCEEDS_MESH_LIMIT,
        `lpiOverride must be a positive number (got ${lpiOverride})`
      );
    }
    if (lpiOverride > lpiMax + 1e-9) {
      throw new BendayError(
        ERR_LPI_EXCEEDS_MESH_LIMIT,
        `Requested ${lpiOverride.toFixed(1)} LPI exceeds physical mesh/DPI limit (${lpiMax.toFixed(1)} LPI)`
      );
    }
    lpiActive = lpiOverride;
  }

  const cellPitchIn = 1 / lpiActive;
  const cellPitchPxX = dpiX / lpiActive;
  const cellPitchPxY = dpiY / lpiActive;
  const cellPitchPx = dpiX === dpiY ? cellPitchPxX : Math.min(cellPitchPxX, cellPitchPxY);
  const cellAreaPx = cellPitchPxX * cellPitchPxY;
  const tMin = Math.min(0.5, aMinPx / cellAreaPx);
  const tMax = Math.max(0.5, 1 - tMin);

  const warnings = [];
  if (dpi < 300 || cellPitchPx < 5.0) {
    warnings.push(WARN_LOW_DPI);
  }
  if (tMin > 0.25) {
    warnings.push(WARN_NARROW_AM_RANGE);
  }

  return {
    meshTpi,
    threadDiaUm,
    ruleOfN,
    dpi,
    dpiX,
    dpiY,
    tRef,
    pitchIn,
    pitchUm,
    threadIn,
    clearOpeningIn,
    clearOpeningUm,
    openArea,
    openAreaPct: openArea * 100,
    openAreaScale,
    cellPitchNatIn,
    knuckleFloorIn,
    highlightDotIn,
    dMinIn,
    dMinUm,
    dMinPx,
    dMinPxX,
    dMinPxY,
    diskOffsets,
    aMinPx,
    lpiNatural,
    lpiMax,
    lpiActive,
    lpiOverride: lpiOverride == null ? null : lpiOverride,
    cellPitchIn,
    cellPitchPx,
    cellPitchPxX,
    cellPitchPxY,
    cellAreaPx,
    tMin,
    tMax,
    warnings,
  };
}

module.exports = {
  UM_PER_INCH,
  STANDARD_THREAD_UM,
  STANDARD_MESH_TPI,
  SAATI_MESH_PRESETS,
  PITCH_230,
  F_OPEN_REF,
  RULE_OF_N_DEFAULT,
  RULE_OF_N_MIN,
  RULE_OF_N_MAX,
  T_REF_DEFAULT,
  MIN_DPI_FLOOR,
  ERR_INVALID_MESH_GEOMETRY,
  ERR_DPI_TOO_LOW,
  ERR_LPI_EXCEEDS_MESH_LIMIT,
  WARN_NARROW_AM_RANGE,
  WARN_LOW_DPI,
  BendayError,
  getDefaultThreadDiaUm,
  getCanonicalDiskOffsets,
  computeMeshSpec,
};

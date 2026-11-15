# `@electrosaur-labs/benday-core`

Zero-dependency mesh-aware CMYK halftone engine, rosette & 2D harmonic moiré analyzer, and physical screen invariant verifier for screen printing.

## Zero-Dependency Guarantee

`@electrosaur-labs/benday-core` has **zero external runtime dependencies** and imports **zero Node.js built-in modules** (`fs`, `path`, `Buffer`, `crypto`, etc.). It is pure ECMAScript (`CommonJS`, Node.js `>= 16.0.0`) using typed arrays (`Uint8Array`, `Int32Array`, `Float64Array`) and runs identically in Node.js, Adobe Photoshop UXP, Web Workers, and browsers.

## Polarity & Screen Terminology Convention

- **Input channel polarity (`srcUint8`):** `0` = `0%` paper (no ink), `255` = `100%` solid ink.
- **Output binary screen polarity:** Strictly `{0, 255}` where `0` = clear/open background (`0%` ink) and `255` = opaque screen dot or solid ink (`100%` ink).
- **Identifier note:** In screen printing, stencils are **screens** (never "plates"). Where code identifiers use `plates` (such as `result.plates` returned by `halftoneCmyk`) or `verifyPlateInvariants`, that property/function refers to the binary `{0, 255}` screen buffers (`{ C, M, Y, K }`) used to image film positives and burn screens.

## Quick Example

```js
const {
  computeMeshSpec,
  computeRosetteAngles,
  analyzeMoire,
  halftoneCmyk,
  verifyPlateInvariants,
} = require('@electrosaur-labs/benday-core');

const width = 600;
const height = 600;
const N = width * height;

const channels = {
  C: new Uint8Array(N).fill(64),
  M: new Uint8Array(N).fill(128),
  Y: new Uint8Array(N).fill(32),
  K: new Uint8Array(N).fill(0),
};

const result = halftoneCmyk(channels, width, height, {
  meshTpi: 230,
  ruleOfN: 5.0,
  dpi: 600,
  meshAngleDeg: 0,
  tailMode: 'hybrid',
});

// result.plates holds the 4 binary {0, 255} screen buffers: { C, M, Y, K }
const auditC = verifyPlateInvariants(result.plates.C, width, height, {
  dMinPx: result.meshSpec.dMinPx,
  aMinPx: result.meshSpec.aMinPx,
  cellPitchPx: result.meshSpec.cellPitchPx,
  srcUint8: channels.C,
});

console.log(result.meshSpec.lpiActive, result.moireReport.safe, auditC.ok);
```

---

## Core API Reference

### `computeMeshSpec(params)`

Computes physical plain-weave mesh aperture geometry, open-area-compensated minimum printable dot/hole diameter, canonical discrete disk/ellipse offsets $B_{D_{\min}}$, natural screen ruling (`lpiNatural`), and upper LPI safety limit (`lpiMax`). Supports both isotropic (`dpi`) and physical-inch anisotropic (`dpiX`, `dpiY`, e.g. `720 × 1440` or `1440 × 2880` DPI) output grids.

```js
const spec = computeMeshSpec({
  meshTpi: 230,          // Required: mesh threads per inch (> 0)
  threadDiaUm: 48,       // Optional: thread diameter in µm (defaults via getDefaultThreadDiaUm(meshTpi))
  ruleOfN: 5.0,          // Optional: Rule of N threads per halftone cell in [2.0, 10.0] (default: 5.0)
  dpi: 600,              // Optional: isotropic resolution in PPI/DPI >= 72 (default: 600)
  dpiX: undefined,       // Optional: horizontal DPI >= 72 (defaults to dpi)
  dpiY: undefined,       // Optional: vertical DPI >= 72 (defaults to dpi)
  lpiOverride: null,     // Optional: manual LPI (> 0 and <= lpiMax), or null for lpiNatural
  tRef: 0.12,            // Optional: highlight reference area fraction in (0, 0.5) (default: 0.12)
});
```

#### Physical Formulas

- **Pitch & Clear Opening:** $p_m = \frac{1}{\text{meshTpi}}$ in ($\frac{25400}{\text{meshTpi}}$ µm), $w_o = p_m - d_t$, open area $f_{\text{open}} = (w_o / p_m)^2$.
- **Open-Area Scaling Baseline:** Anchored to `230 TPI / 48 µm` ($f_{\text{ref}} = ((110.4348 - 48)/110.4348)^2 \approx 0.319628$), giving `openAreaScale` $= \sqrt{f_{\text{ref}} / f_{\text{open}}}$.
- **Natural Cell Pitch & Press-Room Rule of N (`threads per halftone cell`):**
  $$p_{\text{cell,nat}} = \frac{\text{ruleOfN}}{\text{meshTpi}} \cdot \sqrt{\frac{f_{\text{ref}}}{f_{\text{open}}}}, \qquad \text{lpiNatural} = \min\!\left(\frac{1}{p_{\text{cell,nat}}},\; \text{lpiMax}\right)$$
  (where `dpi * p_cell,nat >= 4.0`; e.g., `230 TPI / 48 µm` at `N = 5.0` yields **`46.0 LPI`**).
- **Minimum Printable Diameter:**
  $$\text{knuckleFloorIn} = (p_m + d_t)\sqrt{\frac{f_{\text{ref}}}{f_{\text{open}}}}, \qquad \text{highlightDotIn} = \sqrt{\frac{4\,t_{\text{ref}}}{\pi}}\,p_{\text{cell,nat}}, \qquad d_{\min} = \max(\text{knuckleFloorIn},\; \text{highlightDotIn})$$
- **Discrete Canonical Disk (Isotropic & Anisotropic):** `minKnucklePxX = Math.max(1, Math.ceil(knuckleFloorIn * dpiX - 1e-9))`, `dMinPxX = Math.max(minKnucklePxX, Math.round(dMinIn * dpiX))` (and analogously for `Y`), `dMinPx = Math.min(dMinPxX, dMinPxY)`; `diskOffsets = getCanonicalDiskOffsets(dMinPxX, dMinPxY)` (producing a physically circular dot in real inches); `aMinPx = diskOffsets.length`.
- **Max LPI:**
  $$\text{lpiMax} = \min\!\left(\frac{1}{\sqrt{2}\,d_{\min}},\; \frac{\text{dpiX}}{\max(4.0,\; \sqrt{2}\,\text{dMinPxX})},\; \frac{\text{dpiY}}{\max(4.0,\; \sqrt{2}\,\text{dMinPxY})}\right)$$

#### Return Object

| Field | Type | Description |
|---|---|---|
| `meshTpi`, `threadDiaUm`, `ruleOfN`, `dpi`, `dpiX`, `dpiY`, `tRef` | `number` | Validated input parameters (`dpi = Math.min(dpiX, dpiY)`) |
| `pitchIn`, `pitchUm` | `number` | Mesh repeat pitch in inches and µm |
| `threadIn` | `number` | Thread diameter in inches |
| `clearOpeningIn`, `clearOpeningUm` | `number` | Clear mesh aperture opening in inches and µm |
| `openArea`, `openAreaPct` | `number` | Fractional (`0..1`) and percentage (`0..100`) open area |
| `openAreaScale` | `number` | Compensation factor $\sqrt{f_{\text{ref}} / f_{\text{open}}}$ (`1.00` at `230/48`) |
| `knuckleFloorIn` | `number` | Open-area-scaled single-knuckle span $(p_m + d_t)\sqrt{f_{\text{ref}} / f_{\text{open}}}$ in inches |
| `dMinIn`, `dMinUm`, `dMinPx`, `dMinPxX`, `dMinPxY` | `number` | Minimum printable dot/hole diameter in inches, µm, and integer pixels (`X`/`Y`) |
| `diskOffsets` | `ReadonlyArray<{dx, dy}>` | Frozen canonical discrete disk/ellipse offsets $B_{D_{\min}}$ |
| `aMinPx` | `number` | Pixel count of $B_{D_{\min}}$ (`1`, `4`, `9`, `12`, `21`, ...) |
| `lpiNatural`, `lpiMax`, `lpiActive` | `number` | Auto LPI, maximum physically valid LPI, and active LPI |
| `lpiOverride` | `number \| null` | Manual LPI override if supplied, otherwise `null` |
| `cellPitchIn`, `cellPitchPx`, `cellPitchPxX`, `cellPitchPxY`, `cellAreaPx` | `number` | Halftone screen period in inches, pixels (`min`, `X`, `Y`), and square pixels (`cellPitchPxX * cellPitchPxY`) |
| `tMin`, `tMax` | `number` | Safe Euclidean AM area bounds (`tMin = min(0.5, aMinPx / cellAreaPx)`, `tMax = max(0.5, 1 - tMin)`) |
| `warnings` | `string[]` | Any active geometry warnings (`WARN_LOW_DPI`, `WARN_NARROW_AM_RANGE`) |

#### `BendayError` Codes Thrown

- `ERR_INVALID_MESH_GEOMETRY`: Non-positive `meshTpi`/`threadDiaUm`, `ruleOfN` outside `[2.0, 10.0]`, `tRef` outside `(0, 0.5)`, closed aperture (`clearOpeningUm <= 0`), or choked mesh (`openArea < 0.02`).
- `ERR_DPI_TOO_LOW`: `dpi < 72`, `dMinIn * dpi < 0.75`, or `lpiNatural > lpiMax` when no `lpiOverride` is supplied.
- `ERR_LPI_EXCEEDS_MESH_LIMIT`: Non-positive `lpiOverride` or `lpiOverride > lpiMax`.

---

### `computeRosetteAngles(meshAngleDeg = 0)`

Centers a bias-stretched plain-weave mesh angle `θ` (`meshAngleDeg`, modulo `90°`) inside the empty `30°` gap of the CMYK rosette:

```js
const angles = computeRosetteAngles(0);
// => { C: 15, M: 75, Y: 60, K: 45 }
```

- `C = norm90(θ + 15)`
- `K = norm90(θ + 45)`
- `Y = norm90(θ + 60)`
- `M = norm90(θ + 75)`

Guarantees exact `30.0°` spacing among strong inks (`C`, `K`, `M`), `15.0°` Yellow bisection between `K` and `M`, `15.0°` nominal mesh-thread clearance on all 4 screens, and `>= 13.0°` clearance across `±2.0°` of stretcher slop.

---

### `analyzeMoire(params)`

2D reciprocal-lattice harmonic beat and angular clearance analyzer. Evaluates screen harmonics $|j|, |k| \le \text{maxScreenHarmonic}$ against plain-weave mesh harmonics $|m_1|, |m_2| \le \text{maxMeshHarmonic}$ across `[meshAngleDeg - slopDeg, meshAngleDeg + slopDeg]` in `0.5°` steps, weighted by square-mesh `sinc(m1 * η) * sinc(m2 * η)` and circular-dot Airy modulation `2 * t * |2 * J1(x) / x|` across representative tones `[0.15, 0.25, 0.35, 0.45]`.

```js
const report = analyzeMoire({
  meshTpi: 230,            // Required
  threadDiaUm: 48,         // Optional (defaults to catalog thread for meshTpi)
  lpi: 46.0,               // Required: active halftone screen ruling
  angles: { C: 15, M: 75, Y: 60, K: 45 }, // Optional (defaults to computeRosetteAngles(meshAngleDeg))
  meshAngleDeg: 0,         // Optional (default: 0)
  slopDeg: 2.0,            // Optional: stretcher slop window ± degrees (default: 2.0)
  maxScreenHarmonic: 8,    // Optional (default: 8)
  maxMeshHarmonic: 4,      // Optional (default: 4)
});
```

#### Return Object

- `safe` (`boolean`): `true` when `warnings.length === 0`.
- `warnings` (`string[]`): Contains `'WARN_HARMONIC_MOIRE'` (beat contrast `>= 0.015` and period `>= 0.20 in` / `5.08 mm`) and/or `'WARN_SEVERE_MOIRE'` (thread clearance `< 7.5°`, strong-ink inter-screen clearance `< 7.5°`, or beat contrast `>= 0.030` with period `>= 0.25 in` / `6.35 mm`).
- `minClearanceDeg` (`number`): Worst-case thread clearance across all channels and `±slopDeg` samples.
- `interChannelClearanceDeg` (`number`): Minimum angular separation among strong inks (`C`, `M`, `K`).
- `maxContrast` (`number`): Highest detected harmonic beat contrast across all channels.
- `worstBeat` (`object | null`): `{ channel, contrast, wavelengthIn, wavelengthMm, j, k, m1, m2, meshAngleTested }`.
- `channels` (`object`): Per-channel `{ angleDeg, nominalClearanceDeg, minClearanceDeg, maxContrast, worstBeat, warnings }`.

---

### `halftoneChannel(srcUint8, width, height, options)`

Halftones a single continuous-tone ink channel (`0` = `0%` paper, `255` = `100%` solid ink) into a discrete `{0, 255}` `Uint8Array` screen buffer of length `width * height`.

```js
const screenBuf = halftoneChannel(srcUint8, width, height, {
  meshSpec,                // Optional precomputed computeMeshSpec() object; otherwise pass:
  meshTpi: 230,            // Default: 230
  threadDiaUm: undefined,  // Default: catalog auto
  ruleOfN: 5.0,            // Default: 5.0
  dpi: 600,                // Default: 600
  dpiX: undefined,         // Optional anisotropic horizontal DPI (defaults to dpi)
  dpiY: undefined,         // Optional anisotropic vertical DPI (defaults to dpi)
  lpiOverride: null,       // Default: null
  angleDeg: 45,            // Default: 45 (normalized mod 90°)
  tailMode: 'hybrid',      // 'hybrid' (default) | 'cutoff' | 'clamp'
  channelKey: 'K',         // Deterministic FM tail jitter seed ('C', 'M', 'Y', 'K', or custom string)
  originX: width * 0.5,    // Optional screen lattice X origin in buffer coordinates (locks cropped viewports to global document phase)
  originY: height * 0.5,   // Optional screen lattice Y origin in buffer coordinates
});
```

---

### `halftoneCmyk(channels, width, height, config)`

Halftones all 4 CMYK continuous-tone channels (`{ C, M, Y, K }`) into binary `{0, 255}` screen buffers using shared mesh physics and bias-centered (or custom) rosette angles.

```js
const { plates, meshSpec, moireReport, angles } = halftoneCmyk(
  { C, M, Y, K },
  width,
  height,
  {
    meshTpi: 230,           // Default: 230
    threadDiaUm: undefined, // Default: catalog auto
    ruleOfN: 5.0,           // Default: 5.0
    dpi: 600,               // Default: 600
    dpiX: undefined,        // Optional anisotropic horizontal DPI (defaults to dpi)
    dpiY: undefined,        // Optional anisotropic vertical DPI (defaults to dpi)
    lpiOverride: null,      // Default: null
    meshAngleDeg: 0,        // Default: 0
    anglesOverride: null,   // Optional { C, M, Y, K } override in degrees
    tailMode: 'hybrid',     // 'hybrid' (default) | 'cutoff' | 'clamp'
    slopDeg: 2.0,           // Default: 2.0
    originX: width * 0.5,   // Optional screen lattice X origin in buffer coordinates
    originY: height * 0.5,  // Optional screen lattice Y origin in buffer coordinates
  }
);
```

- `plates` (`{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }`): The 4 binary `{0, 255}` screen buffers.
- `meshSpec`: Full `computeMeshSpec` output.
- `moireReport`: Full `analyzeMoire` output.
- `angles`: Normalized `{ C, M, Y, K }` screen angles in `[0, 90)`.

---

### `verifyPlateInvariants(plateUint8, width, height, spec)`

Independent mathematical and morphological auditor verifying that a binary screen buffer satisfies all physical press invariants (using an independent `openByCanonicalDisk` oracle sharing zero morphological code with `HalftoneEngine`).

```js
const audit = verifyPlateInvariants(screenUint8, width, height, {
  dMinPx: meshSpec.dMinPx,             // Required (defaults to 1 if omitted)
  dMinPxX: meshSpec.dMinPxX,           // Optional anisotropic X min dot diameter in px
  dMinPxY: meshSpec.dMinPxY,           // Optional anisotropic Y min dot diameter in px
  aMinPx: meshSpec.aMinPx,             // Optional
  cellPitchPx: meshSpec.cellPitchPx,   // Optional
  cellPitchPxX: meshSpec.cellPitchPxX, // Optional anisotropic X cell pitch in px
  cellPitchPxY: meshSpec.cellPitchPxY, // Optional anisotropic Y cell pitch in px
  srcUint8: originalChannelUint8,      // Optional: enables solid preservation & paper bleed checks
});
```

#### Audited Invariants & Return Fields

| Field | Type | Invariant Checked |
|---|---|---|
| `ok` | `boolean` | `true` iff `binaryPure` and all four violation counts below equal `0` |
| `binaryPure` | `boolean` | Every byte in `plateUint8` is strictly `0` or `255` (`nonBinaryCount === 0`) |
| `minDotViolations` | `number` | Count of foreground (`255`) pixels not 8-connected to `src === 255` solids that are not covered by at least one full canonical disk $B_{D_{\min}}$ |
| `minHoleViolations` | `number` | Count of enclosed interior `0`-pixels (excluding exterior paper and pure `{0, 255}` graphic counters bounded strictly by `src === 255` solids) not covered by at least one full canonical disk $B_{D_{\min}}$ |
| `solidPreservationViolations` | `number` | Count of pixels where `srcUint8[p] === 255` and `plateUint8[p] !== 255` |
| `paperBleedViolations` | `number` | On pure `{0, 255}` inputs: pixels where `src === 0 && plate !== 0`. On continuous-tone inputs: foreground pixels straying outside the `(max(2*dMinPxX, ceil(cellPitchPxX)), max(2*dMinPxY, ceil(cellPitchPxY)))` Chebyshev neighborhood of `src > 0`, or foreground 8-connected components with zero overlap against `src > 0` |
| `dMinPx`, `dMinPxX`, `dMinPxY` | `number` | Audited minimum dot diameters in pixels |
| `cellPitchPx`, `cellPitchPxX`, `cellPitchPxY` | `number` | Audited halftone cell pitches in pixels |
| `inkPixels`, `inkCoverage` | `number` | Total `255` pixel count and fractional coverage in `[0, 1]` |
| `enclosedHoleComponents` | `number` | Count of audited interior halftone hole components |

---

## Additional Exported Utilities & Constants

- `SAATI_MESH_PRESETS`: Frozen 20-entry catalog of official SAATI screen-printing `(TPI, µm)` rolls (`110-80` through `420-27`, including standard and `Hi-R` high-open-area thin-thread pairs with `{ id, tpi, threadUm, hiR, openAreaPct, label }`).
- `STANDARD_THREAD_UM`: Frozen lookup `{ 110: 80, 156: 64, 196: 55, 200: 55, 230: 48, 280: 40, 305: 34, 355: 34, 380: 31, 420: 27 }`.
- `STANDARD_MESH_TPI`: Frozen sorted array `[110, 156, 196, 200, 230, 280, 305, 355, 380, 420]`.
- `F_OPEN_REF`: Reference open area (`~0.319628`) at `230 TPI / 48 µm`.
- `getDefaultThreadDiaUm(meshTpi)` / `getCanonicalDiskOffsets(dMinPxX, dMinPxY = dMinPxX)`.
- `norm90(deg)` / `clearance90(aDeg, bDeg)` / `besselJ1(x)`.
- `EUCLIDEAN_LUT` / `clippedDiamondArea(r)` / `radiusForDiamondTone(t)`.
- `getChannelCalibrationLut(meshSpec, angleDeg)` (via `HalftoneEngine`): Cached 256-entry 1D empirical discrete tone calibration LUT ensuring angle-neutral dot coverage and smooth midtone bridging.
- Submodule namespaces: `MeshPhysics`, `RosetteAngles`, `EuclideanLut`, `HalftoneEngine`, `PlateVerifier` (also exported as `HalftoneVerifier`).

## License

Apache-2.0 — see root [LICENSE](../../LICENSE).

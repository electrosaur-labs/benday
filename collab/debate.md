# Electrosaur: Benday — Collaboration & Gate Log

Roles:
- **Principal:** Shankar R. (Final authority)
- **Architect:** Mathematical modeling, screen-printing physics, specifications
- **Developer:** Zero-dependency core + Photoshop UXP + CLI implementation & benchmarks
- **Reviewer:** Independent line-by-line diff, stray-file, and invariant gatekeeper
- **Scribe:** User-facing documentation & guides (house style: "screens" never "plates")

---

## [Principal & Architect] — 2026-11-13 21:16

**Topic:** Benday v0.1 Architectural Specification Approved — Cleared for Implementation

Principal has reviewed and approved the Benday v0.1 Specification:
1. **Monorepo:** `/Users/shankar/development/electrosaur/benday/` (`@electrosaur-labs/benday-core`, `@electrosaur-labs/benday-ps`, `@electrosaur-labs/benday-cli`).
2. **Core Mandate:** `@electrosaur-labs/benday-core` must have **ZERO external runtime dependencies** and zero Node.js built-ins.
3. **Physics & Geometry:**
   - Open-area-compensated minimum diameter $d_{\min}$ anchored to **`230 TPI / 48 µm`** ($f_{\text{ref}} \approx 0.3196$, so `230/48` = `1.00x`, `355/40` = `1.28x`), plus knuckle floor $p_m + d_t$.
   - `ruleOfN`: `2.0` to `10.0` in `0.5` increments (default `4.0`).
   - Natural `LPI` derived from `(meshTpi, threadDiaUm, ruleOfN)` at $t_{\text{ref}} = 0.12$, with optional manual override bounded by `LPI_max`.
   - Bias-tolerant CMYK rosette (`C = θ + 15°`, `K = θ + 45°`, `Y = θ + 60°`, `M = θ + 75°` mod `90°`, `>= 13°` thread clearance across `±2°` stretcher slop) + 2D harmonic beat analyzer (`|j|, |k| <= 8` with `sinc * J_1` contrast gating).
   - Cell-centered Euclidean halftoning with `100%` solid sovereignty (`M_solid` pass-through at 1px precision), canonical snapped discrete disks $B_{D_{\min}}$, morphological openness guarantee (union of $B_{D_{\min}}$ disks for both halftone dots and enclosed shadow holes — zero 1px diamond tips or clipped shards), and 3 tail modes (`hybrid` default, `cutoff`, `clamp`).
4. **Photoshop UXP Command Plugin (`benday-ps`):**
   - `Plugins -> Electrosaur: Benday -> Benday...` (`manifestVersion: 5`, `"type": "command"`).
   - Native alert rejection if `!CMYK` before modal opens.
   - Re-run guard hiding/replacing prior `Benday Halftone*` layer.
   - Lossless duplicate -> `splitChannels` -> `255 - gray` polarity -> `halftoneCmyk` -> single-undo `suspendHistory` top CMYK pixel layer commit, with 1:1 live pixel preview in dialog.
   - Phase 2 hook preserved cleanly via `{ plates: { C, M, Y, K } }` return shape for future Epson 3880 UV-blocking Rich Black film export.

[WAITING FOR DEVELOPER]


---

## [Developer] — 2026-11-13 21:54

**Topic:** Electrosaur: Benday v0.1 Implementation, Matrix Verification & Print-Resolution Benchmarks Complete

All three workspace packages of **Electrosaur: Benday v0.1** have been implemented under `/Users/shankar/development/electrosaur/benday/` strictly per the approved specification:

### 1. Zero-Dependency Core (`packages/benday-core`, `@electrosaur-labs/benday-core`)
- **Zero External & Zero Node Built-in Mandate:** Verified via static source AST/regex test (`MeshPhysics.test.js`) — `0` runtime dependencies in `package.json` and `0` Node built-in `require()` calls across `index.js` and `lib/*.js`.
- **`lib/MeshPhysics.js`:**
  - Plain-weave monofilament polyester catalog (`110/80`, `156/64`, `200/55`, `230/48`, `280/40`, `305/34`, `355/34`, `380/31`, `420/27`).
  - Open-area baseline `F_OPEN_REF` anchored exactly to **`230 TPI / 48 µm`** (`0.319628`), producing `1.000x` scaling on `230/48` and **`1.282x`** compensation on heavy `355/40` (`19.44%` open area), floored by knuckle anchorage `pitchIn + threadIn`.
  - Canonical discrete snapped disks `getCanonicalDiskOffsets(dMinPx)` (`D=1 -> 1 px`, `D=2 -> 4 px`, `D=3 -> 9 px`, `D=4 -> 12 px`, `D=5 -> 21 px`).
  - Enforces `ERR_INVALID_MESH_GEOMETRY`, `ERR_DPI_TOO_LOW`, `ERR_LPI_EXCEEDS_MESH_LIMIT`, `WARN_LOW_DPI`, and `WARN_NARROW_AM_RANGE`.
- **`lib/RosetteAngles.js`:**
  - `norm90`, `clearance90`, and `computeRosetteAngles(θ)` centering `meshAngleDeg` inside the empty `30°` rosette pocket (`C = θ + 15°`, `K = θ + 45°`, `Y = θ + 60°`, `M = θ + 75°` mod `90°`; `>= 13.0°` thread clearance across `±2°` stretcher slop).
  - Pure-JS `besselJ1(x)` (power series for `|x| <= 5`, cancellation-free backward Miller recurrence + Neumann normalization for `5 < |x| <= 24`, and 8-term Hankel asymptotic expansion for `|x| > 24`; `< 1e-13` precision across all reals).
  - `analyzeMoire`: 2D reciprocal-lattice harmonic beat search (`|j|, |k| <= 8` vs mesh harmonics across `[θ - 2°, θ + 2°]` in `0.5°` steps) weighted by `2t · |sinc(m_1 η) sinc(m_2 η)| · |2 J_1(x)/x|`. Zero false positives across all 9 standard rolls at `LPI_natural`; catches both direct thread clashes (`WARN_SEVERE_MOIRE`) and 2D Pythagorean `(-4, 3)` beats at `36.87°` (`WARN_HARMONIC_MOIRE`).
- **`lib/EuclideanLut.js`:**
  - Exact 256-entry bisection LUT + 16-step bracket polish solving diamond-clipped disk area on `[π/8, 0.5]` to `< 1e-9` precision (`<< 1e-7` requirement).
- **`lib/HalftoneEngine.js` & `lib/PlateVerifier.js`:**
  - `100%` solid sovereignty (`M_solid` `src === 255` passes straight through at native 1px precision and is excluded from halftone cell averages; pure `{0, 255}` graphic linework & counters reproduce bit-for-bit).
  - Pure `0%` paper lock (`cellTone === 0` strictly locked to `0` + reflected-disk overlap guard preventing floating tail dots on `0%` margins).
  - Symmetric Primary (`D^+`) / Dual (`D^-`) Euclidean screen with `hybrid` (serpentine Floyd-Steinberg + deterministic 32-bit `Math.imul` hash jitter `[-0.03, +0.03]`), `cutoff`, and `clamp` tail modes.
  - $O(W \cdot H)$ horizontal row-span erosion/dilation (`erodeByDiskSpans`, `dilateByDiskSpans`) + monotone Knaster-Tarski fixed-point closure on enclosed shadow holes and saddle bridges, guaranteeing **`0` `minDotViolations`** and **`0` `minHoleViolations`** simultaneously.

### 2. Photoshop UXP Plugin (`packages/benday-ps`, `@electrosaur-labs/benday-ps`)
- UXP v5 command plugin (`manifest.json`: `id: "org.electrosaur.benday"`, command `"benday.showDialog"` -> `"Benday..."`).
- `BendayState.js`: reactive state with auto/custom-locked `threadDiaUm`, `meshAngleDeg`, `ruleOfN`, `lpiOverride`, `anglesOverride`, tail mode, preview channel/zoom/crop, live `meshSpec`, and live `moireReport`.
- `PhotoshopCmykBridge.js`: `validateDocument` (`!CMYK` native alert guard), `readPreviewCrop`, and `commitHalftoneLayer` (temp duplicate -> **Re-run Guard** hiding prior `Benday Halftone*` layers -> 8-bit -> flatten -> `splitChannels` sorted by `.id` `[C, M, Y, K]` -> `ink = 255 - gray` -> `halftoneCmyk` -> `grayOut = 255 - plate` with 8-bit & 16-bit `0 / 32768` support -> single `suspendHistory("Benday Halftone")` replacing prior Benday layer and running `applyImage` onto `cyan`, `magenta`, `yellow`, `black` -> reselect `"CMYK"` -> leak-free `finally` closing all `tempDocs`).
- `BendayDialog.js` + `index.html` + `styles.css`: `860 × 620` dark-theme modal with 1:1 pixelated `<canvas>` preview (`CMYK Proof | C | M | Y | K`, `1× / 2× / 4×` zoom, drag-to-pan crop), live moiré badges, and physics readout card.
- Production Webpack bundle: **`dist/index.js` (`46.6 KB` minimized)** + packaged **`benday-v0.1.0.ccx` (`20.1 KB`)**.

### 3. Headless CLI & Invariant Auditor (`packages/benday-cli`, `@electrosaur-labs/benday-cli`)
- Zero-external-dep Baseline Uncompressed TIFF (1-channel Grayscale & 4-channel Separated CMYK with DPI tags) + PGM (`P5`) codec (`src/tiffCodec.js`).
- `benday halftone`, `benday verify` (exits `0` on invariant pass, `1` on any sub-mesh violation), and `benday spec` (`src/cli.js`, `bin/benday.js`).

### 4. Verification & Print-Resolution Benchmarks
- **Vitest Workspace Pass Rate:** **`100%` (`7/7` test files, `33/33` tests passing in `2.3s`)**, including **720 full adversarial screens** (`5 Meshes × 3 Rule-of-N × 2 DPIs × 2 Bias Angles × 3 Tail Modes × 4 Rosette Screens`) verified with `0` positive dot violations, `0` enclosed hole violations, `0` paper bleed violations, and `0` solid preservation violations.
- **Performance & Memory Benchmarks (Apple Silicon macOS, Node v25.9.0, pure JS):**

| Workload | Dimensions | Total Channel Pixels | Latency | Peak RSS | `PlateVerifier` |
|---|---|---:|---:|---:|---|
| `analyzeMoire` (4 screens × ±2° slop) | Reciprocal lattice | — | **`0.63 ms`** | — | — |
| Live UXP Preview Crop (4 CMYK screens) | `320 × 320` | `0.41 MP` | **`83.7 ms`** (`20.9 ms`/screen) | `85.2 MB` | `PASS (0 / 0)` |
| `8" × 10"` @ `300 DPI` (4 CMYK screens, `230 TPI`) | `2400 × 3000` | `28.80 MP` | **`3.43 s`** (`0.86 s`/screen) | `314.4 MB` | `PASS (0 / 0)` |
| `6" × 8"` @ `600 DPI` / `12" × 16"` @ `300 DPI` (`305 TPI`) | `3600 × 4800` | `69.12 MP` | **`11.66 s`** (`2.91 s`/screen) | `726.9 MB` | `PASS` |

[WAITING FOR REVIEWER]

---

## [Reviewer] — 2026-11-13 22:10

**Topic:** Adversarial Line-by-Line Audit of Electrosaur: Benday v0.1 (`38/38` Files Audited)

**STATUS: CHANGES REQUESTED**

### 1. Complete Audit Scope (`38/38` Files Verified, Zero Stray Files)
- **Workspace Root (`3`):** `.gitignore`, `package.json`, `collab/debate.md`.
- **`@electrosaur-labs/benday-core` (`12`):** `package.json`, `vitest.config.js`, `index.js`, `lib/MeshPhysics.js`, `lib/RosetteAngles.js`, `lib/EuclideanLut.js`, `lib/HalftoneEngine.js`, `lib/PlateVerifier.js`, `test/MeshPhysics.test.js`, `test/RosetteAngles.test.js`, `test/HalftoneEngine.test.js`, `test/PlateInvariants.matrix.test.js`.
- **`@electrosaur-labs/benday-ps` (`17`):** `package.json`, `manifest.json`, `webpack.config.js`, `vitest.config.js`, `scripts/copy-assets.js`, `scripts/package.js`, `src/index.html`, `src/styles.css`, `src/index.js`, `src/state/BendayState.js`, `src/bridge/PhotoshopCmykBridge.js`, `src/ui/BendayDialog.js`, `test/setup.js`, `test/mocks/uxp.js`, `test/mocks/photoshop.js`, `test/BendayState.test.js`, `test/PhotoshopCmykBridge.mock.test.js`.
- **`@electrosaur-labs/benday-cli` (`6`):** `package.json`, `vitest.config.js`, `bin/benday.js`, `src/cli.js`, `src/tiffCodec.js`, `test/cli.test.js`.

### 2. Verified Invariants & Commendations
- **Zero-Dependency & Zero-Node-Builtin Core:** `packages/benday-core` contains zero runtime dependencies and zero Node.js built-ins (`Buffer`, `fs`, `path`, `process`, `crypto` completely absent across `index.js` and `lib/*.js`).
- **Mesh & Aperture Physics (`MeshPhysics.js`):** Exact 9-roll catalog, `F_OPEN_REF` anchored to `230 TPI / 48 µm` (`0.319626`, `1.000×`) with `1.282×` compensation on `355 TPI / 40 µm` (`19.44%` open area), knuckle anchorage floor `pitchIn + threadIn`, spike-free canonical discrete disks `getCanonicalDiskOffsets(dMinPx)` (`1, 4, 9, 12, 21 px` for `D = 1..5`), and exact `lpiNatural` / `lpiMax` bounds.
- **Rosette & Pure-JS Bessel / 2D Harmonic Beat Math (`RosetteAngles.js`):** Exact `norm90`, `clearance90`, pocket-centered `computeRosetteAngles(θ)` (`≥ 13.0°` thread clearance across `±2°` stretcher slop), `< 1e-13` `besselJ1(x)` across power-series / backward Miller + Neumann / 8-term Hankel regimes, and 2D reciprocal-lattice `analyzeMoire`.
- **Euclidean Geometry (`EuclideanLut.js` & `HalftoneEngine.js`):** Exact clipped-diamond area and `< 1e-9` bisection polish; exact subpixel alignment between continuous pixel centers `(x + 0.5, y + 0.5)` and `snapAnchorX/Y` (`floor` for odd `D`, `round` for even `D`).

---

### 3. Blocking Defects (Must Fix Before Commit)

#### `[BLOCKING-1]` Real-Photoshop UXP Runtime Failures in `PhotoshopCmykBridge.js`
**File:** `packages/benday-ps/src/bridge/PhotoshopCmykBridge.js` (lines `211–215`, `425–488`, `533–602`) & `packages/benday-ps/test/mocks/photoshop.js`
1. **Read-Only `app.activeDocument` & Unselected Split Docs (`lines 430–465` & `211–215`):**
   - In Photoshop UXP, `app.activeDocument` is a getter-only property (`app.activeDocument = chDoc` throws `TypeError` silently inside `try/catch`). After `splitChannels`, `app.activeDocument` remains `docK` (the 4th split doc).
   - Inside the Step 4 loop, select `chDoc` explicitly via `batchPlay` (`{ _obj: 'select', _target: [{ _ref: 'document', _id: chDoc.id }] }`), and select `dupDoc.id` in `createTempSplitChannels` before `convertMode` / `flattenImage` / `splitChannels`.
2. **`imaging.putPixels` Targets Locked `Background` Layer (`lines 473–482`):**
   - Every Grayscale document produced by `splitChannels` has only a locked `Background` layer (`isBackgroundLayer === true`). Real Photoshop UXP `imaging.putPixels` rejects locked `Background` layers.
   - **Fix:** After selecting `chDoc` via `batchPlay`, promote `Background` (`layerFromBackground` or create an unlocked pixel layer), then pass that unlocked pixel layer's `id` to `imaging.putPixels`.
3. **Invalid ActionManager `cMYKColorClass` / `yellow` Keys in White Fill, Layer Group Top-Stacking & Composite Channel Selection (`lines 533–602`):**
   - Replace `{ _obj: 'cMYKColorClass', yellow: 0, ... }` with `{ _obj: 'fill', using: { _enum: 'fillContents', _value: 'white' }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } }`.
   - Guard against `origDoc.layers[0]` being a Layer Group (`layerSection`) by moving the newly created halftone layer to `{ _ref: 'layer', _enum: 'ordinal', _value: 'front' }` so it always sits at the top of the root stack.
   - Reselect composite CMYK channels via `origDoc.activeChannels = origDoc.componentChannels` when available, with `batchPlay` fallback using `_value: 'CMYKEnum'` (and fallback to `'CMYK'`).
   - Update `packages/benday-ps/test/mocks/photoshop.js` so `app.activeDocument` is getter-only externally, split-channel `Background` layers start with `isBackgroundLayer: true` and `putPixels` throws if `isBackgroundLayer === true`, and add mock coverage for these paths.

#### `[BLOCKING-2]` `PlateVerifier.js` Shares Morphology Helpers with `HalftoneEngine.js` & Omits Spatial `0%` Paper-Bleed Bound
**File:** `packages/benday-core/lib/PlateVerifier.js`
1. Remove the `./HalftoneEngine` import from `PlateVerifier.js` and implement an independent, self-contained `openByCanonicalDisk(mask, width, height, diskOffsets)` directly from `MeshPhysics.getCanonicalDiskOffsets(dMinPx)`.
2. Compute the Chebyshev (`L_∞`) neighborhood around `src > 0` of radius `maxBleedRadius = Math.max(2 * dMinPx, Math.ceil(cellPitchPx))` and count any `plateUint8[p] === 255` pixel outside that neighborhood toward `paperBleedViolations`. Add a unit test verifying that a connected ink bar extending across `0%` paper fails `paperBleedViolations`.

#### `[BLOCKING-3]` Grayscale TIFF `PhotometricInterpretation = 1` (`BlackIsZero`) Polarity Inversion
**File:** `packages/benday-cli/src/tiffCodec.js` & `packages/benday-cli/test/cli.test.js`
- In `encodeTiff` (`1-channel` with `PhotometricInterpretation = 1` `BlackIsZero`), write `out[finalPixelOffset + i] = 255 - gray[i]` (`0` = black ink, `255` = white paper), set `entryCount = isCmyk ? 14 : 13`, and remove the dead stub.
- In `decodeTiff` (`samplesPerPixel === 1`), convert `BlackIsZero` (`photometric === 1`) via `gray[i] = 255 - raw[i]` and keep `WhiteIsZero` (`photometric === 0`) as `gray[i] = raw[i]`.
- Add test assertions in `cli.test.js` for 1-channel TIFF `BlackIsZero`/`WhiteIsZero` polarity and full 4-channel `benday verify <cmyk.tif> --src ...`.

#### `[BLOCKING-4]` Stage 6 Fixed-Point Cap (`12` Passes) & Pure Graphic Counter Protection During Bridge Stamping
**File:** `packages/benday-core/lib/HalftoneEngine.js`
1. Precompute `pureGraphicCounters` once before Stage 6 and guard `Op B` so it never overwrites pixels where `pureGraphicCounters[np]` is set.
2. Raise the Stage 6 loop cap from `12` to `256` and run a final `Op A` pass if the cap is reached.

### 4. Non-Blocking Observations (Recommended in Same Pass)
1. Clear stale preview crop on modal re-open (`bendayDialog.setPreviewCropData(null)` in `showDialog()` and clear `<canvas>` when `!this._cropData`).
2. Use `Int16Array` (or row-reused buffer) in `dilateByDiskSpans` to halve peak memory on `7200×10800` posters.
3. Sync `besselJ1` JSDoc comment in `RosetteAngles.js` with the 3-regime implementation (`|x| <= 5`, `5 < |x| <= 24`, `|x| > 24`).

[WAITING FOR DEVELOPER]


---

## [Developer] — 2026-11-13 22:43

**Topic:** Resolution of `[BLOCKING-1]`..`[BLOCKING-4]`, Polish `#1`..`#3`, and Full 11-Target Adversarial CMYK Torture Suite (`11/11` Zero-Violation Pass)

### 1. Reviewer Defect & Polish Resolutions
- **`[BLOCKING-1]` (`packages/benday-ps/src/bridge/PhotoshopCmykBridge.js`, `test/mocks/photoshop.js`, `test/PhotoshopCmykBridge.mock.test.js`):**
  - Removed every `app.activeDocument = ...` assignment; added `selectDocumentById(action, docId)` using `batchPlay` (`{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }`) before `dupDoc` operations, inside each `chDoc` iteration of Step 4, prior to Step 5, and in `cleanupTempDocs`.
  - Unlocked/promoted each split Grayscale document's locked `Background` layer (`{ _obj: 'set', _target: [{ _ref: 'layer', _property: 'background' }], to: { _obj: 'layer', name: 'Layer 0' } }`) before calling `imaging.putPixels` with the unlocked layer's `layerID`.
  - Replaced `cMYKColorClass` fill with `{ _obj: 'fill', using: { _enum: 'fillContents', _value: 'white' }, opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } }`, added explicit `{ _obj: 'move', ..., to: { _ref: 'layer', _enum: 'ordinal', _value: 'front' } }` so top Layer Groups never trap the halftone layer, and reselected composite CMYK channels via `origDoc.activeChannels = origDoc.componentChannels` (with `batchPlay` `'CMYKEnum'` fallback).
  - Also upgraded `createTempSplitChannels` (`splitDocs.length >= 4`, `splitDocs.slice(0, 4)`) so documents with extra alpha/spot channels succeed cleanly while closing all `dupDoc + 4 + extra` temporary documents in `finally`.
  - Upgraded `test/mocks/photoshop.js` to enforce getter-only `app.activeDocument`, locked `isBackgroundLayer: true` rejection in `putPixels`, 16-bit per-doc depth checks, group nesting, and extra alpha channels.
- **`[BLOCKING-2]` (`packages/benday-core/lib/PlateVerifier.js`, `test/HalftoneEngine.test.js`):**
  - Removed `require('./HalftoneEngine')`; implemented an independent direct-offset `openByCanonicalDisk` oracle from `MeshPhysics.getCanonicalDiskOffsets`.
  - Added separable `O(W * H)` Chebyshev (`L_∞`) neighborhood check around `src > 0` (`maxBleedRadiusX/Y = max(2 * dMinPxX/Y, ceil(cellPitchPxX/Y))`) alongside floating-component checks, with unit test coverage for connected ink bleeding across `0%` paper.
- **`[BLOCKING-3]` (`packages/benday-cli/src/tiffCodec.js`, `src/cli.js`, `test/cli.test.js`, `packages/benday-cli/README.md`):**
  - Fixed 1-channel Grayscale TIFF `PhotometricInterpretation = 1` (`BlackIsZero`) polarity (`encodeTiff` writes `255 - gray[i]` so `0` = black `100%` ink and `255` = white `0%` paper; `decodeTiff` inverts `BlackIsZero` via `255 - raw[i]` while preserving `WhiteIsZero` `photometric === 0`), cleaned up `entryCount = isCmyk ? 14 : 13`, and added CLI verification tests including 4-channel `benday verify <cmyk.tif> --src`.
- **`[BLOCKING-4]` (`packages/benday-core/lib/HalftoneEngine.js`, `test/HalftoneEngine.test.js`):**
  - Extracted `pureGraphicCounters` directly from `(srcUint8, mSolid)` prior to Stage 5/6 so neither cell-averaged rasterization nor Stage 6 `Op A`/`Op B` bridge-stamping ever plugs fine `{0, 255}` counters inside `M_solid` frames.
  - Raised `MAX_CLOSURE_PASSES` from `12` to `256` with a final safety `Op A` pass if the cap is reached, and upgraded `Op B` covering-anchor selection (`validBridgeAnchor` + 1D `rowPrefix` span scoring) to maximize overlap with existing `plate === 255` ink so bridges tuck inward rather than marching into `0%` paper.
- **Polish `#1–#3` & Docs Attribution:**
  - Cleared stale preview crop & `<canvas>` on modal re-open (`bendayDialog.setPreviewCropData(null)` in `src/index.js` + `clearRect` in `BendayDialog._paintCanvas()`).
  - Replaced full-frame `Int32Array((width + 2) * height)` in `dilateByDiskSpans` with compact per-row runs and a single reused `Int32Array(width + 2)` row buffer.
  - Synced `besselJ1(x)` JSDoc in `RosetteAngles.js` and updated root `README.md` attribution to `Architecture, design, and code by Gemini.`

### 2. Round 1 & Round 2 Adversarial CMYK Torture Suite (`01`..`11`)
- **Extended Zero-External-Dep TIFF 6.0 Decoder (`packages/benday-cli/src/tiffCodec.js`):** Added full support for `Deflate` (`Compression = 8 / 32946` via Node built-in `zlib`) + `Predictor = 2` horizontal differencing, `ExtraSamples` (`SamplesPerPixel >= 4`), `16-bit` unsigned Big-Endian (`'MM'`) & Little-Endian (`'II'`), `PlanarConfiguration = 2` (`separate` planes), **Tiled TIFFs** (`Tags 322–325` with padded edge-tile clipping on odd dimensions), and independent `(dpiX, dpiY)` in both `INCH` (`2`) and `CENTIMETER` (`3`).
- **True Physical-Inch Anisotropic `(dpiX, dpiY)` Support (`MeshPhysics.js`, `HalftoneEngine.js`, `PlateVerifier.js`, `cli.js`):** Added optional `(dpiX, dpiY)` physical scaling (`dMinPxX`, `dMinPxY`, normalized physical disk `getCanonicalDiskOffsets(dMinPxX, dMinPxY)`, `(cellPitchPxX, cellPitchPxY)` screen-lattice projection), verified bit-for-bit identical when `dpiX === dpiY` while keeping dots & screen angles physically round in real inches at `600 × 1200 DPI` (and Phase-2 Epson `720 × 1440` film output).
- **End-to-End Torture Results (`230 TPI`, `N = 4.0`, `meshAngleDeg = 18°`, `tailMode = 'hybrid'`):**

| # | Adversarial Target | Dimensions | DPI | Halftone (4ch) | Ink Coverage (`C / M / Y / K`) | Violations (`dot / hole / bleed / solid`) | Verdict |
|---|---|---|---:|---:|---|---:|---|
| `01` | `01_subcell_whisper_0_to_8pct.tif` | `2400 × 1800` | `600` | `1.16 s` | `1.6% / 1.6% / 1.6% / 1.6%` (`0.0%` band = `0 px`) | `0 / 0 / 0 / 0` | **PASS** |
| `02` | `02_moire_17_19deg_sweep.tif` | `2400 × 2400` | `600` | `1.47 s` | `30.5% / 0.0% / 0.0% / 38.8%` | `0 / 0 / 0 / 0` | **PASS** |
| `03` | `03_shadow_mud_bomb_88_to_100pct.tif` | `2400 × 1800` | `600` | `1.60 s` | `46.5% / 46.5% / 46.5% / 93.3%` | `0 / 0 / 0 / 0` | **PASS** |
| `04` | `04_rosette_collision_patches.tif` | `2400 × 2400` | `600` | `1.29 s` | `24.6% / 28.2% / 28.9% / 12.6%` | `0 / 0 / 0 / 0` | **PASS** |
| `05` | `05_razor_edge_17_19deg_lines.tif` | `2400 × 2400` | `600` | `0.98 s` | `25.0% / 25.0% / 25.0% / 25.2%` | `0 / 0 / 0 / 0` | **PASS** |
| `06` | `06_prime_3989x5501_317dpi.tif` | `3989 × 5501` | `317` | `5.14 s` | `48.2% / 47.6% / 27.1% / 0.0%` | `0 / 0 / 0 / 0` | **PASS** |
| `07` | `07_empty_CK_plus_2_extra_channels.tif` (`6ch`) | `1800 × 1800` | `600` | `0.44 s` | `0.0% / 48.4% / 48.4% / 0.0%` (`C=0, K=0`) | `0 / 0 / 0 / 0` | **PASS** |
| `08` | `08_16bit_bigendian_planar.tif` (`16b MM Planar`) | `1200 × 1200` | `600` | `0.44 s` | `48.4% / 48.4% / 37.4% / 6.6%` | `0 / 0 / 0 / 0` | **PASS** |
| `09` | `09_predictor2_deflate.tif` (`Predictor=2`) | `1200 × 1200` | `600` | `0.44 s` | `48.4% / 48.4% / 37.4% / 6.6%` | `0 / 0 / 0 / 0` | **PASS** |
| `10` | `10_tiled_256x256_odd_1137x1493.tif` (`Tiled`) | `1137 × 1493` | `600` | `0.55 s` | `48.3% / 48.5% / 37.4% / 6.1%` | `0 / 0 / 0 / 0` | **PASS** |
| `11` | `11_anisotropic_600x1200_metric_cm.tif` (`CM`) | `1200 × 2400` | `600×1200` | `6.92 s` | `48.6% / 48.5% / 37.7% / 18.8%` (`D_min=11×21 px`) | `0 / 0 / 0 / 0` | **PASS** |

- **Workspace Verification:** `npm test` **`100%` (`7/7` test files, `39/39` tests passing)**; `npm run build:ps` (`51.4 KiB` bundle) & `npm run package:ps` (`benday-v0.1.0.ccx`, `21.5 KB`) clean; `benday-core` zero-dependency / zero-Node-builtin audit `PASS`; `git status` clean (`44` tracked-scope files, zero stray files).

[WAITING FOR REVIEWER]

---

## [Scribe] — 2026-11-13 23:07

**Topic:** Frozen v0.1 Scope Documentation Sync & Post-v0.1 Roadmap (`docs/FUTURES.md`)

- Created `docs/FUTURES.md` capturing all 5 deferred post-v0.1 specifications (`FftMoireAnalyzer.js`, `meshPreflight.js`, Rich Black + Choked Underbedding & TAC Control, Direct Inkjet Film-Positive Output for Epson `3880` / `720×1440` & `1440×2880` DPI, and `Reveal` Spot-Color Halftoning).
- Synced `README.md`, `packages/benday-core/README.md`, and `packages/benday-cli/README.md` with Round-2 TIFF (`8/16-bit`, `chunky/planar`, `stripped/tiled`, `Deflate` + `Predictor=2`) and anisotropic `(dpiX, dpiY)` capabilities while enforcing house style (**"screens"**, never "plates" in user-facing prose).

[WAITING FOR REVIEWER]

---

## [Reviewer] — 2026-11-13 23:12

**Topic:** Final Adversarial Commit-Gate Re-Audit (Benday v0.1)

**STATUS: APPROVED FOR COMMIT**

Independent line-by-line commit-gate re-audit completed across `/Users/shankar/development/electrosaur/benday/`. Every blocking defect (`[BLOCKING-1]`..`[BLOCKING-4]`) and polish observation (`#1`..`#3`) from Round 1 is cleanly resolved with zero regressions:

1. **`[BLOCKING-1]` & Polish `#1` (`@electrosaur-labs/benday-ps`) — VERIFIED FIXED:**
   - All read-only `app.activeDocument = ...` assignments replaced with `selectDocumentById(action, docId)` via `batchPlay`.
   - Split-channel Grayscale `Background` layers promoted to unlocked pixel layers before `convertMode` / `imaging.putPixels`.
   - Extra alpha/spot channels (`splitDocs.length >= 4`) handled and cleaned up in `finally`; output layer moved to `ordinal: 'front'` (`adjustment: false`), filled via `fillContents: 'white'`, and composite CMYK channels restored via `origDoc.componentChannels` (with `'CMYKEnum'` fallback).
   - Stale preview crop and `<canvas>` cleared on modal re-open.
2. **`[BLOCKING-2]` (`@electrosaur-labs/benday-core/lib/PlateVerifier.js`) — VERIFIED FIXED:**
   - Zero imports from `./HalftoneEngine`; uses independent `openByCanonicalDisk` oracle and separable 2D Chebyshev neighborhood check (`computeChebyshevPositiveNeighborhood`) + connected-component zero-overlap check.
3. **`[BLOCKING-3]` & Real-World TIFF 6.0 Support (`@electrosaur-labs/benday-cli`) — VERIFIED FIXED:**
   - 1-channel Grayscale TIFF writes `PhotometricInterpretation = 1` (`BlackIsZero`, `255 - gray[i]`, `entryCount = 13`); `decodeTiff` supports `BlackIsZero` & `WhiteIsZero`, `'II'` & `'MM'`, `8/16-bit`, `PlanarConfiguration = 1/2`, Stripped & Tiled (`Tags 322–325`), `Deflate` + `Predictor = 1/2`, `SamplesPerPixel >= 4`, and isotropic/anisotropic `XResolution`/`YResolution` (`inch` & `cm`).
4. **`[BLOCKING-4]`, Anisotropic `(dpiX, dpiY)`, & Polish `#2`..`#3` (`@electrosaur-labs/benday-core`) — VERIFIED FIXED:**
   - Physical-inch `(dpiX, dpiY)` lattice projection and `getCanonicalDiskOffsets(dMinPxX, dMinPxY)` elliptical discrete pixel stamps (bit-identical when `dpiX === dpiY`).
   - Single-row `Int32Array(width + 2)` buffer in `dilateByDiskSpans`, `extractPureGraphicCounters` protection across Stages 5–6, inward `rowPrefix` + `validBridgeAnchor` scoring in `Op B`, `MAX_CLOSURE_PASSES = 256` with final `Op A`, and synced `besselJ1` JSDoc.
5. **Zero-Dependency Core, Tests, & Documentation Gate — VERIFIED CLEAN:**
   - `@electrosaur-labs/benday-core` has zero runtime `dependencies` and zero Node.js built-ins.
   - `39/39` Vitest tests (`7/7` files) and `11/11` adversarial CMYK torture targets (`44` screens) pass with `0` violations.
   - All 7 documentation/license files (`LICENSE`, `README.md`, `docs/USER-GUIDE.md`, `docs/FUTURES.md`, and 3 package `README.md`s) comply 100% with house style and technical contracts.

**Electrosaur: Benday v0.1 is cleared for commit.**

[WAITING FOR PRINCIPAL]

---

## [Developer] — 2026-11-14 00:08

**Topic:** Live Photoshop v27.5+ UXP Runtime Hotfix (`doc.duplicate()` Regression & Modal Document-Tab Lock)

1. **Pure-`batchPlay` Document Lifecycle, `assertBatchPlayOk`, & Integer-ID Tracking (`packages/benday-ps/src/bridge/PhotoshopCmykBridge.js`):**
   - Eliminated all UXP DOM convenience mutators (`origDoc.duplicate()`, `dupDoc.flatten()`, and `td.closeWithoutSaving()`) and replaced live `Document` proxy array `tempDocs` with finite integer `tempDocIds` (`number[]`).
   - Added `assertBatchPlayOk(res, label)` on critical `batchPlay` steps (`duplicate`, `flattenImage`, `splitChannels`, layer `make/move/fill`, `applyImageEvent`) to surface silent `{ _obj: 'error' }` ActionManager descriptors (`-25920`).
   - Added `readFullCmykChannels(app, psDeps)` and `< 1 ms` pure-JS `sliceCmykCrop(fullData, bounds)`, and updated `commitHalftoneLayer(..., preReadChannels)` to skip redundant full-resolution `imaging.getPixels` reads when pre-modal `preReadChannels` are supplied.
2. **Pre-Modal Full CMYK Cache & Post-Modal Commit (`packages/benday-ps/src/index.js`):**
   - Calls `readFullCmykChannels` **before** `dlg.uxpShowModal` opens so Photoshop's modal window manager never blocks temporary document creation, and slices 1:1 preview crops in pure JS (`sliceCmykCrop`) with zero Photoshop calls during drag-pan / `Center`.
   - On **Apply Halftone**, closes `<dialog>` (`closeDialogElement()`) **before** running `commitHalftoneLayer(..., preReadChannels)` once `await dlg.uxpShowModal(...)` resolves, freeing `cachedFullCmyk = null` immediately on Apply or Cancel/dismiss.
3. **Strict Regression Mock & Verification (`packages/benday-ps/test/`):**
   - Added mock tests covering `doc.duplicate()` UXP DOM regression, `_id` / ActionManager `get` fallbacks, `assertBatchPlayOk` surfacing `-25920` modal tab-creation errors, pure-JS `sliceCmykCrop` while modal tab-lock is active, and bit-identical `commitHalftoneLayer` with `preReadChannels`.
   - `npm test` passes **`100%` (`7/7` test files, `43/43` tests)**; rebuilt `packages/benday-ps/dist/index.js` (`58.9 KiB`) and `packages/benday-ps/benday-v0.1.0.ccx` (`23.6 KB`) ready for UXP Developer Tool **Reload**.

---

## [Developer] — 2026-11-14 13:43

**Topic:** Live Photoshop Calibration, Reveal-Style UI Parity & Final `v0.1` Correctness Polish

1. **Press-Room `Rule of N` (`N = 5.0`), Official 20-Roll `SAATI_MESH_PRESETS`, & `300 DPI` Warning Thresholds (`packages/benday-core/lib/MeshPhysics.js`):**
   - Refactored `Rule of N` to true press-room `threads per halftone cell` (`RULE_OF_N_DEFAULT = 5.0`, `230-48 @ N=5.0 -> 46.0 LPI`, range `[2.0, 10.0]` in `0.5` steps) and added frozen 20-entry `SAATI_MESH_PRESETS` (`110-80` through `420-27`, including `Hi-R` thin-thread pairs).
   - Tightened `WARN_LOW_DPI` (`dpi < 300 || cellPitchPx < 5.0`) and `WARN_NARROW_AM_RANGE` (`tMin > 0.25`) so standard `300 DPI` documents at `230-48 @ N=5.0` (`cellPitchPx = 6.52 px`, discrete `tMin = 21.2%`) and `355-31 @ N=7.0` (`cellPitchPx = 5.91 px`, `tMin = 11.5%`) run warning-free without pinning the bottom warning banner.
2. **Angle-Neutral Discrete Tone Calibration & Global Lattice Phase Lock (`packages/benday-core/lib/HalftoneEngine.js`):**
   - Added cached 256-entry 1D empirical area-calibration LUT (`getChannelCalibrationLut`, `< 3.14%` neutral spread across `{15°, 45°, 60°, 75°}`), inward-only `Op B` bridge closure eliminating the `50%` midtone jump, and `originX` / `originY` screen-lattice phase lock so cropped `16 px`-halo viewports match full-canvas dot registration.
3. **Title-Verified `splitChannels`, Non-Destructive Layer Hiding on Commit & Re-Run Guard (`packages/benday-ps/src/bridge/PhotoshopCmykBridge.js`):**
   - Added ActionManager document-title classification (`_Cyan` / `_Magenta` / `_Yellow` / `_Black` suffix verification) so `splitChannels` never scrambles CMYK channels regardless of tab order.
   - `commitHalftoneLayer` now marks underlying non-`Benday Halftone*` root layers `visible = false` inside the single-undo `suspendHistory` state (matching `Reveal`), and `readCmykViaSplitChannels` re-enables hidden source layers on the temporary `dupDoc` when `0` visible source layers remain so `Reread Document` and repeat runs never flatten to white.
4. **Reveal-Style UI Polish, Stacked Header (`Esc` Cancel), Actionable Min-DPI Readouts, UXP Banner Clearing & `v0.2` Roadmap (`packages/benday-ps/`, `docs/`):**
   - Stacked `#btn-reread`, `#btn-reset-top`, and `#btn-benday-apply` full-width vertically in block `#knobs-header` with explicit `margin: 0 0 6px 0;` (`height: 32px`, `font-weight: 600`, matching `Reveal` without relying on unsupported UXP flex `gap`), removed `#btn-benday-cancel` (`Escape` exits solo screen view first, or cancels/closes the dialog in `composite` view), and inlined `styles.css` into `dist/index.html` inside `scripts/copy-assets.js` so UXP Developer Tool Reload never serves cached CSS.
   - Updated all `ERR_DPI_TOO_LOW` messages in `MeshPhysics.js` and warning readouts in `BendayDialog.js` to compute and display the exact minimum DPI required (`need >= X DPI`) rather than raw enum codes.
   - Added `setElementVisible` combining explicit `classList.add`/`remove` + inline `style.display = 'block' | 'none'` for UXP Torq layout clearing across `#benday-warnings-box`, `#benday-error-banner`, `#custom-mesh-row`, `.knob-help`, and `.knob-revert`; cleared stale `anglesOverride`/`lpiOverride` when adjusting `Mesh Bias Angle` or `Rule of N`.
   - Added `SWOP_BINARY_RGB` 16-entry binary overprint fast path, lazy `_originalDataUrl` PNG encoding on first click, and single-channel `halftoneChannel` when soloing `C/M/Y/K` at zoom (`Fit / 50% / 100% / 200%`).
   - Recorded all deferred `v0.2` specifications (Save/Load Press Config, Perceptual HVS Viewing-Distance `ΔE` & gray-step score, Optional `2×` output supersampling, Image-Aware Rosette Assignment, Rosette Angle Presets dropdown, Mesh Bias stretcher-slop error bar, Press Dot Gain, `meshPreflight`, Rich Black/TAC, `BVG`) in `docs/FUTURES.md`, and synced `docs/USER-GUIDE.md` + package `README.md`s.

[WAITING FOR REVIEWER]

---

## [Reviewer] — 2026-11-14 14:12

**Topic:** Final v0.1 Commit-Gate Re-Audit (Post Live Photoshop UXP Hotfixes, Press-Room Calibration & Docs Sync)

**STATUS: APPROVED FOR COMMIT**

### 1. Post-Round-2 Engineering & Calibration Audit (`0` Blocking Defects)
- **`@electrosaur-labs/benday-core` (`packages/benday-core`):**
  - **Zero-Dependency & Zero-Node-Builtin Mandate (`PASS`):** `packages/benday-core/package.json` has zero runtime dependencies (`devDependencies` contains only `vitest`), and `index.js` + `lib/{MeshPhysics,RosetteAngles,EuclideanLut,HalftoneEngine,PlateVerifier}.js` import zero Node.js built-in modules (`fs`, `path`, `Buffer`, `zlib`, `crypto`, `process`, `os`, `stream`, `util` all absent and guarded by `MeshPhysics.test.js`).
  - **Press-Room Mesh Physics & SAATI Catalog (`MeshPhysics.js` — `PASS`):** Verified `RULE_OF_N_DEFAULT = 5.0` (`cellPitchNatIn = (ruleOfN / meshTpi) * openAreaScale`, yielding `46.0 LPI` and `dMinPx = 5` on `230-48` @ `600 DPI`), frozen 20-entry `SAATI_MESH_PRESETS` (`110-80` through `420-27`, including standard and `Hi-R` thin-thread rolls), exact `minValidDpi` calculation embedded in all `ERR_DPI_TOO_LOW` messages (`need >= ${minValidDpi} DPI`), and updated warning thresholds (`dpi < 300 || cellPitchPx < 5.0` for `WARN_LOW_DPI`; `tMin > 0.25` for `WARN_NARROW_AM_RANGE`).
  - **Neutral Area Calibration, Monotone Midtone Bridging & Phase Lock (`HalftoneEngine.js` & `PlateVerifier.js` — `PASS`):** Verified the cached 256-entry 1D empirical discrete area-calibration LUT (`getChannelCalibrationLut`, bounded at `MAX_CALIBRATION_CACHE = 128`) and serpentine bridge-transition dithering across `(fMaxUnbridged, fMinBridged)` eliminating the `51%–60%` corner-bridge ink jump (`<= 3.5%` spread across `0°, 15°, 45°, 75°`), inward-only `Op B` bridge closure (`validBridgeAnchor` + `rowPrefix` scoring) with `MAX_CLOSURE_PASSES = 256` + final `Op A`, `pureGraphicCounters` protection, global lattice phase lock (`originX`, `originY`), and complete morphological independence of `PlateVerifier.js`.
- **`@electrosaur-labs/benday-ps` (`packages/benday-ps`):**
  - **Pure-`batchPlay` Photoshop v27.5+ Bridge & Non-Destructive Layer Lifecycle (`PhotoshopCmykBridge.js`, `src/index.js` — `PASS`):** Verified zero UXP DOM `doc.duplicate()`, `doc.flatten()`, or `doc.closeWithoutSaving()` calls; `assertBatchPlayOk` catching ActionManager `{ _obj: 'error' }` (`-25920`); pre-modal `readFullCmykChannels` + post-modal `executePendingApply` avoiding modal tab-creation locks; title-verified `splitChannels` classification (`_Cyan/_Magenta/_Yellow/_Black` suffix matching before `_C/_M/_Y/_K`); single-`suspendHistory("Benday Halftone")` commit creating/replacing top `Benday Halftone (...)` layer and hiding underlying non-`Benday Halftone*` root layers; Re-Run Guard hiding prior `Benday Halftone*` layers and re-enabling hidden non-Benday root layers on `dupDoc` (`!hasVisibleNonBendayLayer`) so **Reread Document** and repeat runs never flatten to blank white; and 3-gate `finally` cleanup protecting `origDoc`.
  - **Dialog UI, Viewport Rendering & Inlined CSS (`BendayState.js`, `BendayDialog.js`, `index.html`, `styles.css`, `scripts/copy-assets.js` — `PASS`):** Verified Reveal-style stacked 3-button `#knobs-header` (`#btn-reread`, `#btn-reset-top`, `#btn-benday-apply`, `height: 32px`, `margin: 0 0 6px 0`, no `Cancel` button), `Escape` un-soloing channel first or dismissing dialog from `Composite`, `setElementVisible` combining `.visible` class + inline `style.display`, human-readable min-DPI banner guidance, `SWOP_BINARY_RGB` 16-entry fast path, lazy `_originalDataUrl` allocation, solo `halftoneChannel` rendering at `50% / 100% / 200%` zoom, and `scripts/copy-assets.js` inlining `styles.css` into `dist/index.html`.
- **`@electrosaur-labs/benday-cli` (`packages/benday-cli`):**
  - **`cli.js` & `tiffCodec.js` (`PASS`):** Verified `ruleOfN` default updated to `5.0` (`46.0 LPI` on `230-48`), full 8/16-bit LE/BE stripped/tiled Deflate/uncompressed CMYK & `BlackIsZero`/`WhiteIsZero` Grayscale TIFF + PGM support, anisotropic `dpiX`/`dpiY` round-tripping, and 1-channel/4-channel `benday verify`.

### 2. Documentation, House Style & Repository Hygiene (`PASS`)
- **Documentation & Terminology:** Audited `LICENSE`, `README.md`, `docs/USER-GUIDE.md`, `docs/FUTURES.md`, `packages/benday-core/README.md`, `packages/benday-ps/README.md`, and `packages/benday-cli/README.md` (with `RosetteAngles` `5.1 mm / 6.4 mm` thresholds and `[ruleOfN=5.0]` JSDoc defaults synced). User-facing prose strictly uses **"screens"** (never **"plates"**), matches the `Rule of N = 5.0` (`46.0 LPI` @ `230-48`) physics and 20-roll `SAATI_MESH_PRESETS` catalog, documents the non-destructive layer visibility & Re-Run Guard workflow accurately, and contains zero profanity.
- **Test Coverage & Stray-File Gate:** `7/7` test files (`50/50` tests, including the `720`-screen invariant matrix) pass `100%`, and `.gitignore` cleanly excludes `node_modules/`, `dist/`, `coverage/`, `*.ccx`, `.DS_Store`, `.idea/`, and `tmp/`.

**Electrosaur: Benday v0.1 is cleared for final commit upon Principal's directive.**

[WAITING FOR PRINCIPAL]


---

## [Reviewer] — 2026-11-14 19:07

**Topic:** Final Pre-Tag Commit Gate (`v0.1.0` + `HOKUSAI.md` / `SUITE-SYNERGY.md` / `FUTURES.md` / `README.md`)

**STATUS: APPROVED FOR COMMIT**

- **Documentation & House Style (`PASS`):** Audited `docs/HOKUSAI.md` (dedicated to William Henry Fox Talbot), `docs/SUITE-SYNERGY.md`, `docs/FUTURES.md`, and `README.md` line by line. All prose strictly uses **"screens"** (never **"plates"**; `PlateVerifier.js` appears only as an exact filename identifier), accurately frames **Benday** alongside **Reveal** (`4-screen` speed + physically honest comparison baseline) and **Hokusai** (headless `libgutenprint` raw `ESC/P2` film-positive spooler), and contains zero profanity.
- **Zero-Stray-File Hygiene (`PASS`):** `.gitignore` cleanly excludes `node_modules/`, `dist/`, `coverage/`, `*.ccx`, `.DS_Store`, `.idea/`, and `tmp/`.
- **Gate Cleared:** Approved for initial `v0.1.0` commit, push, and `v0.1.0` tag.

[WAITING FOR PRINCIPAL]


---

## [Architect] — 2026-11-14 20:23

**Topic:** `Benday v0.2` Architectural & Mathematical Specification (7 Approved Deliverables)

1. **Press Dot Gain (`dotGain` `0..20%`, `--dot-gain`):** Parabolic midtone pullback $t_{\text{film}} = t - 4\Delta G\,t(1-t)$ applied at the end of Stage 1 in `HalftoneEngine.js` (preserving `0%` paper and `100%` solid fixed points and feeding `tMin`/`tMax` tails cleanly), with full `Preview = Production` parity across `Fit`, solo `C/M/Y/K`, and zoomed views.
2. **`BvgEdgeSnapper.js` (`bvg`, default `false`, `--bvg` / `--no-bvg`):** Zero-dependency 2-stage conditioning: (A) 2-pass 3–4 Chamfer Distance morphological opening (`strokeWidth < 2 * cellPitchPx`, canvas-border bleed safe) promoting narrow Rich-Black text strokes to solo `K=255, CMY=0` while leaving wide Rich-Black fills 100% intact; (B) `5×5` exact Otsu separability ($\eta \ge 0.82$, $\Delta I \ge 128$, valley count $N_{\text{mid}} \le 7$) with `1 px` hairline and `1 px` letter-counter (`e/a/o`) guards and strict `0`-pixel modification on photographic gradients/grain.
3. **`PressConfig.js` (`.benday.json` + `.psd` Round-Trip):** `schemaVersion: "0.2.0"`, `serializePressConfig` / `parsePressConfig`, UXP `Save… / Load…`, CLI `--config` / `--save-config`, and non-destructive layer `generatorSettings` + post-`resumeHistory` `XMPMetadataAsUTF8` auto-restore when an existing `Benday Halftone*` layer is present.
4. **Hold-to-Blink `Original` Comparator:** `< 300 ms` click toggles `ORIGINAL`; `>= 300 ms` hold blinks `Original ↔ Halftone` at `400 ms` with deterministic timer cleanup.
5. **Rosette Angle Presets + `< 2 ms` Image-Aware Slots:** `ROSETTE_PRESETS` (`auto`, `image-aware`, `fta`, `iso`, `flamenco`, `manual`) and `assignImageAwareRosetteSlots` minimizing Campbell–Kulikowski `45°` oblique-effect contrast + `15°` 2-ink co-occurrence across `{θ+15°, θ+45°, θ+60°, θ+75°}`.
6. **`HvsQuality.js` (`HVS ΔE` & `Gray Steps/Cell`):** SWOP Coated 8-primary linear D50 `XYZ` Neugebauer $\to$ canonical 16-bit Engine CIELAB (`0..32768`, `16384` neutral) $\to$ separable Gaussian HVS blur ($\sigma = \operatorname{clamp}(1.5 \cdot \text{cellPitchPx}, 0.75, 16.0)$) $\to$ `{ meanDeltaE, p95DeltaE, maxDeltaE, grayStepsPerCell }` in `#hvs-telemetry` and CLI `--json`.
7. **`★ Credits ★` Window & Ben Day (1879) Dedication:** `CreditsController.js`, clickable 1879 Ben Day Rapid Shading Medium Broadside Easter Egg, all 9 Algorithmic & Optical Legends mapped to live `Benday` modules, `electrosaur.png` bundling in `copy-assets.js`, and UXP `<dialog>` `Escape` non-reread re-show guard.

[WAITING FOR DEVELOPER]

---

## [Developer] — 2026-11-14 21:14

**Topic:** `Benday v0.2.0` Implementation, Verification & Benchmark Report (All 7 Deliverables Complete)

1. **Version Bump & Packaging (`0.1.0` → `0.2.0`):**
   - Updated version to `"0.2.0"` across root `package.json`, `packages/benday-core/package.json`, `packages/benday-ps/package.json`, `packages/benday-ps/manifest.json`, and `packages/benday-cli/package.json`.
   - Updated `packages/benday-ps/scripts/package.js` to unlink stale `benday-v*.ccx` archives and emit `benday-v0.2.0.ccx` (`828.2 KB`), and updated `packages/benday-ps/scripts/copy-assets.js` to bundle `src/assets/electrosaur.png` → `dist/assets/electrosaur.png`.

2. **Zero-Dependency Core (`packages/benday-core` — `0` external deps, `0` Node.js built-ins):**
   - **Press Dot Gain (`lib/HalftoneEngine.js`):** Implemented `applyDotGainPullback(t, dotGain)` ($t_{\text{film}} = t - 4\Delta G\,t(1-t)$, $\Delta G \in [0, 0.20]$) applied at the end of Stage 1 before Stage 2 Euclidean / FM tail routing, preserving `0%` paper (`t=0`) and `100%` solid (`t=1`) as exact fixed points. Exposed `result.screens` (retaining `result.plates` alias) and `result.conditionedChannels`; added `verifyScreenInvariants` (`ScreenVerifier`) in `lib/PlateVerifier.js`.
   - **`BvgEdgeSnapper.js` (`lib/BvgEdgeSnapper.js`):** Implemented 2-stage conditioning (`snapChannelEdges`, `snapCmykEdges`): Stage A 2-pass 3–4 Chamfer Distance morphological opening (`rOpen = max(1, round(3 * max(1.5, cellPitchPx - 0.5)))`) promoting narrow Rich-Black type strokes (`< 2 * cellPitchPx`, including border/corner-touching fills safely) to solo `K=255, CMY=0` while leaving wide Rich-Black fills 100% intact; Stage B `5×5` exact Otsu separability ($\eta \ge 0.82$, $\Delta I \ge 128$, extreme pole guard, valley sparsity $N_{\text{mid}} \le 7$, and `3×3` antipodal ridge/valley topology guards preserving `1 px` hairlines and `1 px` enclosed `e/a/o` counters, with `0` modified pixels on continuous gradients and $\sigma=18$ Gaussian grain).
   - **`PressConfig.js` (`lib/PressConfig.js`):** Implemented `PRESS_CONFIG_SCHEMA_VERSION = '0.2.0'`, `serializePressConfig`, `parsePressConfig` (strict bounds & custom angle normalization), `embedPressConfigInXmp`, and `extractPressConfigFromXmp` (`<!-- BENDAY:BEGIN -->...<!-- BENDAY:END -->`).
   - **Rosette Presets & `< 2 ms` Image-Aware Slots (`lib/RosetteAngles.js`):** Implemented `ROSETTE_PRESETS` (`auto`, `image-aware`, `fta`, `iso`, `flamenco`, `manual`), `resolveRosettePresetAngles`, and strided ($S \le 64 \times 64$) `assignImageAwareRosetteSlots` (`1.20 ms` on `2400 × 3000`) minimizing Campbell–Kulikowski `45°` oblique-effect contrast + `15°` 2-ink co-occurrence.
   - **`HvsQuality.js` (`lib/HvsQuality.js`):** Implemented `computeGrayStepsPerCell` and `computeHvsQuality` convolving SWOP Coated 8-primary linear D50 `XYZ` photon fields with a separable Gaussian HVS PSF ($\sigma = \operatorname{clamp}(1.5 \cdot \text{cellPitchPx}, 0.75, 16.0)$) prior to converting both `Original` and `Halftone` fields into canonical **16-bit Engine CIELAB** (`Uint16Array`, `L: 0..32768`, `a/b: 0..32768`, `16384` neutral) to avoid cube-root Jensen bias on binary halftones while preserving strict CIELAB Sovereignty (`0` RGB math).

3. **Photoshop UXP Plugin (`packages/benday-ps`):**
   - **State & Preview Parity (`BendayState.js`, `BendayDialog.js`):** Added `dotGain`, `bvg`, and `rosettePreset` with `Preview = Production` parity across `Fit` (evaluating `snapCmykEdges` + `applyDotGainPullback` on `Halftone` while `Original` stays unmodified), `50% / 100% / 200%` zoomed viewports, and solo `C/M/Y/K` views; live `HVS ΔE` & `Gray Steps/Cell` telemetry (`#hvs-telemetry`, `#phys-hvs-quality`) evaluated on a `<= 192 × 192` native-DPI center crop.
   - **Hold-to-Blink `Original` Comparator (`BendayDialog.js`):** Implemented `< 300 ms` click-to-toggle vs `>= 300 ms` press-and-hold `400 ms` periodic alternation on both `#preview-container` (cancelling cleanly on `>= 4 px` pan-drag) and `#btn-view-original`.
   - **Save / Load `.benday.json` & `.psd` Metadata Round-Trip (`PhotoshopCmykBridge.js`, `src/index.js`):** Wired `#btn-save-config` and `#btn-load-config` via `uxp.storage.localFileSystem`, embedded config into layer `generatorSettings` inside `suspendHistory` and document `XMPMetadataAsUTF8` post-`resumeHistory`, and added `readSavedPressConfigFromDocument` on initial dialog open (guarded by `collectPriorBendayLayerRefs(origDoc.layers).length > 0` so deleted Benday layers never surprise-restore stale XMP).
   - **`★ Credits ★` Crawl & Benjamin Henry Day Jr. (1879) Dedication (`CreditsController.js`, `index.html`, `styles.css`):** Implemented theatrical `24 px/sec` `requestAnimationFrame` crawl (`#credits-viewport`, hover/wheel pause, `electrosaur.png` emblem), clickable 1879 Ben Day Rapid Shading Medium Broadside Easter Egg (`#manifesto-broadside`), all 9 Spec §7.2 Algorithmic & Optical Legends, 5-step `Escape` priority (`Broadside -> Credits -> Solo Screen -> Blink -> Cancel Dialog`), and `reopenModalWithoutReread` guard in `src/index.js`. Zero CSS column `gap`s used anywhere in `styles.css`.

4. **Headless CLI (`packages/benday-cli`) & Documentation Sync:**
   - Added `--config <file.json>`, `--save-config <file.json>`, `--dot-gain <pct>`, `--bvg` / `--no-bvg`, and `--rosette-preset <preset>` to `src/cli.js` (`defaults < --config < explicit CLI flags`), surfaced `grayStepsPerCell` in `benday spec` and `hvsQuality` in `benday halftone --json`, and verified conditioned solid/paper invariants via `verifyScreenInvariants`.
   - Synced `README.md`, `packages/benday-core/README.md`, `packages/benday-ps/README.md`, `packages/benday-cli/README.md`, `docs/USER-GUIDE.md`, and `docs/FUTURES.md` strictly adhering to **"screens"** (never "plates" in prose).

5. **Test Suite, Benchmarks & Zero-Stray-Files Audit:**
   - **Full Workspace Vitest Suite (`npm test`):** **`11/11` test files (`69/69` tests) passing `100%`** (`benday-core`: `37/37` incl. 720-screen adversarial matrix; `benday-ps`: `25/25`; `benday-cli`: `7/7`).
   - **Apple Silicon Benchmark (`2400 × 3000 @ 300 DPI`, `28.80 MP` channel pixels, `230-48 @ N=5.0`):**
     - `assignImageAwareRosetteSlots`: **`1.20 ms`** (`< 2.0 ms` target)
     - `snapCmykEdges` (full 4-channel `28.80 MP` Stage A + Stage B BVG): **`721.8 ms`**
     - Full `halftoneCmyk` (`dotGain: 10, bvg: true, rosettePreset: 'image-aware'`): **`2.96 s`** (`PASS` across all 4 `verifyScreenInvariants` audits, `534.9 MB` RSS)
     - `computeHvsQuality` (`192 × 192` native-DPI live telemetry crop): **`20.84 ms`**
   - **`git status -uall` Hygiene:** Verified zero stray/temporary files and zero staged or committed changes.

[WAITING FOR REVIEWER]


---

## [Reviewer] — 2026-11-14 21:21

**Topic:** `Benday v0.2.0` Adversarial Commit-Gate Audit

**STATUS: CHANGES REQUESTED**

- **Core Math, CIELAB Sovereignty & Invariants (`PASS`):** Verified zero external dependencies and zero Node.js built-ins across `@electrosaur-labs/benday-core` (`BvgEdgeSnapper.js`, `HvsQuality.js`, `PressConfig.js`, `HalftoneEngine.js`, `RosetteAngles.js`, `PlateVerifier.js`). Confirmed canonical 16-bit Engine CIELAB (`0..32768`, `16384` neutral) and exact D50 reference white (`L*=100, a*=0, b*=0` on pure paper) with zero RGB distance math in `HvsQuality.js`, canvas-border-safe 3–4 Chamfer narrow Rich-Black UCR + `5×5` Otsu (`η >= 0.82`) hairline/counter guards in `BvgEdgeSnapper.js`, exact `0%`/`100%` fixed points on `dotGain`, Hold-to-Blink timer cleanup, 5-level `Escape` priority + `reopenModalWithoutReread`, deleted-layer XMP guard, and `assets/electrosaur.png` + inlined `<style>` packaging.
- **Blocking Defects Found (`3`):**
  1. **`[BLOCKING-1]` `image-aware` Rosette Crop Flipping & `bvg` Angle Drift (`BendayDialog.js:393-405, 1504-1511, 1605-1631, 1717-1721`, `BendayState.js:488-496`, `PhotoshopCmykBridge.js:1067-1070`, `HalftoneEngine.js:1865-1868`):** `halftoneCmyk` ignores `anglesOverride` when `rosettePreset === 'image-aware'`, causing zoomed viewport crops (`haloCh`), loupe tiles, HVS crops, and Fit supersampling to re-permute screen angles per local crop (flipping angles mid-pan and disagreeing with solo `C/M/Y/K` views and full-res production), while `BendayState._recompute` resolves `'image-aware'` on unconditioned `_rosetteChannels` even when `bvg: true`. Lock crop/proxy/commit `halftoneCmyk` calls to resolved `snap.angles` (preserving `rosettePreset` in `.psd` metadata) and condition `_rosetteChannels` under `bvg` in `BendayState`.
  2. **`[BLOCKING-2]` UXP CSS Column-Flex `gap` Violation (`packages/benday-ps/src/styles.css:47-55, 770-776`):** `#main-panel` (`gap: 6px`) and `.angle-cell` (`gap: 2px`) use `gap` on `flex-direction: column`. Replace with explicit child `margin-bottom` and rebuild `dist/` + `benday-v0.2.0.ccx`.
  3. **`[BLOCKING-3]` 1-Channel CLI `--bvg` Audit Uses Unconditioned `img.gray` (`packages/benday-cli/src/cli.js:460-510`):** Single-channel `benday halftone --bvg` passes raw `img.gray` instead of `snapChannelEdges`-conditioned grayscale to `verifyScreenInvariants` (`line 509`), causing BVG-snapped `255` narrow strokes to fail `minDotViolations`.
- **Polish (`1`):** Reword `"zinc plates"` -> `"engraver’s zinc"` in `packages/benday-ps/src/index.html:499` so `"plates"` appears zero times across all UI/docs prose.

[WAITING FOR DEVELOPER]

---

## [Developer] — 2026-11-14 21:31

**Topic:** `Benday v0.2.0` Post-Review Surgical Fixes (`[BLOCKING-1..3]` + Polish `#1` + 3 Regression Tests)

1. **`[BLOCKING-1]` Locked Global `image-aware` Angles Across All Crops/Previews, BVG State & Production Commit (`HalftoneEngine.js`, `BendayState.js`, `BendayDialog.js`, `PhotoshopCmykBridge.js`):**
   - Honored explicit non-null `config.anglesOverride` in `HalftoneEngine.js:1865` (`const hasExplicitOverride = config.anglesOverride != null;`) while preserving `resolveRosettePresetAngles` whenever `anglesOverride` is `null` / omitted.
   - Passed `rosettePreset: 'manual', anglesOverride: snap.anglesOverride || snap.angles` across all 4 preview/crop `halftoneCmyk` call sites in `BendayDialog.js` (`renderSupersampledProxyRgba`, `renderLoupeAtDocCoords`, `_renderZoomedViewport`, and `_updateHvsTelemetry`) so panned crops never re-permute angles locally and match solo `C/M/Y/K` views bit-for-bit.
   - Conditioned `_rosetteChannels` via `snapCmykEdges` (with `cellPitchPx` scaled proportionally by `_rosetteWidth / docWidth`) inside `BendayState._recompute` (and triggered `_recompute()` on `setBvg`) when `bvg && rosettePreset === 'image-aware'`; exported `{ rosettePreset, angles, anglesOverride }` cleanly in `exportEngineConfig()` and locked `commitHalftoneLayer` (`PhotoshopCmykBridge.js:1067`) to `stateConfig.anglesOverride || stateConfig.angles` while preserving `stateConfig.rosettePreset` (`'image-aware'`, `anglesOverride: null`) in `.psd` `generatorSettings` and `XMPMetadataAsUTF8`.
   - Added split-color (`top Cyan-dominant / bottom Magenta-dominant`) `200%` panned crop, solo `M` bit-parity, `bvg` angle-conditioning, and `.psd` XMP metadata regression test in `packages/benday-ps/test/BendayV02Ui.test.js`.

2. **`[BLOCKING-2]` Removed Remaining Column-Flex `gap` Rules in UXP CSS (`packages/benday-ps/src/styles.css`):**
   - Replaced `gap: 6px` on `#main-panel` with explicit `margin-bottom: 6px` on `#doc-header` and `#preview-stage`, and replaced `gap: 2px` on `.angle-cell` with `margin-bottom: 2px` on `.angle-cell label`.
   - Added automated CSS block parser regression test in `BendayV02Ui.test.js` asserting zero `flex-direction: column` blocks in `src/styles.css` contain `gap:`.

3. **`[BLOCKING-3]` 1-Channel Grayscale `benday halftone --bvg` Conditioned Invariant Audit (`packages/benday-cli/src/cli.js`):**
   - Pre-conditioned `conditionedGray` via `snapChannelEdges(img.gray, img.width, img.height, { cellPitchPx: meshSpec.cellPitchPx })` when `bvg: true`, passed `conditionedGray` (`bvg: false`) to `halftoneChannel`, and audited `verifyScreenInvariants` against `srcUint8: conditionedGray`.
   - Added 1-channel anti-aliased narrow `2 px` stroke `--bvg` regression test in `packages/benday-cli/test/cli.test.js` verifying `exitCode === 0` and `audit.ok === true` (`minDotViolations === 0`).

4. **Polish `#1` (`packages/benday-ps/src/index.html:499`):**
   - Replaced `"zinc plates"` with `"engraver’s zinc"` in `#manifesto-broadside` and guarded `index.html` with `expect(html).not.toMatch(/\bplates?\b/i)` in `BendayV02Ui.test.js`.

5. **Rebuild & Full Suite Verification:**
   - Rebuilt `packages/benday-ps/dist/` (including inlined `styles.css` in `dist/index.html`) and `packages/benday-ps/benday-v0.2.0.ccx` (`828.4 KB`).
   - Full workspace `npm test`: **`11/11` test files (`72/72` tests) passing `100%`** (`benday-core`: `37/37`, `benday-ps`: `27/27`, `benday-cli`: `8/8`), with `git status -uall` 100% clean.

[WAITING FOR REVIEWER]


---

## [Reviewer] — 2026-11-14 21:33

**Topic:** `Benday v0.2.0` Final Adversarial Commit-Gate Re-Audit

**STATUS: APPROVED FOR COMMIT**

- **`[BLOCKING-1]` Verified (`HalftoneEngine.js:1865`, `BendayState.js:177-199, 394-401, 478-493`, `BendayDialog.js:400-401, 1506-1507, 1610-1611, 1722-1723, 1773`, `PhotoshopCmykBridge.js:1067-1072, 1228-1230`):** Explicit `anglesOverride` is honored across `halftoneCmyk`, all cropped/proxy previews lock to document-level `snap.angles`, `BendayState` conditions `_rosetteChannels` via `snapCmykEdges` when `bvg && rosettePreset === 'image-aware'`, and `commitHalftoneLayer` locks production screens to `stateConfig.angles` while preserving `rosettePreset: 'image-aware'` (`anglesOverride: null`) in `.psd` `generatorSettings` and `XMPMetadataAsUTF8`. Verified split-color `200%` panned crop (`0` pixel mismatches vs. solo `M`), `bvg` angle conditioning, and XMP metadata regression test (`BendayV02Ui.test.js:417-582`).
- **`[BLOCKING-2]` Verified (`packages/benday-ps/src/styles.css:47-67, 218-224, 771-786`, `dist/index.html`):** Zero `flex-direction: column` blocks contain `gap:` in `src/styles.css` or inlined `dist/index.html`, guarded by automated CSS block regression test (`BendayV02Ui.test.js:584-594`).
- **`[BLOCKING-3]` Verified (`packages/benday-cli/src/cli.js:11, 461-471, 513`, `test/cli.test.js:557-605`):** Single-channel `benday halftone --bvg` conditions `conditionedGray` via `snapChannelEdges` and audits `verifyScreenInvariants` against `srcUint8: conditionedGray`, passing narrow `2 px` BVG-snapped stroke invariants with `0` violations.
- **Polish `#1`, Packaging & Stray-File Hygiene Verified:** `"engraver’s zinc"` verified in `src/index.html` and `dist/index.html` (`0` occurrences of `"plates"` across all UI/docs prose), `dist/` and `benday-v0.2.0.ccx` rebuilt cleanly, `11/11` test files (`72/72` tests) passing `100%`, and zero stray files in `git status -uall`.

[WAITING FOR PRINCIPAL]


---

## [Developer] — 2026-11-15 03:31

**Topic:** `Benday v0.2.0` Suite Synergy & Pass 3 Polish Ready for Final Commit-Gate Audit

1. **Suite Synergy & SAATI Mesh Alignment (`benday-core`, `benday-cli`, `benday-ps`, `docs/`):**
   - Expanded `SAATI_MESH_PRESETS` (`MeshPhysics.js`) to 20 official SAATI polyester rolls (`110-80` through `420-27`, including standard & `Hi-R` thin-thread options) with `355-31` (`32%` open area) as the suite-wide default mesh across `benday-core`, `benday-cli`, and `benday-ps`.
   - Added `docs/SUITE-SYNERGY.md` documenting shared Electrosaur physics, explicit RGB/CMYK/Lab document-mode gates, and Reveal <-> Benday workflow synergy.
   - Polished UI header, `Manifesto` modal, `★ Credits ★` crawl (`electrosaur.png` emblem, `Anton-Regular`), and screen-mesh vocabulary (`"screens"`, zero `"plates"` prose).

2. **Pass 3 Polish (`benday-core`, `benday-cli`, `benday-ps`):**
   - **Default `Crisp Type & Linework (BVG)` to `true`:** Defaulted `bvg = true` across `PressConfig.js` (preserving `false` when migrating legacy `0.1.*` configs), `HalftoneEngine.js`, `cli.js` (`--no-bvg` disables; `benday verify --src` conditions source channels via `snapCmykEdges` / `snapChannelEdges` when `bvg === true`), `BendayState.js` (`DEFAULT_BVG = true`), `index.html`, `BendayDialog.js` (`#btn-bvg-revert` visible when unchecked, resets to `true`), and package `README.md`s.
   - **Refuse Active Selections (`ERR_ACTIVE_SELECTION`):** `PhotoshopCmykBridge.js` (`hasActiveSelectionDom`, `queryHasActiveSelection`, `validateDocument`) and `index.js` (`showDialog`) refuse launch when an active Photoshop selection is present (`Deselect (Cmd/Ctrl+D) before running Benday`).
   - **Single-`Esc` Dismiss:** Restricted `BendayDialog.dismissTopTransientLayer()` and `index.js` `cancel` handler strictly to modal overlays (`#confirm-overlay`, `Manifesto`, `Credits`), ensuring 1 `Esc` always dismisses Benday immediately even in `Original` or solo `C/M/Y/K` preview modes.

3. **Verification & Packaging:**
   - Full workspace `npm test`: **`12/12` test files (`79/79` tests) passing `100%`** (`benday-core`: `37/37`, `benday-ps`: `34/34`, `benday-cli`: `8/8`).
   - Rebuilt `packages/benday-ps/dist/` and `packages/benday-ps/benday-v0.2.0.ccx`.
   - Verified `git -C benday status --short`: zero stray or temporary files.

[WAITING FOR REVIEWER]


---

## [Reviewer] — 2026-11-15 03:40

**Topic:** Final Pass 3 Commit-Gate Audit (`v0.2.0` + Suite Synergy Polish)

### Audit Scope & Verification
1. **Zero-Dependency Core & Canonical 16-bit CIELAB Sovereignty (`GEMINI.md §1`):**
   - Verified `@electrosaur-labs/benday-core` (`package.json`, `lib/*.js`) has **zero** external runtime dependencies and **zero** Node.js built-ins.
   - Verified `HvsQuality.js` computes SWOP Coated 8-primary Neugebauer reflectance in linear D50 XYZ (`96.422 / 100.000 / 82.521`), applies identical separable 2D Gaussian HVS optical blur, converts into canonical 16-bit Engine CIELAB (`0..32768`, `16384` neutral), and executes all color-difference math in 16-bit Engine CIELAB (`origLab16` vs `scrLab16`) before scaling to perceptual ΔE76 strictly at the telemetry output boundary. Zero RGB distance math.
2. **SAATI `355-31` Studio Default & `bvg = true` Default Across Stack:**
   - `MeshPhysics.js`, `PressConfig.js`, `HalftoneEngine.js`, `cli.js`, `BendayState.js`, `index.html`, and `BendayDialog.js` cleanly align on `355 TPI / 31 µm` (`355-31 Hi-R`) and `bvg = true` by default.
   - `PressConfig.js` preserves `bvg: false` when migrating legacy `0.1.*` schemas without explicit `bvg`, `cli.js` supports `--no-bvg` and conditions `--src` channels (both 4-channel CMYK and 1-channel grayscale) in `benday verify`, and `#btn-bvg-revert` appears when unchecked and restores `true`.
3. **Active Selection Gate, Overwrite Confirm Guard & Single-`Esc` Dismiss:**
   - `PhotoshopCmykBridge.js` (`hasActiveSelectionDom`, `queryHasActiveSelection`, `validateDocument`) and `packages/benday-ps/src/index.js` (`showDialog`) reject active pixel selections (`ERR_ACTIVE_SELECTION`) across both DOM and ActionManager paths.
   - `handleSaveConfig` prompts `#confirm-overlay` (`Overwrite File?`) before overwriting non-empty `-benday.json` files.
   - `BendayDialog.dismissTopTransientLayer()` and `dlg.addEventListener('cancel', ...)` intercept `Escape` strictly for modal overlays (`#confirm-overlay` → `Manifesto` → `Credits`), never trapping `Escape` on `Original` or solo `C/M/Y/K` views.
4. **House Style, UXP Torq CSS Invariants & Zero-Tolerance Stray File Hygiene:**
   - Verified zero `"plates"` prose across UI and docs (`"screens"` / `"engraver's zinc"`), zero column-flex `gap:` rules across `styles.css` and `dist/index.html`, and zero stray or temporary files in the repository.

**STATUS: APPROVED FOR COMMIT**

[WAITING FOR PRINCIPAL]

# `@electrosaur-labs/benday-cli`

Headless CMYK and single-channel halftone runner, mesh/moire calculator, synthetic test-chart generator, and physical screen invariant verifier.

Built on `@electrosaur-labs/benday-core` with a zero-dependency Baseline Uncompressed TIFF and binary PGM (`P5`) codec (`src/tiffCodec.js`).

## Usage

From the `benday/` monorepo root:

```bash
npm run benday -- <subcommand> [options]
```

Or invoke the binary directly:

```bash
node packages/benday-cli/bin/benday.js <subcommand> [options]
```

---

## Subcommands

### 1. `benday halftone`

Halftones a 4-channel Separated CMYK TIFF, a 1-channel Grayscale TIFF/PGM, or a built-in `synthetic:*` test chart into binary `{0, 255}` halftone screen output, and audits every generated screen via `verifyPlateInvariants`.

```bash
# 4-channel CMYK uncompressed TIFF -> 4-channel CMYK halftone TIFF
benday halftone input-cmyk.tif -o output-cmyk.tif --mesh 230 --n 5.0

# Also write individual _C.tif, _M.tif, _Y.tif, _K.tif single-screen TIFFs
benday halftone input-cmyk.tif -o output-cmyk.tif --mesh 305 --n 5.0 --split-screens ./screens

# 1-channel Grayscale TIFF or PGM at a custom screen angle
benday halftone keyline-gray.pgm -o keyline-screen.pgm --mesh 230 --dpi 600 --angle 45 --tail hybrid

# Emit full JSON report (active LPI, D_min, rosette angles, moire warnings, per-screen audits)
benday halftone synthetic:ramp -o ramp.tif --mesh 230 --dpi 600 --json
```

### 2. `benday verify`

Independently audits an existing 1-channel or 4-channel halftone file against physical mesh invariants (`computeMeshSpec` + `verifyPlateInvariants`).

- **Exit code `0` (`PASS`):** Every pixel is strictly `{0, 255}`, all positive halftone dots and enclosed shadow holes satisfy canonical $B_{D_{\min}}$ morphological openness (`minDotViolations === 0` and `minHoleViolations === 0`), and — when `--src` is supplied — all `100%` solid pixels (`255`) are preserved and `0%` paper regions have zero stray bleed.
- **Exit code `1` (`FAIL`):** Any physical invariant violation or invalid geometry/file error.

```bash
# Verify screen geometry & binary purity against 230 TPI / N=5.0
benday verify output-cmyk.tif --mesh 230 --n 5.0

# Full audit including 100% solid preservation & 0% paper sovereignty against original source
benday verify output-cmyk.tif --src input-cmyk.tif --mesh 230 --n 5.0 --json
```

### 3. `benday spec`

Prints physical mesh aperture calculations (`computeMeshSpec`), bias-compensated CMYK rosette angles (`computeRosetteAngles`), and 2D harmonic moiré clearance (`analyzeMoire`) without reading or writing image files.

```bash
# Human-readable shop summary
benday spec --mesh 355 --thread 34 --n 5.0 --dpi 600 --mesh-angle 7.5

# Structured JSON output
benday spec --mesh 230 --dpi 600 --json
```

Example output:

```text
Mesh: 230 TPI / 48 µm (open area 32.0%, scale 1.00x)
Min Dot: 5 px (215.9 µm, area 21 px²) @ 600 DPI
LPI: 46.00 active (natural 46.00, max 78.60)
Rosette: C=15° M=75° Y=60° K=45° (min clearance 13.0°, safe=true)
```

---

## Options Reference

| Flag | Default | Description |
|---|---|---|
| `-o <file>`, `--output <file>` | *(2nd positional arg)* | Output `.tif` or `.pgm` path for `benday halftone` |
| `--mesh <tpi>` | `230` | Screen mesh count in threads per inch |
| `--thread <um>` | *catalog auto* | Monofilament thread diameter in micrometers (`µm`) |
| `--n <num>` | `5.0` | Rule of N threads per halftone cell in `[2.0, 10.0]` |
| `--dpi <ppi>` | *TIFF tag or `600`* | Document resolution in pixels per inch |
| `--lpi <lpi>` | *auto (`lpiNatural`)* | Optional manual halftone screen ruling override (`<= lpiMax`) |
| `--mesh-angle <deg>` | `0` | Mesh stretch bias angle `θ` in degrees (modulo `90°`) |
| `--angle <deg>` | `45` | Screen angle override in degrees for 1-channel `halftone` inputs |
| `--tail <mode>` | `hybrid` | Highlight/shadow tail mode: `hybrid` \| `cutoff` \| `clamp` |
| `--split-screens <dir>` | *(off)* | Write `<stem>_C.tif`, `<stem>_M.tif`, `<stem>_Y.tif`, `<stem>_K.tif` to `<dir>` during 4-channel `halftone` |
| `--src <file>` | *(optional)* | Original continuous-tone file (or `synthetic:*`) for solid & paper checks in `benday verify` |
| `--width <px>` | `200` | Width in pixels when reading a `synthetic:*` input |
| `--height <px>` | `160` | Height in pixels when reading a `synthetic:*` input |
| `--json` | `false` | Emit structured JSON output to stdout |
| `-h`, `--help` | — | Print usage summary and exit `0` |

---

## Synthetic Test Inputs

Anywhere `<input>` or `--src` is accepted, you can pass one of three deterministic `600 DPI` 4-channel CMYK test patterns (default `200 × 160 px`, configurable via `--width` and `--height`):

| Specifier | Contents | Purpose |
|---|---|---|
| `synthetic:ramp` | Smooth `C`, `M`, `Y`, `K` continuous ramps (`0..254`), a `12 px` pure `0%` paper left margin, and a 1-pixel `100%` solid `K = 255` horizontal hairline at `y = floor(height / 2)` | End-to-end test of highlight/shadow tails, `0%` paper margin lock, and 1-pixel solid sovereignty adjacent to halftones |
| `synthetic:step` | Midtone/shadow/highlight step patches (`C`, `M`, `Y`), `12 px` `0%` paper margin, and 1-pixel `K = 255` solid rules along right/bottom edges | Step-edge corner-bridge stability and tonal patch verification |
| `synthetic:crosshair` | Pure `{0, 255}` binary 1-pixel `K = 255` crosshair on `0%` paper (`C = M = Y = 0`) | Verifies bit-for-bit 1-pixel graphic linework fast-path with zero halftone alteration |

Example with custom print dimensions:

```bash
benday halftone synthetic:ramp -o test-ramp.tif --width 1200 --height 900 --dpi 600 --mesh 305
benday verify test-ramp.tif --src synthetic:ramp --width 1200 --height 900 --dpi 600 --mesh 305
```

---

## Supported File Formats & Polarity

`benday-cli` includes a built-in zero-external-dependency codec (`src/tiffCodec.js`) supporting 8/16-bit isotropic and anisotropic TIFFs plus binary PGM (`P5`) without native C++ addons:

1. **4-Channel Separated CMYK TIFF (`.tif`, `.tiff`):**
   - Uncompressed (`Compression = 1` on read/write) or Deflate (`Compression = 8` / `32946` on read, with `Predictor = 1` or `2`), `8` or `16` bits per sample (16-bit scaled cleanly on read), chunky (`PlanarConfiguration = 1`) or planar (`PlanarConfiguration = 2`), stripped or tiled (`TileWidth` / `TileLength`), `PhotometricInterpretation = 5` (`Separated`), `SamplesPerPixel >= 4` (extra spot/alpha channels beyond `C, M, Y, K` are safely ignored on read), `InkSet = 1`.
   - Reads both Little-Endian (`II`) and Big-Endian (`MM`) TIFFs; writes Little-Endian Baseline TIFFs with independent `XResolution` (`dpiX`) and `YResolution` (`dpiY`) DPI tags (`ResolutionUnit = 2` inch; converts `cm` tags on read) so anisotropic resolutions round-trip losslessly unless overridden with `--dpi`.
   - Uses standard TIFF CMYK ink polarity (`0` = `0%` ink, `255` = `100%` ink) and opens directly in Adobe Photoshop.
2. **1-Channel Grayscale TIFF (`.tif`, `.tiff`):**
   - Uncompressed or Deflate `8/16`-bit `SamplesPerPixel = 1` (stripped or tiled) with isotropic or anisotropic `XResolution` / `YResolution` DPI tags.
   - Writes standard `PhotometricInterpretation = 1` (`BlackIsZero`) bytes (`0` = black `100%` ink, `255` = white `0%` paper) so single-screen files (including `--split-screens` outputs) display directly as black-on-white film positives in Adobe Photoshop, macOS Preview, and `libtiff` while round-tripping losslessly into `benday verify`. Also decodes `PhotometricInterpretation = 0` (`WhiteIsZero`) Grayscale TIFFs with proper ink polarity.
3. **Binary PGM (`.pgm`, magic `P5`):**
   - Single-channel 8-bit (`maxval = 255`) raw ink buffer (`0` = `0%` paper, `255` = `100%` ink). Defaults to `600 DPI` unless `--dpi` is provided.

> **Compressed TIFFs:** Uncompressed (`Compression=1`) and ZIP/Deflate (`Compression=8` or `32946`) TIFFs are supported on read; LZW or PackBits TIFFs should be saved from Photoshop with **Image Compression: None** or **ZIP**.

---

## Programmatic Node.js API

```js
const { runCli } = require('@electrosaur-labs/benday-cli');

const lines = [];
const { exitCode, result } = runCli(
  ['spec', '--mesh', '230', '--dpi', '600', '--json'],
  { stdout: (msg) => lines.push(msg), stderr: console.error }
);
```

## License

Apache-2.0 — see root [LICENSE](../../LICENSE).

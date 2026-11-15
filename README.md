# Benday

**Mesh-aware CMYK halftone engine, Photoshop UXP plugin, and CLI for screen printing**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Benday enhances Adobe Photoshop for 4-color process (CMYK) and single-channel halftone screen printing.

Photoshop already provides reliable CMYK color management (`Edit → Convert to Profile...`), curve adjustments, black generation, and retouching tools. What Photoshop does not know about is the physical screen on your press: mesh count (threads per inch), monofilament thread diameter (micrometers), open-area percentage, or the bias angle at which your mesh is stretched on the frame. Because of that physical gap, generic digital halftones routinely produce 1-pixel highlight specks that wash off the stencil in the washout booth, 1-pixel shadow pinholes that bridge shut with emulsion or ink on press, and screen angles that beat against woven polyester threads to form visible moiré patterns.

Traditionally, screen printers bridged this gap by exporting files out of Photoshop into a separate printer-locked RIP. Benday brings physical mesh-aperture geometry and stretch-angle moiré analysis directly into Photoshop (and headless command-line pipelines), generating binary `{0, 255}` CMYK halftone screens whose dots and shadow holes are guaranteed to hold on your chosen mesh.

**Why Benday exists alongside Reveal:** Spot color (**Reveal**) is the heart of the Electrosaur aesthetic — choosing 6 or 8 intentional flat inks and standing by them. **Benday** serves two practical shop needs alongside it:
1. **Speed & 4-Screen Economy:** When you need to go from image to print fast without custom ink mixing, CMYK gets you onto paper with just **4 screens** and standard process inks off the shelf.
2. **An Honest Comparison Baseline:** To compare a 4-screen CMYK process print fairly against a **Reveal** spot separation, the CMYK screens have to be shot for the exact same mesh (`TPI / µm`), minimum stencil dot (`Rule of N`), and zero mesh moiré — rather than crippled by generic digital halftones that wash out in highlights and plug in shadows.

## Key Capabilities

- **Open-Area-Compensated Mesh Physics & Official SAATI Catalog** — Computes natural halftone ruling (`LPI`) and minimum printable dot / shadow-hole diameter from mesh count (`TPI`), thread diameter (`µm`), and press-room **Rule of N** (`2.0–10.0` threads per halftone cell, default `5.0`), anchored to a `230 TPI / 48 µm` (`32.0%` open area) reference and floored by open-area-scaled thread-knuckle span. Ships with a 20-roll **`SAATI_MESH_PRESETS`** catalog (`110-80` through `420-27`, including standard and `Hi-R` high-open-area thin-thread rolls) plus custom `(TPI / µm)` overrides.
- **Bias-Tolerant CMYK Rosette & 2D Harmonic Moiré Guard** — Centers your mesh stretch bias angle `θ` inside the `30°` gap of the CMYK rosette (`C = θ + 15°`, `K = θ + 45°`, `Y = θ + 60°`, `M = θ + 75°` mod `90°`), maintaining `>= 15.0°` nominal clearance and `>= 13.0°` clearance across `±2.0°` of stretcher slop. Evaluates 2D reciprocal-lattice harmonics (`|j|, |k| <= 8` against mesh harmonics `|m1|, |m2| <= 4`) weighted by square-aperture `sinc` and circular-dot Airy (`2·J₁(x)/x`) contrast to flag subtle harmonic beats before you burn a screen.
- **Symmetric Euclidean Screen with Calibrated Tonal Linearity & Exact Morphological Openness** — Generates round-to-checkerboard-to-inverse-round Euclidean screens with empirical discrete tone calibration (eliminating `51%–60%` corner-cusp bridging spikes and inter-angle dot-pitch drift) where every halftone dot and every enclosed halftone shadow hole is an exact union of canonical discrete disks $B_{D_{\min}}$ (`0` 1-pixel diamond tips, `0` clipped edge shards, `0` sub-mesh pinholes).
- **Three Highlight / Shadow Tail Modes** — Choose **Hybrid AM/FM** (default serpentine Floyd-Steinberg error diffusion over canonical minimum-size dots and shadow holes in tones finer than the AM floor), **Cutoff** (clean drop to `0%` / solid `100%`), or **Clamp** (hold minimum dot / hole across active tails).
- **Press Dot Gain Compensation (`0%–20%`)** — Single-slider parabolic midtone pullback ($t_{\text{film}} = t - 4 \Delta G \, t(1 - t)$) compensating for extra screen-printing mechanical/optical dot gain without washing out the continuous-tone `Original` artwork on screen, while keeping `0%` clear substrate and `100%` solid ink as exact mathematical fixed points.
- **Crisp Type & Linework (`BVG`) & 100% Solid / 0% Paper Guarantees** — Channel pixels at `100%` ink (`255`) pass straight through at native 1-pixel resolution, pure `{0, 255}` graphic counters stay open, and `0%` paper margins remain free of stray dots. Optional **Bimodal Variance-Gated (`BVG`)** pre-conditioning (`5 × 5` Otsu separability $\eta \ge 0.82$) snaps anti-aliased vector/type rims cleanly and promotes narrow ICC Rich-Black body type (`< 2 × cellPitchPx`) to crisp solo `K = 255` (`C = M = Y = 0`) while leaving photographic gradients, skin tones, film grain, and wide Rich-Black fills completely untouched.
- **Rosette Angle Presets & `< 2 ms` Image-Aware Slot Assignment** — Built-in presets (`Auto`, `Image-Aware`, `FTA +7.5°`, `ISO Litho`, `Flamenco 45°`, and `Manual…`), including `< 2 ms` Campbell–Kulikowski oblique-effect (`45°`) and 2-ink co-occurrence channel-slot assignment across `{θ+15°, θ+45°, θ+60°, θ+75°}`.
- **Save / Load `-benday.json` Press Configs & `.psd` Metadata Manifests** — Portable shop preset files (`Save Config` / `Load Config` in Photoshop defaulting to `<FILENAME>-benday.json` and `--config` / `--save-config` in the CLI) plus automatic per-layer and document XMP manifest embedding on commit (used to guard against re-halftoning flattened Benday output).
- **16-bit CIELAB Perceptual `HVS ΔE` Telemetry & Non-Destructive Photoshop UXP Dialog** — Resizable `1100 × 850` two-column workspace with `Fit / 50% / 100% / 200%` scrollable viewport virtualization, calibrated SWOP Coated overprint proofing, live **HVS Viewing-Distance `ΔE`** (evaluated in canonical 16-bit CIELAB) and **Gray Steps/Cell** readouts, `< 2 ms` click-to-toggle **and** press-and-hold (`400 ms` blink) `ORIGINAL` comparator, bottom **Screen Strip** (`Composite + C/M/Y/K` film-positive solo swatches), theatrical **`★ Credits ★`** crawl dedicated to **Benjamin Henry Day Jr. (1879)**, single-undo top CMYK layer output, and automatic re-run detection.
- **Zero-Dependency Core** — `@electrosaur-labs/benday-core` is 100% pure JavaScript with zero external dependencies and zero Node.js built-ins.

## Why No Multi-Point Tone Curves Inside Benday?

Benday is deliberately a **focused, mesh-aware halftoner**, not a replacement color editor. Photoshop already provides industry-standard, non-destructive **Curves** adjustment layers, per-channel CMYK tone controls, GCR/UCR black generation, and ICC press profiles (`Edit → Convert to Profile...`). Rather than duplicating multi-point curve editors inside a modal dialog, Benday provides a single physical **Extra Press Dot Gain (`0%–20%`)** midtone pullback right before screen generation — so you can compensate for the extra `+10%–15%` mechanical dot gain of `45–65 LPI` screen printing while keeping your `Original` continuous-tone artwork true and un-washed-out on screen.

## Packages & Architecture

```
@electrosaur-labs/benday-core        Pure JS math & screen engine (zero dependencies, no I/O)
     │
     ├── @electrosaur-labs/benday-ps   Photoshop UXP v5 command plugin (Photoshop 23.3.0+)
     └── @electrosaur-labs/benday-cli  Headless CLI, TIFF/PGM codec, and invariant verifier
```

| Package | Path | Description |
|---|---|---|
| **[@electrosaur-labs/benday-core](packages/benday-core/README.md)** | `packages/benday-core/` | Zero-dependency mesh physics, bias-tolerant rosette & 2D harmonic moiré analyzer, Euclidean halftone engine, and screen invariant verifier. |
| **[@electrosaur-labs/benday-ps](packages/benday-ps/README.md)** | `packages/benday-ps/` | Photoshop UXP v5 modal plugin (`Plugins → Electrosaur: Benday → Benday...`) with 1:1 preview and non-destructive CMYK layer commit. |
| **[@electrosaur-labs/benday-cli](packages/benday-cli/README.md)** | `packages/benday-cli/` | Command-line tool (`benday halftone`, `benday verify`, `benday spec`) with zero-dependency uncompressed Baseline TIFF and PGM (`P5`) support. |

## Quickstart

### Photoshop UXP Plugin

1. Build or download `benday-v0.2.0.ccx` (see [packages/benday-ps/README.md](packages/benday-ps/README.md) for `.ccx` packaging and Adobe UXP Developer Tool setup).
2. Double-click `benday-v0.2.0.ccx` to install via Creative Cloud Desktop.
3. In Photoshop (`23.3.0` or later), convert your single-layer flattened artwork to your shop CMYK profile via **Edit → Convert to Profile...** (at `300–600+ DPI`).
4. Run **Plugins → Electrosaur: Benday → Benday...**, select your SAATI `(TPI - µm)` mesh preset, Rule of N, optional **Dot Gain (`%`)**, **Crisp Type & Linework (`BVG`)**, or **Rosette Preset**, inspect the `Fit / 50% / 100% / 200%` preview (click to toggle or press-and-hold to blink `ORIGINAL`), and click **Apply Halftone**.

For a complete press-oriented walkthrough, read the **[Benday User Guide](docs/USER-GUIDE.md)**. For post-v0.2 roadmap designs (`FftMoireAnalyzer`, external separation preflight X-Ray, Rich Black choke/TAC, anisotropic film-positive spooling via `Hokusai`, and `Reveal` spot-color halftoning), see **[Roadmap & Futures](docs/FUTURES.md)**.

### Command-Line Interface (CLI)

```bash
git clone https://github.com/electrosaur-labs/benday.git
cd benday
npm install

# Inspect mesh aperture physics, auto LPI, gray steps/cell, and rosette clearance for 230 TPI @ 600 DPI
npm run benday -- spec --mesh 230 --dpi 600

# Halftone a 4-channel CMYK TIFF with 10% dot-gain pullback, BVG crisp type, and Image-Aware rosette
npm run benday -- halftone input-cmyk.tif -o output-cmyk.tif --mesh 230 --n 5.0 --dot-gain 10 --bvg --rosette-preset image-aware --split-screens ./screens

# Save a reusable shop press preset (-benday.json) and run with --config
npm run benday -- halftone synthetic:ramp -o ramp.tif --mesh 305 --dpi 600 --save-config shop-305-benday.json
npm run benday -- verify ramp.tif --src synthetic:ramp --mesh 305 --dpi 600
```

See [packages/benday-cli/README.md](packages/benday-cli/README.md) for all subcommands, flags, synthetic test charts, and TIFF/PGM details.

## Verification & Benchmarks

Benday is verified against an automated 720-screen adversarial matrix (`5 Meshes × 3 Rule-of-N settings × 2 DPIs × 2 Mesh Bias Angles × 3 Tail Modes × 4 Rosette Screens`) covering continuous ramps, sub-threshold highlight/shadow tails, `0%` paper margins, and 1-pixel `100%` solid hairlines and graphic counters:

- **Binary purity (`{0, 255}`):** 100% pass across all 720 screens
- **Minimum positive dot diameter ($B_{D_{\min}}$):** `0` violations
- **Minimum enclosed shadow-hole diameter ($B_{D_{\min}}$):** `0` violations
- **100% solid linework preservation:** `0` violations
- **0% paper bleed:** `0` violations

Measured performance on Apple Silicon macOS (Node.js v25.9.0, single-threaded pure JavaScript):

| Workload | Dimensions | Channel Pixels | Latency | Peak RSS | Invariant Audit |
|---|---|---:|---:|---:|---|
| `analyzeMoire` (4 screens × `±2°` slop) | Reciprocal lattice | — | `0.63 ms` | — | — |
| Live UXP Preview Crop (4 CMYK screens) | `320 × 320` | `0.41 MP` | `83.7 ms` (`20.9 ms`/screen) | `85.2 MB` | `PASS (0 / 0)` |
| `8" × 10"` @ `300 DPI` (4 CMYK screens, `230 TPI`) | `2400 × 3000` | `28.80 MP` | `3.43 s` (`0.86 s`/screen) | `314.4 MB` | `PASS (0 / 0)` |
| `6" × 8"` @ `600 DPI` / `12" × 16"` @ `300 DPI` (`305 TPI`) | `3600 × 4800` | `69.12 MP` | `11.66 s` (`2.91 s`/screen) | `726.9 MB` | `PASS (0 / 0)` |

## Roadmap & Post-v0.2 Specifications

Benday **v0.2** ships press dot-gain pullback (`dotGain`), Bimodal Variance-Gated (`BVG`) text/linework snapping & narrow Rich-Black UCR (`BvgEdgeSnapper.js`), Rosette Angle Presets + `< 2 ms` image-aware slot assignment (`RosetteAngles.js`), portable `-benday.json` + `.psd` XMP press configs (`PressConfig.js`), hold-to-blink `Original` comparison, 16-bit CIELAB perceptual `HVS ΔE` & gray-step telemetry (`HvsQuality.js`), and the **`★ Credits ★`** crawl dedicated to **Benjamin Henry Day Jr. (1879)**. Planned for **v0.3+** are:

- `512 × 512` Radix-2 2D FFT spatial moiré analysis and `< 300 ms` automatic screen/rosette angle solvers (`FftMoireAnalyzer.js`)
- Standalone highlight-washout & shadow-bridge preflight X-Ray and `< 50 ms` healer for external separations (`meshPreflight.js`)
- Rich Black synthesis with automatic `1–3 px` C/M/Y underbedding choke and wet-on-wet TAC mud control
- Direct inkjet 1-bit film-positive export (`720 × 1440` / `1440 × 2880` DPI, registration targets, screen slugs, exposure wedges, and UV-blocking multi-channel ink mixing for printers such as the Epson Stylus Pro 3880)
- `Reveal` spot-color and white underbase halftoning integration (**v0.3**)

See **[docs/FUTURES.md](docs/FUTURES.md)** for full post-v0.2 technical specifications, **[docs/SUITE-SYNERGY.md](docs/SUITE-SYNERGY.md)** for the bidirectional `Benday ↔ Reveal` cross-pollination roadmap, and **[docs/HOKUSAI.md](docs/HOKUSAI.md)** for **Hokusai** *(dedicated to William Henry Fox Talbot)* — the planned direct inkjet film-positive spooler ("RIP Killer").

## Development

```bash
# Run all workspace unit, DOM, and adversarial invariant tests (Vitest)
npm test

# Run tests for individual packages
npm run test:core
npm run test:ps
npm run test:cli

# Build Photoshop UXP bundle into packages/benday-ps/dist/
npm run build:ps

# Build and package benday-v0.2.0.ccx
npm run package:ps
```

## Credits

Dedicated to **Benjamin Henry Day Jr. (1838–1916)**, inventor of the 1879 Ben Day Rapid Shading Medium. Conceived and directed by Shankar R., a screen printer. Architecture, design, and code by Gemini. Uses no AI at runtime.

## License

Copyright 2026 Electrosaur Labs. Licensed under the [Apache License 2.0](LICENSE).

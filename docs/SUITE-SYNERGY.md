# Electrosaur Suite Synergy Roadmap (`Benday ↔ Reveal`)

Within the **Electrosaur** screen-printing suite, **Reveal** and **Benday** represent the two complementary pillars of physical printmaking:

- **Reveal (`@electrosaur-labs/core`, `reveal-navigator`, `pyreveal`, `libreveal`, `krita-reveal`):** Perceptual 16-bit CIELAB spot-color reduction (`3–12` inks) for artists and poster makers who want graphic interpretation without CMYK process halftones.
- **Benday (`@electrosaur-labs/benday-core`, `benday-ps`, `benday-cli`):** Mesh-aperture-governed continuous-tone CMYK process and single-channel halftone screen generation (`{0, 255}`) with bias-tolerant rosette geometry and harmonic moiré protection.

Because both tools share the same press room — the same SAATI polyester rolls, pneumatic stretchers, exposure units, washout booths, Adobe Photoshop UXP host runtime, and inkjet film-positive printers — engineering advances in either project feed directly into the other. This document tracks **both** cross-pollination loops so nothing discovered during `Benday v0.1` or `Reveal v1.0` is lost.

---

## 1. Suite-Wide Vocabulary & Mesh Physics Unification (Critical Priority)

Comparing `Reveal`'s `packages/reveal-core/lib/utils/MeshPhysics.js` (`42` lines) against `Benday`'s `packages/benday-core/lib/MeshPhysics.js` exposes a subtle **vocabulary and physics mismatch** that will confuse shops running both plugins unless unified:

| Concept | Current `Reveal` (`v1.0`) | Current `Benday` (`v0.1`) | Unified Electrosaur Target |
|---|---|---|---|
| **Mesh Selection** | Bare `TPI` (`default: 355`), ignores thread diameter & open area (`355-40`, `355-34`, and `355-31 Hi-R` treated identically) | Paired 20-roll **`SAATI_MESH_PRESETS`** (`110-80` through `420-27`, standard + `Hi-R` thin-thread) + custom `(TPI / µm)` | Shared **`SAATI_MESH_PRESETS`** (`TPI - µm` + open-area `%`) across both `Reveal` and `Benday` |
| **Open-Area Scaling** | None (`1.0×` implicit) | $\sqrt{f_{\text{ref}} / f_{\text{open}}}$ anchored to `230-48` (`32.0%` open area) + open-area-scaled knuckle span $(p_m + d_t)\sqrt{f_{\text{ref}} / f_{\text{open}}}$ | Back-port open-area & knuckle-floor compensation into `reveal-core`, `pyreveal`, and `libreveal` |
| **Meaning of `Rule of N`** | *Minimum dot diameter* in mesh pitches: `minDotPx = ceil(N * dpi / tpi)` (`default: 7.0`, range `4–10`) | Press-room *mesh threads per halftone cell*: `LPI = TPI / (N * openAreaScale)` (`default: 5.0`, range `2–10`), with `dMin` derived from knuckle span + `12%` reference cell dot | Clarify UI labels explicitly: **Cell Ratio (`N` threads/cell)** for periodic halftones vs. **Stencil Floor (`D_min` in µm / px / openings)** for aperiodic spot-color islands |

---

## 2. Loop A: `Reveal → Benday` (Bringing `Reveal`'s Best Ideas into `Benday v0.2`)

### Already Harvested in `Benday v0.1`
1. **Zero-Dependency Core + Host Adapter Split:** `@electrosaur-labs/benday-core` mirrors `@electrosaur-labs/core` (`0` runtime dependencies, `0` Node.js built-ins).
2. **Photoshop UXP Runtime Survival Patterns:** Pure-`batchPlay` document lifecycle with integer `docId` tracking, `<img src="data:image/png;base64,...">` rendering instead of broken UXP `<canvas>` `putImageData`, explicit `style.display` toggling for UXP Torq layout, inlined `<style>` in `dist/index.html` so UXP Developer Tool Reload never serves stale cached stylesheets, single-undo `suspendHistory` hiding underlying source layers, and the stacked right-panel action header.
3. **Offline Pre-Flight CLI Auditor:** `benday verify` (`PlateVerifier.js`) mirrors `reveal verify`.

### Planned `Reveal → Benday` Transfers (`v0.2`)
1. **Hold-to-Blink Comparator (`> 300 ms` Hold → `400 ms` Auto-Blink):**
   - In `Reveal` (`Preview.js`), a quick click toggles `ORIGINAL`, while holding pointerdown `> 300 ms` enters an automatic `400 ms` blink loop (`Original ↔ Separated`) that makes subtle highlight drop-out or shadow plugging jump out instantly without moving the cursor. Port directly into `BendayDialog.js`.
2. **Save / Load Press Config (`.benday.json`) & Embedded `.psd` Metadata Manifest:**
   - Port `Reveal`'s **Save Config / Load Config** workflow so shops can store named press recipes (`230-48 Poster`, `355-31 Hi-R Coated`, `156-64 Garment`) and embed a lightweight JSON manifest on the `Benday Halftone` layer (mirroring `Reveal`'s `Manifest v2.1`) so re-opening a `.psd` restores exact mesh, `Rule of N`, bias angle, manual rosette overrides, and tail mode.
3. **Bimodal Variance-Gated (`BVG`) Edge Snapping (`BvgEdgeSnapper.js`):**
   - Adapt `Reveal`'s Dual-Scale Bimodal Variance Gating (`SeparationEngine.js` / `DitheringStrategies.js`) as a pre-halftone conditioning pass that snaps anti-aliased graphic/type rims cleanly to `{0, 255}` and promotes narrow ICC Rich-Black text strokes to solo `100% K` while leaving continuous-tone photo grain completely untouched.
4. **Top-Bar Perceptual Fidelity Telemetry (`HVS ΔE · Gray Steps`):**
   - Mirror `Reveal`'s top-bar `ΔE · DNA · Match %` readout with a halftone-appropriate **Viewing-Distance (`HVS`) `ΔE`** (Gaussian low-pass over `~1.5 × cellPitchPx` in SWOP Lab) paired with **Gray Steps per Cell (`(DPI / LPI)²`)** and **Tail Rescue `%`**.
5. **Interactive Diagnostic Overlay Toggle (`Show Traps` → `Show Preflight / Choke`):**
   - Reuse `Reveal`'s non-destructive preview overlay toggle for `Benday v0.2`'s `meshPreflight` washout/bridge X-Ray (`#FF2A2A` / `#0077FF`) and Rich-Black C/M/Y choke keepaway visualization.
6. **Perceptual Image DNA for Automatic Rosette Slot Permutation:**
   - Leverage `Reveal`'s hue-sector and contrast-distribution insights when permuting `{C, M, Y, K}` across `{θ+15°, θ+45°, θ+60°, θ+75°}` (`45°` oblique-effect slot for the dominant midtone ink; `30°` separation for dominant 2-ink overlaps).

---

## 3. Loop B: `Benday → Reveal` (Bringing `Benday`'s Advances Back into `Reveal`)

1. **Upgrading `Reveal`'s Mesh Physics (`SAATI_MESH_PRESETS` + Thread Diameter + Open Area):**
   - Replace `Reveal`'s TPI-only `minDotPx` helper with `Benday`'s physical plain-weave aperture model (`threadDiaUm`, `openArea`, `openAreaScale`, knuckle floor, and `SAATI_MESH_PRESETS`) across `reveal-core`, `pyreveal`, `libreveal`, and `krita-reveal` (preserving `ΔE76 < 3.0` cross-language parity).
2. **Replacing `0°` `8×8` Bayer Dithering with Moiré-Safe Angled Halftone Screens:**
   - `Reveal`'s current ordered dithering (`DitheringStrategies.js`) uses an axis-aligned `8×8` `BAYER_MATRIX` (`0°` — directly parallel to square-stretched warp and weft mesh threads!).
   - Integrating `@electrosaur-labs/benday-core` (`halftoneChannel` + `RosetteAngles` / `autoOptimizeAngle`) gives `Reveal` true **angled, moiré-safe Euclidean and Hybrid AM/FM screens** for two-color spot blends, tonal spot-color gradations, and choked white underbase screens on dark garments (`v0.3`).
3. **Lossless Zero-Dependency PNG Preview + Scrollable `Fit / 50% / 100% / 200%` Viewport:**
   - `Reveal` (`Preview.js`) currently encodes proxy previews with `jpeg-js` (`JPEG_QUALITY = 95`), which introduces faint `8×8` JPEG ringing along razor-sharp spot-color contours and adds a `Buffer` polyfill dependency in Webpack.
   - Back-porting `Benday`'s zero-dependency `pngDataUrl.js` lossless RGBA PNG encoder + `16 px`-halo scrollable `Fit / 50% / 100% / 200%` viewport virtualization gives `Reveal` crisp, artifact-free pixel inspection of `1 px` trapping and dithering while dropping `jpeg-js` + `buffer` from the UXP bundle.
4. **Monotone Knaster-Tarski Dot + Enclosed-Hole Closure & Graphic Counter Sovereignty:**
   - Sequential despeckle + hole-closing passes can re-create sub-mesh bridges where two healed features nearly touch, or accidentally plug `1 px` letter counters (`e`, `a`, `o`) in crisp line art.
   - Back-porting `Benday`'s monotone fixed-point closure (`HalftoneEngine` Stage 6 inward `Op B` + final `Op A`), pure `{0, 255}` graphic counter protection, and independent Jordan-curve auditor (`PlateVerifier.js`) hardens both `MechanicalKnobs.applySpeckleRescue` and `reveal verify`.

---

## 4. Shared Downstream Screen-Shop Infrastructure (`v0.2+` / `v0.3`)

Both **Reveal** (spot-color masks in Lab) and **Benday** (CMYK / single-channel `{0, 255}` halftone screens) ultimately terminate at the **exact same physical exposure unit**. Building the downstream film & preflight modules once in a shared zero-dependency package (or inside `@electrosaur-labs/benday-core` + CLI) serves the entire suite:

1. **Unified External & Internal Screen Preflight (`meshPreflight.js`):**
   - Audits *any* binary `{0, 255}` screen — whether produced by `Benday`, `Reveal`, client artwork, or legacy Photoshop `Bitmap` separations — for highlight washout hazards and shadow ink-bridging pinholes against a chosen SAATI `(TPI - µm)` roll, with `< 50 ms` healing and X-Ray guide-layer output.
2. **Unified Direct Inkjet Film-Positive Spooler ("RIP Killer" — Headless `libgutenprint` + Raw `ESC/P2`):**
   - Native physical-inch anisotropic rasterization (`720 × 720`, `720 × 1440`, and `1440 × 2880` DPI), headless `libgutenprint` (`Predithered` per-nozzle `ESC/P2` / `PCL3GUI` / `BJL`) piped straight over `lp -o raw`, TCP port `9100`, or `libusb` (zero OS driver resampling, ColorSync, or macOS PDE/CUPS filter entanglements), `2-bit` picoliter UV droplet-weight control, multi-slot All-Black channel mapping + clogged-nozzle failover, automated `1 px` registration crosshairs, screen slugs, and `1-bit` bilevel TIFF archiving (see [HOKUSAI.md](HOKUSAI.md) and [FUTURES.md §4](FUTURES.md#4-direct-inkjet-film-positive-spooler-hokusai--rip-killer--headless-libgutenprint--raw-escp2-bypass-v02--v03)).
   - Result: **Reveal** (creative spot color) and **Benday** (fast 4-screen CMYK & calibrated tonal halftones) become two front-ends feeding one unified, RIP-free physical screen-printing output pipeline.

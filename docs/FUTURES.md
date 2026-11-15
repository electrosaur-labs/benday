# Electrosaur: Benday — Post-v0.1 Roadmap & Deferred Specifications

This document records the engineering designs and mathematical specifications deferred past the frozen **Benday v0.1** release so that all architectural work solved during v0.1 design carries forward cleanly into **v0.2** and **v0.3**.

## Scope Boundary: v0.1 (Shipped) vs. Post-v0.1

**Benday v0.1** delivers:
- Zero-dependency mesh-aperture physics (`MeshPhysics.js`) with isotropic and anisotropic `(dpiX, dpiY)` support.
- Bias-tolerant CMYK rosette geometry and analytical 2D reciprocal-lattice harmonic moiré analysis (`RosetteAngles.js`).
- Symmetric Euclidean halftoning with `100%` solid linework sovereignty, `0%` paper lock, Hybrid AM/FM / Cutoff / Clamp tail modes, and exact morphological $B_{D_{\min}}$ dot and shadow-hole guarantees (`HalftoneEngine.js` + `PlateVerifier.js`).
- Non-destructive Photoshop UXP command plugin (`@electrosaur-labs/benday-ps`) and headless TIFF/PGM CLI (`@electrosaur-labs/benday-cli`).

The eight specifications below are scheduled for **v0.2** and **v0.3**:

| Target | Module / Feature | Package(s) | Primary Purpose |
|---|---|---|---|
| **v0.2** | Press Dot Gain Compensation | `benday-core`, `benday-ps`, `benday-cli` | Single-slider (`0%–20%`) parabolic midtone dot-gain pullback ($t' = t - 4 \Delta G \, t(1-t)$) keeping `Original` artwork true on screen |
| **v0.2** | `FftMoireAnalyzer.js` & Image-Aware Rosette Assignment | `benday-core`, `benday-ps`, `benday-cli` | `512 × 512` Radix-2 2D FFT spatial moiré simulator, `< 300 ms` angle solvers, and `< 2 ms` image-aware `{15°, 45°, 60°, 75°}` channel-slot permutation |
| **v0.2** | Rosette Presets, Bias Slop Bar & `1:1`/`2:1` Viewport Polish | `benday-ps`, `benday-core` | Rosette Angle Presets dropdown (`Auto`, `FTA +7.5°`, `ISO Litho`, `Flamenco 45°`, `Manual…`), visual stretcher-slop error bar (`±2°`), and faster `100%`/`200%` viewport updates |
| **v0.2** | `meshPreflight.js` | `benday-core`, `benday-ps`, `benday-cli` | Standalone highlight-washout & shadow-bridge detector, X-Ray diagnostic overlay, and `< 50 ms` in-place healer for external separations |
| **v0.2** | Rich Black, Choke & TAC Control | `benday-core`, `benday-ps`, `benday-cli` | Configurable Rich Black synthesis with `1–3 px` C/M/Y underbedding choke and `260%–300%` wet-on-wet TAC mud ceiling |
| **v0.2** | `BvgEdgeSnapper.js` (`BVG`) | `benday-core`, `benday-ps`, `benday-cli` | Bimodal Variance-Gated (`BVG`) text/linework edge snapping and Rich-Black type UCR without sharpening photographic grain |
| **v0.2+** | Direct Inkjet Film-Positive Spooler ("Hokusai") | `benday-cli`, `benday-ps`, `hokusai` | Headless `libgutenprint` (`Predithered` raw `ESC/P2` / `PCL3GUI`) OS-driver bypass over `lp -o raw` / TCP `9100` / `libusb`, UV droplet-weight dial, multi-slot All-Black mapping, and anisotropic `1-bit` film furniture |
| **v0.3** | `Reveal` Spot-Color Halftone Bridge | `benday-core`, `reveal` | Mesh-aware halftoning for tonal spot-color separations and choked white underbase screens |

---

## 1. `FftMoireAnalyzer.js` — 512×512 Radix-2 2D FFT Moiré Analyzer & Auto-Optimize Angle Solver (v0.2)

### Motivation

In v0.1, `analyzeMoire` (`RosetteAngles.js`) analytically evaluates 2D reciprocal-lattice beat vectors (`|j|, |k| <= 8` vs. mesh harmonics `|m1|, |m2| <= 4`) weighted by square-aperture `sinc` and circular-dot Airy (`2·J₁(x)/x`) factors in `< 1 ms`. While fast and accurate for standard Euclidean rosettes, an analytical circular-dot model approximates the nonlinear diamond-clipped `50%` midtone transition and does not directly optimize arbitrary LPI overrides or single-channel spot angles.

`FftMoireAnalyzer.js` adds a direct spatial-domain `512 × 512` optical transmission simulator and 2D Fast Fourier Transform to measure exact nonlinear screen-to-mesh interference and drive automatic angle solvers inside a `< 300 ms` interactive budget.

### Mathematical Design & Invariants

1. **Zero-Dependency Cooley-Tukey Radix-2 2D FFT (`N = 512`):**
   - Pure JavaScript `Float64Array` implementation with zero external dependencies and zero Node.js built-ins.
   - Precomputes and caches the `512`-element bit-reversal table (`Uint16Array(512)`), complex roots-of-unity twiddle tables, and periodic 1D/2D Hann window weights $w[n] = \tfrac{1}{2}\bigl(1 - \cos(2\pi n / N)\bigr)$.
   - **Real-Pair Complex Packing (`fft2dRealPair`):** During angle sweeps, two real `512 × 512` spatial transmission patches $A$ and $B$ are packed into one complex buffer $Z = A + i B$, transformed in a single forward 2D FFT, and separated in $O(N^2)$ via conjugate symmetry:
     $$F_A(\mathbf{k}) = \frac{Z(\mathbf{k}) + Z^*(-\mathbf{k})}{2}, \qquad F_B(\mathbf{k}) = \frac{Z(\mathbf{k}) - Z^*(-\mathbf{k})}{2i}$$
     halving the total number of 2D FFTs executed by the angle solvers.

2. **Nyquist-Safe Non-Integer Simulation Resolution (`simDpi`):**
   - Simulation pitch is decoupled from document DPI and set dynamically from `meshTpi`:
     $$\text{simDpi} = \max\bigl(1024,\; \operatorname{round}(4.17 \cdot \text{meshTpi})\bigr)$$
   - Across the full `110–420 TPI` mesh catalog (`simDpi` up to `1751 DPI` at `420 TPI`), both fundamental warp/weft frequencies ($f_m = \text{meshTpi}$) and `(±1, ±1)` diagonal mesh modes ($\sqrt{2}\,\text{meshTpi} \approx 1.414\,\text{meshTpi}$) remain strictly below Nyquist ($\text{simDpi}/2 \ge 2.085\,\text{meshTpi}$).
   - Choosing the non-integer `4.17` multiplier prevents higher-order mesh harmonics ($2f_m, 3f_m, 4f_m$) from aliasing directly onto `k = 0` (DC). Over `N = 512`, the simulated physical window is $L = 512 / \text{simDpi}$ inches with frequency resolution $\Delta f = \text{simDpi} / 512$ cycles/inch (`cpi`).

3. **Corner-Rounded `50%` Euclidean SDF Patch `H(x, y)` × Mesh Mask `M(x, y)`:**
   - **Why corner rounding is required:** An ideal sharp-cornered `50%` checkerboard has exact `0` Fourier amplitude on every non-zero harmonic where `j + k` is even, artificially hiding real press beats caused by finite emulsion and squeegee corner rounding at midtone tangency.
   - `H(x, y)` evaluates a signed-distance-field `50%` Euclidean screen with physical fillet radius $r_f = d_{\min} / 2$, threshold-calibrated so mean open area equals `0.50` to `< 1e-4`, rasterized with 1-pixel analytic box anti-aliasing (`[0, 1]`).
   - `M(x, y)` evaluates the rotated plain-weave mesh open-area mask (pitch $p_m = 1 / \text{meshTpi}$, clear opening $w_o = p_m - d_t$, rotated by $\theta$) with 1-pixel analytic box anti-aliasing.
   - Spatial open-area transmission is formed pointwise as $I(x, y) = H(x, y) \cdot M(x, y)$.

4. **Windowed DC Subtraction, Carrier Notches & Quadrature `E_dcLock` Guard:**
   - **Hann-weighted mean removal:** Subtract the window-weighted mean $\bar{I}_W = \frac{\sum I \cdot W}{\sum W}$ prior to windowing, transforming $(I - \bar{I}_W) \cdot W$, and zero the central DC disk ($r_{\text{DC}} = 3\text{ bins}$).
   - **Carrier harmonic notches:** Zero circular notches of radius $r_{\text{notch}} = 4\text{ bins}$ around all fundamental and low-order screen harmonics ($|j|, |k| \le 4$) and mesh harmonics ($|m_1|, |m_2| \le 2$) so normal halftone dot visibility is not penalized as moiré.
   - **Sub-screen visual passband:** Integrate residual spectral energy strictly inside the visible low-frequency passband:
     $$0 < \|\mathbf{f}\| \le \min(0.80 \cdot \text{lpi},\; 25.4\text{ cpi})$$
   - **Quadrature quarter-pitch `E_dcLock` pass:** At a direct `0°` commensurate clash (such as `lpi = meshTpi / 4` aligned with the threads), the beat frequency approaches $f_{\text{beat}} \to 0$, producing a stationary screen-wide density shift that would otherwise sit inside the $r_{\text{DC}} = 3$ DC mask. Evaluating `H(x, y)` at two quadrature spatial phases $(0, 0)$ and $(p_s/4, p_s/4)$ measures $E_{\text{dcLock}} = |\bar{I}_W^{(0)} - \bar{I}_W^{(1/4)}|^2$ and adds it to the moiré objective, ensuring `0°` commensurate locks are always penalized.

5. **Interactive Solvers (`< 300 ms` Target):**
   - `autoOptimizeAngle({ meshTpi, threadDiaUm, lpi, meshAngleDeg, slopDeg })`: Coarse-to-fine sweep over `[0°, 90°)` using `fft2dRealPair` to select the single-screen angle minimizing worst-case moiré energy across `[θ - slopDeg, θ + slopDeg]`.
   - `optimizeRosetteAngles({ meshTpi, threadDiaUm, lpi, meshAngleDeg, slopDeg })`: Optimizes a rigid global rotation offset $\phi \in [0°, 90°)$ while **strictly preserving exact `30.0°` strong-ink separation** (`C = φ`, `K = φ + 30°`, `M = φ + 60°`, `Y = φ + 45°` mod `90°`), preventing individual screen tweaks from breaking 3-color `{C, K, M}` rosette geometry.

6. **Image-Aware Rosette Slot Assignment (`< 2 ms`) & Subject-Texture Moiré Avoidance:**
   - **Why the 4 angles stay a rigid constellation while channel slot assignment adapts to the image:** Screen-to-mesh geometry fixes the safest 4-angle rosette constellation (e.g., `{15°, 45°, 60°, 75°}` on a `0°` square-stretched frame, giving all 4 screens `15.0°` nominal thread clearance), but **which ink (`C`, `M`, `Y`, `K`) occupies each slot** can be permuted per image in `< 2 ms` from a single channel-co-occurrence pass:
     1. **Human Visual System Oblique Effect (`45°` Least-Visible Slot):** Human contrast sensitivity to periodic dot lattices peaks along horizontal/vertical (`0° / 90°`) and drops by `~3 dB` along the `45°` diagonal. Conventional CMYK hard-codes `K = 45°`, yet on illustrations with light `K` (`< 5%` midtone coverage) and heavy `M` flesh tones or `C` skies, swapping the dominant midtone ink into `45°` noticeably smooths perceived rosette grain.
     2. **Dominant 2-Ink Overlap Separation (`30°` vs. `15°`):** Because 4 screens span a `90°` quadrant, one channel (conventionally Yellow at `60°`) sits `15°` from two neighbors (`K = 45°`, `M = 75°`). Measuring pixelwise midtone co-occurrence $\langle C \cdot M \rangle$, $\langle M \cdot Y \rangle$, and $\langle C \cdot Y \rangle$ (weighted by visual ink darkness $w_K > w_M \approx w_C \gg w_Y$) ensures heavy warm oranges/reds ($\langle M \cdot Y \rangle$ dominant) or lush greens ($\langle C \cdot Y \rangle$ dominant) place their two active inks `30°` (or `45°`) apart rather than `15°` adjacent.
     3. **Subject-Texture Interference Check (via 2D FFT):** Repeating narrow stripes, plaid shirts, brick courses, or line-engraving hatching at spatial frequency $\mathbf{f}_{\text{img}} \approx \text{LPI}$ create *object moiré* when a channel carrying that texture aligns with $\angle \mathbf{f}_{\text{img}}$. Reusing the `512 × 512` 2D FFT from `FftMoireAnalyzer.js` detects directional peaks in `[0.5 · LPI, 1.5 · LPI]` and assigns the texture-bearing channel to the rosette slot farthest in angle from $\angle \mathbf{f}_{\text{img}}$.
   - **Manual FTA `+7.5°` Offset Tolerance (`82.5° / 22.5° / 7.5° / 52.5°`):** Refine `RosetteAngles.js` clearance warnings so manual flexo/FTA `+7.5°`-shifted rosettes (`7.5°` nominal thread clearance, `5.5°` worst-case at `±2.0°` slop) distinguish genuine harmonic beat contrast from pure low-angle stretcher sensitivity (`WARN_TIGHT_CLEARANCE` vs. `WARN_SEVERE_MOIRE`).

---

## 2. `meshPreflight.js` — External Film Washout & Ink-Bridge Preflight Detector + X-Ray Overlay (v0.2)

### Why External Separations Need Preflight

Halftone screens generated by Benday already achieve `0` highlight washout violations and `0` sub-mesh enclosed shadow-hole violations by construction (enforced via Stages 4–6 morphological opening and monotone Knaster-Tarski fixed-point closure in `HalftoneEngine.js`, and verified by `PlateVerifier.js`).

However, screen shops routinely receive pre-rip 1-bit or 8-bit separations produced outside Benday — from client artwork, legacy RIPs, Photoshop's `Image → Mode → Bitmap...` (Halftone Screen or Diffusion Dither), or `Filter → Pixelate → Color Halftone`. Those external separations have no knowledge of mesh TPI or thread diameter and frequently contain 1–2 pixel highlight specks that wash off in the booth and narrow shadow pinholes that bridge shut on press.

### Architecture & Connected-Component Design

1. **Linear-Time Pure-TypedArray 2-Pass Union-Find Labeler:**
   - Zero-dependency $O(W \cdot H)$ connected-component engine using flat `Int32Array` parent/rank/size tables with path compression:
     - **Foreground ink components (`screen[p] === 255`):** 8-connectivity (matching emulsion bridge cohesion across diagonal pixel corners).
     - **Background clear holes (`screen[p] === 0`):** 4-connectivity (dual Jordan topology so diagonal ink corners properly enclose interior shadow holes).
   - **Perimeter-Clipped Component Exclusion:** Any background `0`-component reaching the 4 image borders (`x = 0`, `x = width - 1`, `y = 0`, `y = height - 1`) is exterior substrate margin, not an enclosed shadow hole; foreground border-clipped dots are likewise distinguished from interior highlight specks so cropped edges do not trigger false alarms.
   - **Anisotropic `(dpiX, dpiY)` + Inscribed Canonical Disk $B_{D_{\min}}$ Sliver Check:** Pixel count alone cannot distinguish a compact `12 px` circular dot from a `1 × 12 px` razor sliver that washes off the mesh. Candidate foreground components and enclosed background holes are tested both by physical area (`aMinPx` under `(dpiX, dpiY)`) and by morphological survival under the canonical physical disk/ellipse $B_{D_{\min}}$ (`dMinPxX × dMinPxY`).

2. **Operating Modes:**
   - **`mode: "audit"` (Non-Destructive X-Ray Inspection):**
     - Returns `{ ok, washoutCount, washoutPixels, plugCount, plugPixels, overlayRgba }`.
     - Generates an RGBA diagnostic X-Ray buffer rendering safe ink in neutral gray/black and highlighting physical press hazards in high-contrast false color:
       - **`#FF2A2A` (Red):** Highlight washout hazard — isolated foreground dots or slivers too small to anchor across mesh threads and knuckles.
       - **`#0077FF` (Blue):** Shadow ink-bridge / emulsion-plug hazard — enclosed clear holes narrower than $B_{D_{\min}}$ that will fill in on press.
     - **CLI integration (`benday-cli`):** `benday preflight <screen.tif> --mesh 230 --n 5.0 --xray preflight-xray.png` (emitting exit code `0`/`1`, JSON metrics, and diagnostic PNG/TIFF overlay).
     - **Photoshop UXP integration (`benday-ps`):** One-click **Preflight Active Layer** creating a non-printing top **Guide Layer** (`Benday Preflight X-Ray`) over third-party bitmap separations.
   - **`mode: "heal"` (Fast In-Place Screen Rescue, `< 50 ms` per 4K Screen):**
     - Mutates or clones a binary screen buffer in `< 50 ms` at `4096 × 4096` resolution: scrubs unprintable sub-mesh highlight specks to `0` (`0%` clear) and fills unprintable sub-mesh enclosed shadow pinholes to `255` (`100%` solid) so third-party separations burn and print cleanly without tonal muddying.

---

## 3. Rich Black Synthesis, Choked Underbedding & TAC Mud Control (v0.2)

### Press Problem

In 4-color process screen printing, process black (`K`) ink is formulated with semi-transparent pigment load so CMYK overprints maintain tonal range. Large solid black fills or bold display type separated as `C=0%, M=0%, Y=0%, K=100%` can therefore look slightly washed out or charcoal on press compared to spot black. Conversely, stacking `100% C + 100% M + 100% Y + 100% K` (`400%` total ink) causes wet-on-wet screen build-up ("mud"), stencil sticking, and colored C/M/Y fringes around black edges whenever press registration shifts by even half a millimeter.

### Planned Pre-Halftone Conditioning Stage

1. **Configurable Rich Black Recipes:**
   - Identifies `100% K` solid graphic regions (`K = 255` with low/zero `C, M, Y`) and applies a user-selectable Rich Black recipe — for example, **`C: 50%, M: 40%, Y: 40%, K: 100%`** (`230%` total coverage) or a warm/cool shop preset — prior to halftoning `C`, `M`, and `Y`.
2. **Automatic Morphological Choke / Keepaway (`1–3 px` Inset):**
   - Erodes the synthesized `C`, `M`, and `Y` underbedding masks inward from the `100% K` boundary by a configurable choke radius (`1–3 px`, or physical `mm`/`mil` scaled via `dpiX` and `dpiY`).
   - **Automatic fine-type protection:** Any `100% K` stroke, serif, or hairline narrower than `2 × chokePx` erodes completely to `0` on the under-screens and prints strictly as crisp `100% K` solo ink, while wide black fills receive halftoned C/M/Y underbedding safely inset behind a pure `K` perimeter rim.
3. **Wet-on-Wet Total Area Coverage (TAC) Ceiling (`260%–300%`):**
   - Enforces a configurable maximum ink sum (`C + M + Y + K <= tacLimit`, typically `260%–300%` depending on mesh count and flash schedule) across continuous-tone shadow pixels via proportional CMY under-color reduction while preserving `100%` solid `K` keylines untouched.

---

## 4. Direct Inkjet Film-Positive Spooler ("Hokusai" / "RIP Killer") — Headless `libgutenprint` & Raw `ESC/P2` Bypass (v0.2+ / v0.3)

> **Dedicated Living Spec:** Tracked in full at **[docs/HOKUSAI.md](HOKUSAI.md)** — named after Katsushika Hokusai (*hanshita-e* black master sheets & *kento* registration) and **dedicated to William Henry Fox Talbot** (1852 silk-gauze actinic stencil patent).

### Why OS Print Drivers & Standard Page Languages Ruin Film Positives

Even when **Reveal** (spot color) or **Benday** (fast 4-screen CMYK process & comparison screens) generates a mathematically exact `{0, 255}` screen, printing that screen onto clear waterproof film through normal macOS or Windows print dialogs destroys dot integrity at the last mile:

1. **OS / Driver Resampling & Re-Screening:** Standard OS print paths (AirPrint, IPP Everywhere, Apple `URF` / `PWG Raster`, and vendor RGB drivers) convert crisp `1-bit` screens into `8-bit` continuous-tone `sRGB`, resample across mismatched grids (e.g. `300` or `600 DPI` → `720 DPI`), apply ColorSync/ICC profiles, and run the printer firmware's own error-diffusion dither on top — fuzzing dot edges, introducing secondary beat moiré, and peppering clear film with stray scum dots.
2. **Why `PostScript` & `PCL5` Don't Solve Shop Inkjets:** `PostScript` and `PCL5` / `PCL6` are laser-printer and imagesetter languages. Virtually no prosumer or wide-format shop inkjet speaks `PostScript` or `PCL5` natively, and laser toner on film/vellum suffers from fuser-heat dimensional shrinkage (ruining multi-screen registration) and low UV optical density ($D_{\text{UV}}$).
3. **Host-Based Inkjet Nozzle Protocols (`ESC/P2` vs. `ESC/P-R`):**
   - Inkjet printheads expose low-level, brand-specific host raster protocols: **Epson `ESC/P2` Raster (`ESC i`)**, **HP `PCL3GUI` / `HP-RTL`**, and **Canon `BJL` Raster**.
   - **Critical Epson distinction:** Epson's newer unified **`ESC/P-R`** protocol sits *above* the halftoner (accepting `8-bit sRGB` and screening inside closed printer firmware — unusable for `1-bit` film positives or single-channel ink control). True RIP-grade film output requires classic per-nozzle **`ESC/P2` Raster**, where the host sends raw `1-bit` or `2-bit` (Small / Medium / Large picoliter droplet) bitmaps **per physical ink channel** at native head addressability (`720 × 720`, `720 × 1440`, `1440 × 1440`, or `1440 × 2880 DPI`), along with model-specific printhead nozzle geometry, soft-weave pass interleaving, micro-step paper advances (`ESC ( v`), droplet waveform hex IDs, and binary Remote Mode initialization packets.

### Why Gutenprint Abandoned macOS — and the Headless Sidecar Loophole

`Gutenprint` (`libgutenprint`) already solved the hard UNIX-style abstraction problem Epson never published: a single C `ESC/P2` soft-weave & packetizer engine (`print-escp2.c`) driven by declarative XML hardware descriptors (`model_*.xml`, ink tables, and picoliter drop LUTs) per printer model.

Gutenprint dropped official macOS installers not because of printer math, but because maintaining a **general-purpose macOS system print driver** for `3,500+` printers meant:
- Maintaining Cocoa **Print Dialog Extensions (PDEs)** injected into sandboxed macOS apps, plus annual Apple Developer ID signing and Notarization churn.
- Rewriting `/Library/Printers` CUPS PPD filters after Apple deprecated classic CUPS drivers in favor of `PAPPL` localhost IPP Printer Applications.

**The Architectural Loophole:** A dedicated screen-print film spooler needs **zero percent** of macOS's Print Dialog, PDEs, ColorSync, or CUPS filter chain:
- `libgutenprint` itself is pure, portable POSIX C + XML descriptors that compiles cleanly as a standalone `arm64` / `x86_64` headless sidecar (`electrosaur-film`).
- Raw output bytes bypass the OS print pipeline completely via **CUPS raw pass-through (`lp -d <queue> -o raw`)**, direct **TCP Port `9100` (JetDirect / AppSocket)** over Ethernet/Wi-Fi, or direct **`libusb` bulk transfer**.

### The Three-Legged Electrosaur Prepress Stack (Commercial RIP Replacement)

Commercial screen-print film RIPs (\$500+ licenses/subscriptions like AccuRIP or FilmMaker) only sell three capabilities on top of raw `ESC/P2`: halftone screening, picoliter droplet-weight control, and multi-slot black channel mapping. Because **Benday** already owns a more physically rigorous, mesh-governed halftoner, adding a thin headless `libgutenprint` film spooler completes the entire prepress stack:

1. **Leg 1 — `Reveal`:** Perceptual `16-bit CIELAB` spot-color separation & trapping (`3–12` intentional spot screens).
2. **Leg 2 — `Benday`:** Mesh-aperture-governed `{0, 255}` halftoning (`Rule of N`, thread/knuckle floor, zero mesh moiré) — serving tonal spot screens, fast 4-screen CMYK runs, and physically honest CMYK comparison baselines against spot separations.
3. **Leg 3 — `Hokusai` ("RIP Killer" Spooler):** Direct `{0, 255}` screen → headless `libgutenprint` (`Dither Algorithm = Predithered`) → raw `ESC/P2` / `PCL3GUI` / `BJL` byte stream straight to the printer hardware.

### Planned Spooler Architecture & Deliverables

1. **Zero-Resample Native Printhead Grid Rendering (Foundation Shipped in v0.1):**
   - Render screens directly at the target printhead's native hardware grid (or exact integer divisor): **`720 × 720`**, **`720 × 1440`**, **`1440 × 1440`**, or **`1440 × 2880 DPI`** for Epson MicroPiezo / PrecisionCore heads (`600 × 600` / `1200 × 1200 DPI` for Canon/HP), using Benday v0.1's native anisotropic `(dpiX, dpiY)` lattice and elliptical discrete $B_{D_{\min}}$ stamps (`dMinPxX × dMinPxY`) so zero pixels are ever interpolated.
2. **Droplet-Weight / UV Optical Density ($D_{\text{UV}}$) Calibration Dial:**
   - Expose direct `2-bit` per-nozzle droplet selection (**Small / Medium / Large picoliter drops** + pass-density duty cycle) via `libgutenprint`'s `Predithered` raw channel API so shops dial in maximum UV-blocking black density ($D_{\text{UV}} \ge 3.8\text{–}4.2$) right below the microporous film coating's pooling/bleed ceiling.
3. **Multi-Slot "All-Black" Ink Mapping, UV Pigment Mixes & Clogged-Head Failover:**
   - **All-Black kit mode:** Fan a single `1-bit` screen simultaneously across any chosen subset of physical ink slots (`K, C, M, Y, LC, LM, LK, LLK`) for shops running dedicated UV-blocking all-black dye cartridges.
   - **Single-click nozzle failover:** If one printhead channel clogs mid-run on an older shop workhorse, remap film output onto remaining clean slots without stopping production.
   - **Standard pigment UV-mix mode (e.g., Epson Stylus Pro `3880`):** For dual-purpose proofing/film printers loaded with OEM pigment inks, fire calibrated multi-channel UV-absorbing droplet recipes (`PK + Y + LK/C`, taking advantage of Yellow pigment's strong near-UV absorption around `365–405 nm`) without exceeding film dry-time limits.
4. **Curated Screen-Shop Workhorse Printer Matrix (~10 Models, Not 3,500):**
   - Instead of maintaining drivers for thousands of office printers, bundle verified XML profiles and film-density presets strictly for the classic `ESC/P2`-capable screen-shop workhorses (e.g., **Epson Stylus Pro `3880` / `4880` / `4900`**, **Artisan `1430`**, **SureColor `P800` / `SC-T3170x`**, **`XP-15000`**, and verified `ESC/P2` EcoTank/SureColor models), while explicitly warning against consumer `ESC/P-R`-only models whose firmware strips raw nozzle control.
5. **Automated Film Furniture, Slugs, Exposure Step-Wedges & `1-Bit` Bilevel TIFF Export:**
   - Stamp identical `1 px` registration crosshairs/targets across all `N` spot or `4` CMYK screens, human-readable **screen slugs** outside trim (`Job · Channel/Spot · SAATI 230-48 · 46.0 LPI · 15.0° · N=5.0 · Drop Preset`), and a physical **UV exposure & washout control wedge** (`2%–95%` patches + positive/negative $B_{D_{\min}}$ targets), with optional `1-bit` PackBits/Deflate TIFF output (`benday film`) for archiving or external queues.

---

## 5. Electrosaur `Reveal` Spot-Color Halftone Integration (v0.3)

### Suite Integration Goal

Within the Electrosaur suite, **Reveal** reduces full-color images in 16-bit CIELAB space into `3–12` graphic spot-color screens, while **Benday** provides physical mesh-aperture halftoning for continuous-tone separations.

In **v0.3**, `@electrosaur-labs/benday-core` will serve as the shared halftone screen engine for **Reveal** workflows that combine spot-color inks with tonal gradations:

1. **Tonal Spot-Color Separations:** Routes continuous-tone or soft-masked spot-color channels from `Reveal` through `halftoneChannel` using the shop's exact `(meshTpi, threadDiaUm, ruleOfN, tailMode)` spec and `autoOptimizeAngle` single-screen moiré avoidance.
2. **Mesh-Safe Halftoned White Underbase & Highlight White:** Generates choked, mesh-safe Euclidean or Hybrid AM/FM white underbase screens (for dark garments and colored paper stocks) where every highlight fade dot and shadow vent hole obeys the physical $B_{D_{\min}}$ floor of the underbase screen mesh (typically `110–156 TPI`).

For the full bidirectional cross-pollination plan covering `Reveal → Benday`, `Benday → Reveal` (including `SAATI_MESH_PRESETS` and `Rule of N` vocabulary unification, lossless PNG `100%/200%` viewport back-porting, and shared `Epson 3880` film-positive infrastructure), see **[Suite Synergy Roadmap (`Benday ↔ Reveal`)](SUITE-SYNERGY.md)**.

---

## 6. `BvgEdgeSnapper.js` — Bimodal Variance-Gated (`BVG`) Text Edge Snapping & Rich-Black Type UCR (v0.2)

### Press Problem

Benday v0.1 already preserves exact `100%` solid channel pixels (`src === 255`) at native 1-pixel resolution. However, flattened artwork converted from RGB via `Edit → Convert to Profile...` frequently introduces two sub-`255` type degradations before Benday ever sees the channels:

1. **Anti-aliased type & vector edges (`1–254` transition rims):** Rasterized type carries `1–2 px` gray anti-aliasing ramps along stems and serifs. If halftoned directly, those anti-aliased transition pixels break into coarse halftone dots (`45–65 LPI`) that serrate otherwise crisp letterforms.
2. **ICC Rich-Black type (`RGB (0,0,0)` → `C≈75%, M≈68%, Y≈67%, K≈90%`):** Standard coated CMYK profiles separate RGB black text across all four channels with `K < 100%`. On press, even `0.25 mm` of screen misregistration fringes small type with visible Cyan/Magenta/Yellow halftone dots while `K = 90%` itself gets screened into shadow pinholes instead of solid black strokes.

### Planned Bimodal Variance-Gated (`BVG`) Pre-Conditioning Stage

1. **Local Window Bimodal Variance & Dip Test (`5 × 5` / `7 × 7` Integral-Image Window):**
   - Evaluates local luminance/ink contrast ($\sigma^2_{\text{local}}$) together with Otsu inter-class variance ratio $\eta = \sigma^2_B / \sigma^2_T \in [0, 1]$ across a small neighborhood.
   - **Photographic immunity:** Continuous-tone gradients, skin tones, and high-ISO film grain exhibit unimodal or broad multi-level histograms ($\eta < \eta_{\text{gate}}$) and pass into `halftoneCmyk` completely untouched.
   - **Graphic/type edge lock:** High-contrast bimodal step edges ($\Delta I \ge \Delta_{\min}$ and $\eta \ge 0.82$) identify genuine graphic linework and anti-aliased typography.
2. **Sub-Pixel Midpoint Contour Snapping:**
   - Inside gated bimodal edge rims, anti-aliased transition pixels snap cleanly to the local bimodal midpoint (`0` clear substrate or `255` solid `100%` ink), restoring razor-sharp `1 px` stems, serifs, and counters without unsharp-mask halos.
3. **Narrow-Stroke Rich-Black Type UCR (`K`-Snap + CMY Suppression):**
   - When a bimodal dark stroke narrower than `2 × cellPitchPx` (fine/medium body type and line art) carries neutral dark CMYK (`C, M, Y, K` separated from RGB black with `K >= 80%` and low chroma), `BVG` promotes the snapped stroke interior to **`K = 255` (`100%` solid Black)** while stripping the redundant `C`, `M`, and `Y` halftone dots from narrow strokes and serifs so small text prints on a single crisp Black screen with zero registration fringing.

---

## 7. Press Dot Gain Compensation — Single-Slider Parabolic Midtone Pullback (v0.2)

### Press Problem

Standard coated offset CMYK profiles (`U.S. Web Coated (SWOP) v2`, `GRACoL`) already compensate for `~18%–20%` midtone dot gain at `150–175 LPI`. However, `45–60 LPI` screen printing through `230–355 TPI` mesh (or proofing binary `{0, 255}` halftone screens directly onto paper on an inkjet printer such as an Epson `3880`) typically exhibits **`+10% to +15%` additional mechanical/optical dot gain** (`~30%–35%` total midtone gain). Compensating via a Photoshop Curves layer pulls channel midtones back, **but** makes the continuous-tone `Original` artwork look artificially washed out on screen.

### Planned Single-Parameter Transfer Stage

- Adds a single optional **Extra Press Dot Gain (`0%–20%`, default `0%`)** control (`--dot-gain` in `benday-cli`) without introducing multi-point curve editor bloat.
- Applies a smooth parabolic midtone pullback right before cell tone sampling:
  $$t_{\text{film}} = t - 4 \Delta G \, t(1 - t), \qquad \Delta G \in [0, 0.20]$$
- **Exact endpoint preservation:** `0%` clear substrate (`t = 0`) and `100%` solid linework (`t = 1`) are mathematical fixed points (`t_film === t`), while a `50%` midtone at `ΔG = 10%` pulls back cleanly to `40%` film dot area so the physical print matches the un-washed-out `Original` on screen.

---

## 8. UI & Press-Setup Ergonomics — Angle Presets, Bias Slop Bar & `1:1`/`2:1` Viewport Speed (v0.2)

1. **Rosette Angle Presets Dropdown (`benday-ps` & `benday-core`):**
   - Replace manual angle memorization with a single **Rosette Preset** dropdown alongside the 4 `C / M / Y / K` angle readouts:
     - **`Auto (Mesh-Centered ±15°)` *(Default)*:** Tracks `meshAngleDeg` (`θ + 15° / 75° / 60° / 45°`), keeping `15.0°` nominal thread clearance and `30.0°` strong-ink separation.
     - **`Image-Aware Auto`:** Permutes `{C, M, Y, K}` across the mesh-safe `{θ+15°, θ+45°, θ+60°, θ+75°}` constellation based on dominant midtone coverage (`45°` oblique-effect slot), 2-ink co-occurrence, and FFT subject-texture avoidance.
     - **`FTA Flexo / Screen (+7.5°)`:** Industry `+7.5°` rotated set (`C: 82.5°`, `M: 22.5°`, `Y: 7.5°`, `K: 52.5°`, or `15°/75°/0°/45° + 7.5°` variants).
     - **`ISO 12647 Litho (15° / 75° / 0° / 45°)`:** Conventional offset proofing reference (useful when bias-stretching frames at `7.5°–22.5°`).
     - **`Flamenco / Single-Angle (22.5° or 45°)`:** Dot-on-dot / single-angle screen printing preset eliminating rosette texture on coarse garment meshes.
     - **`Manual…`:** Automatically selected whenever any individual `C / M / Y / K` angle field is edited directly.

2. **Mesh Bias Angle Stretcher-Slop Error Bar (`±slopDeg` Visual Bracket):**
   - Display the live pneumatic/mechanical stretcher tolerance band directly on the **Mesh Bias (°)** control (e.g. `17° ± 2° → 15.0°–19.0°`) with a visual whisker bracket along the slider track showing safe green vs. harmonic/thread clash zones across `[0°, 90°)`.

3. **Faster `100%` (`1:1`) & `200%` (`2:1`) Interactive Viewport Updates & Low-DPI Output Supersampling:**
   - Render `200%` (`2:1`) zoomed viewports at native `1×` crop dimensions (`420 × 360` instead of `840 × 720`) with crisp nearest-neighbor (`image-rendering: pixelated`) display scaling — cutting `200%` PNG encoding bytes by `4×` — and coalesce rapid slider drag events to `16 ms` animation frames while reusing preallocated scratch buffers inside `HalftoneEngine`.
   - **Optional `2×` Output Raster Supersampling for `150–300 DPI` Sources:** Because a `45–60 LPI` halftone screen only needs `~100–120 PPI` of optical source detail (`2 × LPI`), upsampling the *binary halftone output grid* (`300 → 600 DPI`) quadruples gray steps per cell (`43 → 170` steps) and rounds Euclidean dot contours cleanly without needing higher-resolution source photography.

4. **Save / Load Press Config (`.json` Shop Presets):**
   - Match `Reveal`'s **Save Config / Load Config** workflow (plus embedded `.psd` layer metadata round-tripping) so a print shop can save named press setups (e.g. `Shop-230-Poster.benday.json`, `Shop-355HiR-FineArt.benday.json`) capturing `(meshTpi, threadDiaUm, meshAngleDeg, ruleOfN, lpiOverride, anglesOverride, tailMode, dotGain)` and reapply them in one click across jobs or via `benday halftone --config`.

5. **Perceptual Output Fidelity Score (`HVS Viewing-Distance ΔE` & Gray-Step Telemetry):**
   - Raw pixel-by-pixel `ΔE` is meaningless on binary `{0, 255}` halftones (every pixel is pure ink or pure paper), **but** convolving both the continuous-tone `Original` and the `Halftone` SWOP proof with a Gaussian low-pass kernel matched to human visual acuity at normal viewing distance (`σ ≈ 1.5 × cellPitchPx`) yields a physically meaningful **Perceptual Halftone `ΔE`** alongside **Tonal Steps per Cell (`(DPI / LPI)²`)** and **Tail Rescue `%`** in the top stats bar (mirroring `Reveal`'s `ΔE · DNA · Match %` header).

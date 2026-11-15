# Changelog

All notable changes to **Electrosaur: Benday** are documented in this file.

## [0.2.0] - 2026-11-15

### Added
- **20-Roll Official SAATI Mesh Catalog (`SAATI_MESH_PRESETS`) & `355-31` / `Rule of N = 5.0` Shop Defaults:** Expanded `MeshPhysics` from 9 generic rolls to 20 standard and `Hi-R` high-open-area thin-thread SAATI polyester meshes (`110-80` through `420-27`), defaulting to `355 TPI / 31 µm` (`N = 5.0`).
- **Press Dot Gain Compensation (`0%–20%`):** Parabolic midtone pullback ($t_{\text{film}} = t - 4\Delta G\,t(1-t)$) preserving exact `0%` paper and `100%` solid ink fixed points without washing out the continuous-tone `Original` view.
- **Crisp Type & Linework (`BvgEdgeSnapper`):** Bimodal Variance-Gated (`5 × 5` Otsu separability $\eta \ge 0.82$) pre-conditioning that snaps anti-aliased vector/type edges cleanly and promotes narrow ICC Rich-Black body type (`< 2 × cellPitchPx`) to crisp solo `K = 255` (`C = M = Y = 0`) while leaving photographic gradients, skin tones, and wide Rich-Black fills untouched.
- **Rosette Angle Presets & `< 2 ms` Image-Aware Slot Assignment:** Built-in presets (`Auto`, `Image-Aware`, `FTA +7.5°`, `ISO Litho`, `Flamenco 45°`, `Manual…`) using Campbell–Kulikowski oblique-effect (`45°`) and 2-ink co-occurrence scoring across `{θ+15°, θ+45°, θ+60°, θ+75°}`.
- **Portable `-benday.json` & `.psd` XMP Press Configs (`PressConfig`):** Save/Load reusable shop presets in Photoshop and CLI (`--config` / `--save-config`) plus automatic per-layer and document XMP manifest embedding on commit.
- **16-bit CIELAB Perceptual `HVS ΔE` Telemetry (`HvsQuality`):** Viewing-distance Gaussian PSF evaluation in canonical 16-bit Engine CIELAB (`0..32768`, `16384` neutral) alongside Gray Steps/Cell readouts.
- **UXP v0.2 Workspace Upgrades:** Resizable `1100 × 850` modal, `Fit / 50% / 100% / 200%` viewport virtualization, `< 300 ms` click-to-toggle + `>= 300 ms` press-and-hold (`400 ms` blink) `ORIGINAL` comparison, bottom **Screen Strip** (`Composite + C/M/Y/K` film-positive solo swatches), and theatrical **`★ Credits ★`** crawl dedicated to **Benjamin Henry Day Jr. (1879)**.
- **Extended TIFF Decoder (`benday-cli`):** Support for 16-bit Big-Endian Planar TIFFs, Tiled odd-dimension TIFFs, Deflate+ExtraSamples, WhiteIsZero polarity, and anisotropic centimeter/inch DPI tags.

## [0.1.0] - 2026-11-14

### Added
- **`@electrosaur-labs/benday-core`:** Zero-dependency mesh-aperture physics (`230 TPI / 48 µm` open-area anchor + knuckle floor), bias-tolerant CMYK rosette solver with pure-JS Bessel `J_1(x)` 2D reciprocal-lattice moiré guard, calibrated symmetric Euclidean halftone engine (`hybrid`, `cutoff`, `clamp` tail modes), and canonical discrete disk (`B_{D_min}`) positive-dot & shadow-hole invariant verifier.
- **`@electrosaur-labs/benday-ps`:** Photoshop UXP v5 modal command plugin (`Plugins → Electrosaur: Benday → Benday...`) with live preview and single-undo non-destructive CMYK layer output.
- **`@electrosaur-labs/benday-cli`:** Headless CLI (`benday halftone`, `benday verify`, `benday spec`) with zero-dependency uncompressed Baseline TIFF and PGM (`P5`) support.

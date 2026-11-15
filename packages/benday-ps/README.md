# `@electrosaur-labs/benday-ps`

Adobe Photoshop UXP v5 command plugin for **Electrosaur: Benday** — mesh-aware CMYK halftone screen generation directly inside Photoshop.

## Host Requirements

- **Adobe Photoshop:** `23.3.0` or later (`manifestVersion: 5`, UXP `apiVersion: 2`)
- **Plugin ID:** `org.electrosaur.benday`
- **Menu Path:** **Plugins → Electrosaur: Benday → Benday...**
- **Document Mode:** `8-bit` or `16-bit` **CMYK** (convert via `Edit → Convert to Profile...` before running)

---

## Installation

### Option 1: Install Packaged `.ccx` (End Users)

1. Build `packages/benday-ps/benday-v0.2.0.ccx` using `npm run package:ps` from the monorepo root (or download the release `.ccx`).
2. Double-click `benday-v0.2.0.ccx` to install via the Adobe Creative Cloud Desktop app (on macOS, if double-clicking does not launch the installer, drag the `.ccx` file onto the Creative Cloud Desktop app or Photoshop).
3. Open a single-layer flattened CMYK document in Photoshop and choose **Plugins → Electrosaur: Benday → Benday...**.

### Option 2: Load via Adobe UXP Developer Tool (Development & Debugging)

1. From the `benday/` monorepo root, install dependencies and build the production or development bundle:
   ```bash
   npm install
   npm run build:ps
   ```
2. Launch Photoshop and open the **Adobe UXP Developer Tool** (`UXP DevTools`).
3. Click **Add Plugin** and select the built manifest inside **`dist/`**:
   ```text
   /path/to/benday/packages/benday-ps/dist/manifest.json
   ```
   > **Important:** Always load `packages/benday-ps/dist/manifest.json`, not `packages/benday-ps/manifest.json`. Webpack compiles `@electrosaur-labs/benday-core` and the UXP UI/bridge modules into `dist/index.js`, alongside `dist/index.html` and `dist/styles.css`.
4. Click **Load** on `Electrosaur: Benday` (and optionally enable **Watch** while running `npm run watch -w @electrosaur-labs/benday-ps`).

---

## Build, Package & Test Commands

Run from the `benday/` monorepo root:

```bash
# Bundle production UXP plugin into packages/benday-ps/dist/
npm run build:ps

# Build production bundle and create packages/benday-ps/benday-v0.2.0.ccx
npm run package:ps

# Run headless DOM (jsdom) + mocked Photoshop bridge unit tests
npm run test:ps
```

Additional workspace scripts inside `packages/benday-ps/`:

```bash
# Unminified development build with source maps
npm run build:dev -w @electrosaur-labs/benday-ps

# Continuous rebuild on source changes
npm run watch -w @electrosaur-labs/benday-ps

# Remove dist/ directory
npm run clean -w @electrosaur-labs/benday-ps
```

---

## Plugin Architecture

| File | Responsibility |
|---|---|
| `manifest.json` | UXP v5 manifest (`0.2.0`) declaring command entrypoint `benday.showDialog` (`"Benday..."`) for Photoshop `>= 23.3.0`. |
| `src/index.js` | UXP entrypoint wiring `validateDocument` (single-layer CMYK & Already-Halftoned guards), pre-modal full-document `readFullCmykChannels` + flattened Benday XMP/binary guard (`isFlattenedBendayDocument`), clean default reset on document open & reread, `Save Config` / `Load Config` `-benday.json` file pickers (`uxp.storage.localFileSystem`), resizable modal `<dialog>` lifecycle (`1100 × 850`, including `reopenModalWithoutReread` Escape guard), and post-modal `commitHalftoneLayer`. |
| `src/state/BendayState.js` | Reactive UI/engine state managing SAATI `(TPI - µm)` presets + custom `(TPI / µm)` mode, `meshAngleDeg`, `ruleOfN` (default `5.0`), `lpiOverride`, `rosettePreset` (`Auto`, `Image-Aware`, `FTA +7.5°`, `ISO Litho`, `Flamenco 45°`, `Manual`), `anglesOverride`, `dotGain` (`0%–20%`), `bvg` (`Crisp Type & Linework`), tail mode, `previewScale` (`Fit / 50% / 100% / 200%`), `showingOriginal`, live `meshSpec`, and live `moireReport`. |
| `src/bridge/PhotoshopCmykBridge.js` | Lossless Photoshop CMYK channel bridge: pre-modal CMYK check, **Re-Run Guard** hiding prior `Benday Halftone*` layers (and re-enabling hidden source layers on the temporary duplicate so repeat runs never flatten to white), pure-`batchPlay` duplicate + flatten + `splitChannels`, title-verified channel classification (`_Cyan` / `_Magenta` / `_Yellow` / `_Black` suffix matching), `255 - gray` ink polarity conversion, `8-bit` & `16-bit` (`0 / 32768`) channel writeback, single-undo `suspendHistory("Benday Halftone")` commit onto a top CMYK pixel layer with per-layer `generatorSettings` + post-`resumeHistory` document `XMPMetadataAsUTF8` config embedding, and 3-gate `finally` cleanup of all temporary split documents. |
| `src/ui/BendayDialog.js` | Reveal-style two-column DOM controller and `<canvas>` renderer: `Fit` anti-aliased overview, `50% / 100% / 200%` scrollable `16 px`-halo viewport virtualization locked to global document lattice phase, click-drag panning, `< 2 ms` click-to-toggle **and** `>= 300 ms` hold-to-blink (`400 ms` alternation) `ORIGINAL` comparator, live 16-bit CIELAB `HVS ΔE` & `Gray Steps/Cell` telemetry, calibrated 8-corner trilinear SWOP Coated overprint LUT, and bottom **Screen Strip** (`Composite + C/M/Y/K` black-on-white film-positive swatches). |
| `src/ui/CreditsController.js` | Theatrical `24 px/sec` crawling **`★ Credits ★`** window (`dist/assets/electrosaur.png` emblem, 5-scene crawl dedicated to **Benjamin Henry Day Jr. (1879)**, clickable 1879 Ben Day Rapid Shading Medium Broadside Easter Egg, and 9 Algorithmic & Optical Legends). |

## Design Note: Why Single-Slider Dot Gain Instead of Multi-Point Tone Curves?

Benday intentionally omits multi-point curve editors inside the plugin dialog. Photoshop already provides non-destructive **Curves** adjustment layers, per-channel CMYK tone controls, and ICC profile conversion (`Edit → Convert to Profile...`). Keeping color grading and GCR/UCR in native Photoshop layers underneath your `Benday Halftone` layer keeps your `.psd` workflow transparent, while Benday's single **Extra Press Dot Gain (`0%–20%`)** slider applies a parabolic midtone pullback right before screen generation so your continuous-tone `Original` stays true and un-washed-out on screen.

For press usage, SAATI mesh selection, Rule of N, rosette angles, and tail modes, see the **[Benday User Guide](../../docs/USER-GUIDE.md)**.

## License

Apache-2.0 — see root [LICENSE](../../LICENSE).

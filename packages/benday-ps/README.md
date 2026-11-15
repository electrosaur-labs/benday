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

1. Build `packages/benday-ps/benday-v0.1.0.ccx` using `npm run package:ps` from the monorepo root (or download the release `.ccx`).
2. Double-click `benday-v0.1.0.ccx` to install via the Adobe Creative Cloud Desktop app (on macOS, if double-clicking does not launch the installer, drag the `.ccx` file onto the Creative Cloud Desktop app or Photoshop).
3. Open a CMYK document in Photoshop and choose **Plugins → Electrosaur: Benday → Benday...**.

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

# Build production bundle and create packages/benday-ps/benday-v0.1.0.ccx
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
| `manifest.json` | UXP v5 manifest declaring command entrypoint `benday.showDialog` (`"Benday..."`) for Photoshop `>= 23.3.0`. |
| `src/index.js` | UXP entrypoint wiring `validateDocument`, pre-modal full-document `readFullCmykChannels`, resizable modal `<dialog>` lifecycle (`1100 × 850`), and post-modal `commitHalftoneLayer`. |
| `src/state/BendayState.js` | Reactive UI/engine state managing SAATI `(TPI - µm)` presets + custom `(TPI / µm)` mode, `meshAngleDeg`, `ruleOfN` (default `5.0`), `lpiOverride`, `anglesOverride`, tail mode, `previewScale` (`Fit / 50% / 100% / 200%`), `showingOriginal`, live `meshSpec`, and live `moireReport`. |
| `src/bridge/PhotoshopCmykBridge.js` | Lossless Photoshop CMYK channel bridge: pre-modal CMYK check, **Re-Run Guard** hiding prior `Benday Halftone*` layers (and re-enabling hidden source layers on the temporary duplicate so repeat runs never flatten to white), pure-`batchPlay` duplicate + flatten + `splitChannels`, title-verified channel classification (`_Cyan` / `_Magenta` / `_Yellow` / `_Black` suffix matching), `255 - gray` ink polarity conversion, `8-bit` & `16-bit` (`0 / 32768`) channel writeback, single-undo `suspendHistory("Benday Halftone")` commit onto a top CMYK pixel layer while marking underlying original layer(s) hidden, and 3-gate `finally` cleanup of all temporary split documents. |
| `src/ui/BendayDialog.js` | Reveal-style two-column DOM controller and `<canvas>` renderer: `Fit` anti-aliased overview, `50% / 100% / 200%` scrollable `16 px`-halo viewport virtualization locked to global document lattice phase, click-drag panning, `< 2 ms` click-to-compare `ORIGINAL` swap, calibrated 8-corner trilinear SWOP Coated overprint LUT, and bottom **Screen Strip** (`Composite + C/M/Y/K` black-on-white film-positive swatches). |

## Design Note: Why No Tone Curves Inside Benday?

Benday intentionally omits built-in tone/dot-gain curve editors inside the plugin dialog. Photoshop already provides non-destructive **Curves** adjustment layers, per-channel CMYK tone controls, and ICC profile conversion (`Edit → Convert to Profile...`). Keeping curves in native Photoshop adjustment layers underneath your `Benday Halftone` layer keeps your `.psd` workflow transparent and non-destructive while Benday focuses strictly on calibrated halftone linearity and physical screen-mesh constraints.

For press usage, SAATI mesh selection, Rule of N, rosette angles, and tail modes, see the **[Benday User Guide](../../docs/USER-GUIDE.md)**.

## License

Apache-2.0 — see root [LICENSE](../../LICENSE).

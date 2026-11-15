# Benday User Guide

Benday is a mesh-aware CMYK halftone plugin for Adobe Photoshop (and a standalone command-line tool) built for screen printers.

## What Benday Does

Photoshop is the standard prepress workspace for CMYK color conversion, curve adjustments, dot-gain compensation, and retouching. However, Photoshop's built-in halftone tools (`Filter → Pixelate → Color Halftone` and `Image → Mode → Bitmap...`) are purely geometric: they know nothing about screen mesh count (threads per inch), thread diameter (micrometers), mesh open area, or the angle at which your mesh is stretched on the frame.

Without those physical constraints, standard digital halftones create three recurring problems in the screen shop:

1. **Highlight washout:** Fine highlight gradients taper down to 1-pixel dots smaller than a single mesh thread + knuckle. Those dots have nothing to anchor to on the stencil and wash away in the washout booth.
2. **Shadow plugging:** Deep 85–99% shadows narrow down to 1-pixel open pinholes smaller than a mesh opening. Emulsion and ink bridge across those pinholes on press, collapsing smooth shadow detail into flat solid puddles.
3. **Screen-to-mesh moiré:** Standard offset press angles (`15° / 45° / 75° / 0°`) put Yellow at `0°` — directly parallel to square-stretched mesh threads — or trigger higher-order 2D harmonic interference beats between the halftone ruling (LPI) and mesh weave (TPI).

Benday enhances Photoshop by computing your halftone screens directly from your physical mesh geometry and stretch angle, while keeping `100%` solid linework sharp at native 1-pixel resolution and locking `0%` paper margins completely clear.

---

## Requirements & Installation

- **Adobe Photoshop 23.3.0** (Photoshop 2022) or later on macOS or Windows
- A CMYK document (`8-bit` or `16-bit` per channel) at print resolution (`300–1200 DPI` recommended)

### Installing the Plugin

1. Double-click `benday-v0.1.0.ccx` to install via the Creative Cloud Desktop app (or load `packages/benday-ps/dist/manifest.json` in the **Adobe UXP Developer Tool**).
2. In Photoshop, open your CMYK artwork and choose **Plugins → Electrosaur: Benday → Benday...**.

---

## Step 1: CMYK Profile Conversion Workflow

Benday operates strictly on **CMYK** documents. If you run **Plugins → Electrosaur: Benday → Benday...** with no document open or with an RGB, Lab, or Grayscale document active, Benday displays an alert and exits before opening the dialog.

Convert your artwork to CMYK deliberately **before** running Benday:

1. Finish your color grading in RGB or Lab, or build your file directly in CMYK.
2. Choose **Edit → Convert to Profile...** (preferred over `Image → Mode → CMYK Color` when you want explicit control over profile and rendering intent).
3. Select the **Destination Space** ICC profile suited to your shop's process inks, substrate, and total ink limit (for example, a custom press profile or a coated/uncoated standard profile with appropriate GCR and Total Area Coverage).
4. Check your document resolution under **Image → Image Size...**:
   - **`300 DPI`**: Practical floor for coarse-to-medium poster and garment meshes (`110–230 TPI`).
   - **`600 DPI` – `1200 DPI`**: Recommended for `230–420 TPI` process work so halftone dots and angles step smoothly without coarse pixel quantization.
   - Documents below `72 DPI` (or too coarse to resolve the minimum printable dot for your chosen mesh) are rejected with `ERR_DPI_TOO_LOW`.

Why profile conversion and tone curves stay in Photoshop: Photoshop's color engine handles ink separation, gray component replacement (GCR/UCR), and non-destructive **Curves** / dot-gain adjustment layers across your entire `.psd` stack. Benday deliberately omits built-in tone curves inside its modal dialog so your color and dot-gain edits remain live, inspectable Photoshop layers beneath your `Benday Halftone` layer while Benday focuses strictly on calibrated halftone linearity and physical screen-mesh constraints.

---

## Step 2: Choosing Your SAATI Mesh Roll (`TPI - µm`)

In the **Screen Mesh** section of the dialog, select your physical screen roll from the **Mesh (TPI - µm)** dropdown (`230-48 (32% open)` by default) or choose **`Custom (TPI / µm)…`** to enter any TPI (`40–600`) and thread diameter (`µm`) directly.

### Built-In Official SAATI Polyester Roll Catalog (`SAATI_MESH_PRESETS`)

Mesh manufacturers sell the same TPI in both standard monofilament (`T`) and high-open-area thin-thread (**`Hi-R`**) rolls. Because thread diameter changes open area dramatically even at the same TPI, Benday pairs `(TPI - µm)` directly in a single shop-ready catalog anchored to `230-48` (`32.0%` open area, `1.00×` reference):

| Preset (`TPI - µm`) | Type | Mesh Pitch (`µm`) | Clear Opening (`µm`) | Open Area (`%`) | Open-Area Scale (`×`) |
|---|---|---:|---:|---:|---:|
| `110-80` | Standard | `230.9` | `150.9` | `43%` (`42.7%`) | `0.87×` |
| `110-70` | `Hi-R` | `230.9` | `160.9` | `49%` (`48.6%`) | `0.81×` |
| `156-64` | Standard | `162.8` | `98.8` | `37%` (`36.8%`) | `0.93×` |
| `156-48` | `Hi-R` | `162.8` | `114.8` | `50%` (`49.7%`) | `0.80×` |
| `196-55` | Standard | `129.6` | `74.6` | `33%` (`33.1%`) | `0.98×` |
| `196-48` | `Hi-R` | `129.6` | `81.6` | `40%` (`39.6%`) | `0.90×` |
| `230-48` | Standard *(Ref)* | `110.4` | `62.4` | `32%` (`32.0%`) | `1.00×` |
| `230-40` | `Hi-R` | `110.4` | `70.4` | `41%` (`40.7%`) | `0.89×` |
| `280-40` | Standard | `90.7` | `50.7` | `31%` (`31.3%`) | `1.01×` |
| `280-34` | `Hi-R` | `90.7` | `56.7` | `39%` (`39.1%`) | `0.90×` |
| `280-31` | `Hi-R` | `90.7` | `59.7` | `43%` (`43.3%`) | `0.86×` |
| `305-40` | Heavy | `83.3` | `43.3` | `27%` (`27.0%`) | `1.09×` |
| `305-34` | Standard | `83.3` | `49.3` | `35%` (`35.0%`) | `0.96×` |
| `305-31` | `Hi-R` | `83.3` | `52.3` | `39%` (`39.4%`) | `0.90×` |
| `355-34` | Standard | `71.5` | `37.5` | `28%` (`27.5%`) | `1.08×` |
| `355-31` | `Hi-R` | `71.5` | `40.5` | `32%` (`32.1%`) | `1.00×` |
| `380-34` | Standard | `66.8` | `32.8` | `24%` (`24.1%`) | `1.15×` |
| `380-31` | `Hi-R` | `66.8` | `35.8` | `29%` (`28.8%`) | `1.05×` |
| `420-31` | Standard | `60.5` | `29.5` | `24%` (`23.8%`) | `1.16×` |
| `420-27` | `Hi-R` | `60.5` | `33.5` | `31%` (`30.6%`) | `1.02×` |

### Why Paired `(TPI - µm)` Matters on Press

- Standard `355-34` (`28%` open) tightens ink passage compared to `230-48` (`32%` open), so Benday scales halftone cell pitch and minimum dot diameter by `1.08×` ($\sqrt{f_{\text{ref}} / f_{\text{open}}}$).
- Switching to `355-31 Hi-R` (`32%` open) restores `1.00×` open-area parity with `230-48` while delivering finer screen ruling (`50.8 LPI` at `N = 7.0`, or `71.1 LPI` at `N = 5.0`).
- Selecting **`Custom (TPI / µm)…`** reveals custom **TPI** and **Thread (µm)** numeric fields for specialty rolls, stainless-steel wire cloth, or legacy inventory.

In addition to open-area scaling, Benday enforces an open-area-scaled **knuckle floor** equal to $(p_m + d_t)\sqrt{f_{\text{ref}} / f_{\text{open}}}$, ensuring no isolated dot is ever smaller than the span needed to bridge across a mesh opening onto adjacent threads.

---

## Step 3: Press-Room Rule of N (`2.0–10.0`) & Screen Ruling (`LPI`)

In **Aperture & Screen Ruling**, the **Rule of N** slider (`2.0` to `10.0` in `0.5` increments; default **`5.0`**) uses the true press-room definition: **how many open-area-compensated mesh threads span one halftone cell**:

$$p_{\text{cell,nat}} = \frac{N}{\text{TPI}}\sqrt{\frac{f_{\text{ref}}}{f_{\text{open}}}}, \qquad \text{LPI}_{\text{auto}} = \frac{1}{p_{\text{cell,nat}}} = \frac{\text{TPI}}{N \cdot \sqrt{f_{\text{ref}} / f_{\text{open}}}}$$

From that cell pitch, Benday sets the minimum printable highlight dot and shadow hole diameter to the larger of a `12%` reference dot (`tRef = 0.12`) and the open-area-scaled knuckle span:

$$d_{\min} = \max\!\left((p_m + d_t)\sqrt{\frac{f_{\text{ref}}}{f_{\text{open}}}},\; \sqrt{\frac{4\,t_{\text{ref}}}{\pi}}\,p_{\text{cell,nat}}\right)$$

### Choosing `N` for Your Shop

- **`N = 4.0 – 4.5` (High-precision shop setup):** High-tension aluminum/roller frames (`25+ N/cm`), capillary film or dialed-in photopolymer/dual-cure emulsion with low Rz, LED/metal-halide point-source exposure, smooth coated stock (`230-48` at `N = 4.5` → **`51.1 LPI`**).
- **`N = 5.0` (Default — Everyday press-room baseline):** Classic `TPI ÷ 5` rule with open-area compensation (`230-48` at `N = 5.0` → **`46.0 LPI`**; `305-34` at `N = 5.0` → **`63.8 LPI`**).
- **`N = 6.0 – 7.0` (Fine-mesh / high-TPI comfort zone):** Popular for `305–420 TPI` process work or garments where you want extra emulsion shoulder safety (`355-31 Hi-R` at `N = 7.0` → **`50.8 LPI`**).
- **`N = 8.0 – 10.0` (Bold graphic Benday dots):** Coarse vintage comic/poster aesthetic (`156-64` at `N = 8.0` → **`20.9 LPI`**) or textured substrates that hold effortlessly on press.
- **`N = 2.0 – 3.5`:** Aggressive fine-screen limit approaching the physical knuckle floor; use only for controlled exposure step-wedges or specialized flatstock setups.

### Auto LPI vs. LPI Override

- **Auto LPI (`lpiNatural`):** Leave **LPI Override** blank (`Auto`). Benday calculates the exact open-area-compensated ruling (`46.0 LPI` for `230-48 @ N=5.0`, `51.8 LPI` for `230-40 Hi-R @ N=5.0`, `65.9 LPI` for `355-34 @ N=5.0`).
- **LPI Override:** Type a specific LPI (for example `45` or `55`) if a job spec requires a fixed line screen. Benday checks your manual LPI against **`lpiMax`** — the physical ceiling where a minimum-size dot $B_{D_{\min}}$ already fills `50%` of the halftone cell (or hits discrete pixel resolution limits). If your manual LPI exceeds `lpiMax`, Benday shows `ERR_LPI_EXCEEDS_MESH_LIMIT` and disables **Apply Halftone** until you lower LPI or click **↺** (`Reset to Auto LPI`).

Watch the live **Physics Telemetry** strip in the right sidebar as you adjust Mesh, Rule of N, or LPI:
- **Open Area:** Mesh open percentage and open-area multiplier.
- **Min Dot / Hole:** Exact discrete diameter in pixels (`px`), micrometers (`µm`), percentage of cell area, and pixel area (`px²`).
- **AM Range:** The continuous Euclidean AM tonal span (`tMin% – tMax%`) and cell pitch in pixels.

---

## Step 4: Bias-Stretched Mesh Angle (`θ`) & ±2° Stretcher Slop Immunity

Square-stretched screens align warp and weft threads with the frame at **`0°`** (and `90°`). Some shops stretch mesh on a bias (for example `7.5°`, `15°`, or `22.5°`) to change squeegee travel across knuckles or avoid `0°` rulings.

Set **Mesh Bias (°)** (`0°` to `89.5°` in `0.5°` steps; default `0°`) to match how your screens are stretched on the frame. Because square plain-weave mesh has 4-fold `90°` symmetry, Benday normalizes all angles into `[0°, 90°)` and centers your mesh angle `θ` dead-center inside the empty `30°` pocket of the CMYK rosette:

- **Cyan:** `θ + 15° (mod 90°)` — `15°` at `θ = 0°`
- **Black:** `θ + 45° (mod 90°)` — `45°` at `θ = 0°`
- **Yellow:** `θ + 60° (mod 90°)` — `60°` at `θ = 0°`
- **Magenta:** `θ + 75° (mod 90°)` — `75°` at `θ = 0°`

Why this layout matters on press:

1. **Classic `30°` strong-ink separation:** Cyan, Black, and Magenta sit exactly `30.0°` apart (`15°`, `45°`, `75°`), forming a stable CMYK rosette without channel-to-channel moiré, while light Yellow bisects Black and Magenta at `15.0°` (`60°`).
2. **Zero `0°` Yellow clash:** Unlike offset press defaults that place Yellow at `0°` right on top of the mesh warp threads, every screen in Benday sits at least **`15.0°`** away from both warp and weft threads.
3. **`±2.0°` stretcher slop immunity:** In real screen rooms, pneumatic and mechanical stretchers vary by `±1°` to `±2°` as frames tension and relax. Because `15.0°` nominal clearance leaves a wide safety margin, every screen maintains **`>= 13.0°`** thread clearance even if a frame lands `±2.0°` off your target bias angle.

If you manually edit individual **Cyan**, **Magenta**, **Yellow**, or **Black** angle boxes, Benday re-runs the moiré analyzer immediately. Click **Auto from Mesh°** at any time to restore the bias-centered rosette.

---

## Step 5: Highlight / Shadow Tail Modes

Within the **AM Range** shown on the Physics Card (`tMin` to `tMax`, where `tMax = 1 - tMin`), Benday renders symmetric **Euclidean** halftone cells: circular positive dots in highlights (`0` to `39.3%`), round-cornered diamond transitions touching into a crisp `50%` checkerboard at midtone, and circular open holes in shadows (`60.7%` to `100%`).

Outside that AM range — in delicate highlights (`0% < tone < tMin`) and deep shadows (`tMax < tone < 100%`) — an ordinary Euclidean dot or hole would shrink below your physical mesh floor $D_{\min}$. **Highlight / Shadow Tail Mode** controls how Benday handles those extreme tails:

| Mode | How Highlights (`0 < t < tMin`) Print | How Shadows (`tMax < t < 100%`) Print | Best Used For |
|---|---|---|---|
| **Hybrid AM/FM** *(Default)* | Diffuses tone across neighboring tail cells using serpentine Floyd-Steinberg error diffusion, stamping only full-size $B_{D_{\min}}$ dots at spaced intervals. | Diffuses open area across neighboring shadow cells, clearing only full-size $B_{D_{\min}}$ holes so shadows roll smoothly into `100%` solid without plugging. | Photographic CMYK work, soft vignettes, gradients fading to paper white, and deep tonal shadows. |
| **Cutoff** | Drops any cell below `tMin` cleanly to `0%` clear paper. | Fills any cell above `tMax` cleanly to `100%` solid ink. | Hard-edged graphic illustrations, comic coloring, or jobs requiring strictly periodic AM grids with zero FM scatter at fade-outs. |
| **Clamp** | Places one full-size $B_{D_{\min}}$ minimum dot in every non-zero highlight cell. | Holds one full-size $B_{D_{\min}}$ open hole in every non-solid (`< 255`) shadow cell. | Press calibration wedges, holding faint tint blocks uniformly, or preventing shadow fill-in before `100%` solid. |

In **all three modes**, no non-solid dot or enclosed halftone hole is ever smaller than your physical $B_{D_{\min}}$ disk.

---

## 100% Solid Linework & 0% Paper Guarantees

Process artwork frequently combines continuous-tone photography with crisp black type, borders, logos, or crop/registration marks on the same channels. Benday protects both extremes automatically:

- **100% Solid Linework Sovereignty:** Every pixel in a source channel with `100%` ink (`255`) bypasses halftone cell averaging and stamps directly onto the output screen at native 1-pixel resolution. Fine type, 1-pixel rules, registration crosshairs, and pure `{0, 255}` enclosed letter counters (such as the open eye of a lowercase `e` or `a` in `100% K` text) print with sharp continuous edges — never notched by halftone dots and never plugged shut by shadow-hole morphology.
- **0% Paper Lock:** Pure `0%` paper areas (`0` ink) are locked to `0`. Even in **Hybrid AM/FM** and **Clamp** modes, Benday checks every candidate minimum-dot stamp against positive source ink so error diffusion can never push stray "scum" dots out onto clean paper margins.

---

## Using the Live Preview & Re-Running Non-Destructively

### Inspecting the Scrollable Preview (`Fit / 50% / 100% / 200%`)

The left workspace of the resizable `1100 × 850` dialog previews your full document using calibrated **SWOP Coated** trilinear overprint proofing (shared identically between the continuous-tone `ORIGINAL` view and the `Halftone` proof so colors never shift when comparing):

- **Zoom (`Fit | 50% | 100% | 200%`):** Use the header Zoom selector, the `−` / `+` buttons, or keyboard shortcuts **`Cmd/Ctrl + 0`** (`Fit`), **`Cmd/Ctrl + 1`** (`100%`), and **`Cmd/Ctrl + +`/`−`** to zoom in and out.
  - **`Fit`:** Anti-aliased full-canvas tonal overview (free of artificial sub-pixel binary Nyquist moiré).
  - **`50% / 100% / 200%`:** True binary `{0, 255}` halftone dots rendered via `16 px`-halo viewport virtualization locked to your global document screen lattice — scrolling or panning never causes dots to swim relative to your artwork.
- **Scroll & Click-Drag Pan:** When zoomed in (`50%`, `100%`, `200%`), use scrollbars/trackpad or click-and-drag directly on the canvas to inspect highlights, skin tones, fine type, and deep shadows anywhere on the sheet.
- **Zero-Lag Click-to-Compare (`ORIGINAL`):** Click (without dragging) anywhere on the preview canvas to toggle instantaneously (`< 2 ms`) between **`ORIGINAL`** continuous-tone artwork and the **`Halftone`** preview.
- **Bottom Screen Strip (`Composite | C | M | Y | K`):** Click **C**, **M**, **Y**, or **K** in the bottom swatch strip to solo any individual screen as a crisp black-on-white film positive (`100%` dot = black, `0%` clear film = white) along with its live screen angle; click **Composite** (or click the active screen swatch again, or press **`Esc`**) to return to the 4-color proof. Pressing **`Esc`** in **Composite** view cancels and closes the dialog without modifying your document.

### Non-Destructive Layer Output & Re-Run Guard

Clicking **Apply Halftone** never flattens or overwrites your original layers:

1. Benday creates a single new CMYK pixel layer at the very top of your layer stack named with your exact press spec, for example:
   `Benday Halftone (230 TPI · 46.0 LPI · N=5)`
2. Each channel (**Cyan**, **Magenta**, **Yellow**, **Black**) of that layer contains pure discrete `{0%, 100%}` halftone pixels (`8-bit` or `16-bit` matching your document).
3. Your underlying original layer(s) are automatically marked **not visible** (hidden, never deleted) so only the newly generated halftone layer is visible cleanly on canvas.
4. The entire commit (creating/replacing the halftone layer and hiding the source layer(s)) is wrapped in a single Photoshop history state (**Edit → Undo Benday Halftone**).

**Re-running with different settings:** You do not need to delete the previous `Benday Halftone (...)` layer or manually unhide your source artwork before running Benday again (or clicking **Reread Document**). Benday's **Re-Run Guard** automatically hides any existing `Benday Halftone*` layers on its temporary read duplicate, re-enables your underlying continuous-tone source layer(s) on that duplicate if they were hidden by an earlier run, and replaces the previous `Benday Halftone*` layer cleanly when you click **Apply Halftone**.

---

## Troubleshooting Moiré Badges, Warnings & Errors

### Rosette & Moiré Status Badges

Every time you change **Mesh (TPI)**, **Thread (µm)**, **Mesh Bias (°)**, **LPI**, or **CMYK Rosette (°)**, Benday sweeps `θ ± 2.0°` in `0.5°` steps and checks both direct thread angles and 2D reciprocal-lattice harmonic beats (`|j|, |k| <= 8` vs. mesh harmonics `|m1|, |m2| <= 4`):

| Badge | Code | Meaning | How to Fix |
|---|---|---|---|
| **ROSETTE SAFE** | *(none)* | All 4 screens maintain safe thread clearance across `±2.0°` stretcher slop, strong inks (`C`, `M`, `K`) are safely separated, and all 2D harmonic beats fall below visibility thresholds. | Ready to burn screens. |
| **HARMONIC BEAT** | `WARN_HARMONIC_MOIRE` | Thread angle clearance is adequate, *but* a higher-order 2D screen harmonic beats against a mesh weave harmonic with contrast `>= 1.5%` and beat period `>= 5.1 mm` (for example, a Pythagorean `(-4, 3)` angle near `36.9°` or an LPI ratio resonant with TPI). The detail line identifies the exact channel, peak contrast `%`, and beat period in `mm`. | Click **Auto** on LPI Override (or nudge manual LPI up/down by `1–3 LPI`), or click **Auto from Mesh°** to re-center the rosette. |
| **SEVERE MOIRÉ** | `WARN_SEVERE_MOIRE` | A screen sits within `< 7.5°` of the mesh threads inside the `±2.0°` slop window, two strong inks (`C`, `M`, `K`) sit within `< 7.5°` of each other, or a strong beat (`>= 3.0%` contrast with period `>= 6.4 mm`) is present. | Click **Auto from Mesh°** to restore `30°` strong-ink spacing and `15°` mesh clearance, and avoid manual LPI values that divide your Mesh TPI evenly. |

### Geometry & Resolution Warnings / Errors

- **`WARN_LOW_DPI`:** Document resolution is below `300 DPI` or cell pitch is `< 5.0 px`. Halftones will still pass physical mesh floors, but tonal gradations will have fewer discrete gray steps. Resample your CMYK document to `600 DPI` via **Image → Image Size...** for smoother gradations.
- **`WARN_NARROW_AM_RANGE`:** Minimum dot area `tMin` exceeds `25%` of the halftone cell (`AM Range` narrower than `25% – 75%`), usually caused by a high manual **LPI Override** or aggressive **Rule of N** on a coarse DPI grid. Reset **LPI Override** to **Auto**, adjust **Rule of N**, or resample your document to `600 DPI`.
- **`ERR_LPI_EXCEEDS_MESH_LIMIT`:** Your manual **LPI Override** exceeds `lpiMax` — a single minimum dot $B_{D_{\min}}$ would be larger than a `50%` halftone cell. Click **Auto** next to LPI Override or enter a value at or below the displayed `max` LPI.
- **`ERR_DPI_TOO_LOW`:** Document DPI is below `72 DPI` or too coarse to resolve `dMin` / natural LPI for your chosen mesh. Increase document resolution (`300–600+ DPI`) in **Image → Image Size...**.
- **`ERR_INVALID_MESH_GEOMETRY`:** Custom **Thread (µm)** closes or chokes the mesh below `2%` open area, or parameters are out of bounds. Select a standard SAATI `(TPI - µm)` preset from the **Mesh** dropdown.

---

## Pre-Flight Verification from the Command Line

If you archive separated TIFFs or automate prepress pipelines, you can independently audit any 1-channel or 4-channel halftone file with the Benday CLI (`@electrosaur-labs/benday-cli`):

```bash
# Audit a 4-channel CMYK halftone TIFF against 230 TPI / N=5.0 physics
npm run benday -- verify output-cmyk.tif --src source-cmyk.tif --mesh 230 --n 5.0 --json
```

`benday verify` exits with code `0` (`PASS`) only when every pixel is strictly binary `{0, 255}`, every halftone dot and enclosed shadow hole satisfies $B_{D_{\min}}$ openness (`minDotViolations === 0` and `minHoleViolations === 0`), every `100%` solid pixel is preserved, and `0%` paper has zero stray ink bleed. See the [CLI Reference](../packages/benday-cli/README.md) for full details.

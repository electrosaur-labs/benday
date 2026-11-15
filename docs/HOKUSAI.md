# Electrosaur: Hokusai — Direct Inkjet Film-Positive Spooler ("RIP Killer")

> **Living Specification & Feature Backlog**  
> **Dedication:** *Dedicated to William Henry Fox Talbot (1800–1877), whose 1852 patent for exposing dichromated emulsion to actinic UV light through woven black silk gauze laid the physical foundation for screen-print stencil exposure.*  
> **Status:** **Concept & Architecture Recorded** (Deferred until live hardware calibration on physical waterproof film; `Benday v0.2` takes immediate priority.)

---

## 1. Naming, Dedication & Place in the Electrosaur Suite

### Why "Hokusai" — Dedicated to William Henry Fox Talbot
Named after **Katsushika Hokusai** (1760–1849), iconic master of printmaking whose razor-sharp pure black *sumi*-ink master sheets on translucent paper (*hanshita-e*) with precision *kento* registration marks governed every multi-color print before a single color block touched paper. And **dedicated to William Henry Fox Talbot** (1800–1877), who in **1852** patented *photoglyptic engraving* using woven silk gauze + UV-hardened colloid — the direct historical ancestor of actinic screen exposure (mirroring **Reveal**'s dedication to Doug Minkler).

Paired with **Reveal** and **Benday** (*Benjamin Henry Day*, 1879), the three tools form a complete, end-to-end screen-printing prepress foundry:

1. **Reveal:** Image → Perceptual `16-bit CIELAB` spot-color separation & trapping (`3–12` intentional spot screens).
2. **Benday:** Continuous tone → Mesh-aperture-governed `{0, 255}` halftone dots (`Rule of N`, thread/knuckle floor, zero mesh moiré — built both for fast `4`-screen CMYK runs when time is tight and as a physically honest process baseline to compare against spot separations).
3. **Hokusai:** Binary `{0, 255}` screens → Raw per-nozzle inkjet droplets on clear waterproof film, bypassing OS print drivers and proprietary \$500/yr RIPs.

### Alternate Name Candidates Recorded
- **`Talbot`** (*William Henry Fox Talbot*, 1800–1877): Honored as the official dedication of **Hokusai**.
- **`Dürer`** (*Albrecht Dürer*, 1471–1528): Master of rendering full tonal range and volume strictly through binary black ink line/dot density.
- **`Escher`** (*M.C. Escher*, 1898–1972): Master printmaker, set aside because the name evokes geometric tessellations rather than film output.
- **`Sumi` / `Carbon` / `Actinic` / `Burn`:** Pure carbon-black `Dmax` ink, *carbon tissue* stencils, and `365–405 nm` actinic UV exposure.

### Strategic Timing Note
- **Adoption / Traction Hook:** Nearly every screen shop resents paying \$500+ or annual subscriptions (AccuRIP, FilmMaker) just to stop macOS/Windows from blurring `1-bit` film positives and to fire all-black ink cartridges. Releasing **Hokusai** alongside **Benday** is a high-leverage traction magnet for working screen printers.
- **Sequencing:** Because picoliter droplet bleed, drying time on microporous coating, and real UV optical density ($D_{\text{UV}}$) cannot be verified by unit tests alone, implementation waits until we calibrate directly against a physical shop printer and exposure unit. Meanwhile, we collect every feature and hardware note for **Hokusai** in this document as we go.

---

## 2. The Problem Hokusai Solves

Even when **Reveal** or **Benday** outputs a mathematically exact `{0, 255}` screen, standard OS printing corrupts it at the last mile:

1. **OS Driver Resampling & Re-Dithering:** macOS AirPrint, IPP Everywhere, Apple `URF` / `PWG Raster`, and vendor RGB drivers convert `1-bit` screens to `8-bit sRGB`, resample across non-integer DPI ratios (e.g. `300/600 DPI` → `720 DPI`), apply ColorSync/ICC profiles, and run firmware error-diffusion dithering on top — softening dot edges, creating secondary beat moiré, and scattering stray dots into `0%` clear film.
2. **Why `PostScript` and `PCL5` Do Not Solve Inkjet Film Output:**
   - `PostScript` and `PCL5` / `PCL6` target laser printers and imagesetters. Almost no shop inkjet speaks `PostScript` or `PCL5` natively, and laser fuser heat shrinks polyester/vellum unequally across films (ruining multi-screen registration) while laser toner lacks UV `Dmax` (`< 2.8`).
3. **Why Raw `ESC/P2` Is Required (and `ESC/P-R` Fails):**
   - Inkjet printheads use low-level host raster languages: **Epson `ESC/P2` Raster (`ESC i`)**, **HP `PCL3GUI` / `HP-RTL`**, and **Canon `BJL` Raster**.
   - `ESC/P2` is *not* uniform across Epson models: the host must know exact nozzle counts (`180`, `360`, `400`), vertical nozzle pitch (`1/180"`, `1/360"`), soft-weave pass interleaving, micro-step paper advances (`ESC ( v`), model-specific `2-bit` droplet waveform hex IDs, and binary Remote Mode initialization packets.
   - Epson's newer cross-model **`ESC/P-R`** language unified models by moving the abstraction *above* the halftoner (`8-bit sRGB` in, closed firmware screening out) — fatal for `1-bit` film positives and per-slot black ink control.

---

## 3. Core Architecture: The Headless `libgutenprint` Loophole

`Gutenprint` (`libgutenprint`) already built the missing UNIX `terminfo`-style abstraction layer: a shared C `ESC/P2` soft-weave & packetizer engine (`print-escp2.c`) driven by declarative XML hardware descriptors (`model_*.xml`, ink slot maps, and picoliter drop LUTs).

Gutenprint abandoned official macOS driver packages because maintaining a **system-wide OS print driver** for `3,500+` printers required Cocoa Print Dialog Extensions (PDEs), annual Apple Developer ID / Notarization upkeep, and rewriting classic `/Library/Printers` CUPS PPD filters into `PAPPL` localhost IPP servers.

**Hokusai bypasses 100% of the OS print stack:**
- Compiles `libgutenprint`'s portable POSIX C core + curated XML model tables as a standalone `arm64` / `x86_64` headless binary (`hokusai` CLI / sidecar daemon) using **`Dither Algorithm = Predithered`**.
- Streams raw hardware bytes straight to the printer with zero OS pixel modification via:
  1. **CUPS raw pass-through:** `lp -d <printer> -o raw job.escp2`
  2. **Direct TCP Port `9100` (AppSocket / JetDirect)** over Ethernet/Wi-Fi
  3. **Direct USB bulk endpoint (`libusb`)**

---

## 4. Feature Backlog (Add Items Here As We Go)

### A. Hardware Spooling & Ink Control
- [ ] **Zero-Resample Native Printhead Grid Rendering:** Drive screens at exact printhead addressability (`720 × 720`, `720 × 1440`, `1440 × 1440`, `1440 × 2880` DPI on Epson; `600 × 600` / `1200 × 1200` DPI on Canon/HP) via Benday's native anisotropic `(dpiX, dpiY)` engine.
- [ ] **Droplet-Weight / UV Density ($D_{\text{UV}}$) Dial:** Direct `2-bit` picoliter drop selection (**Small / Medium / Large** drops + pass-density duty cycle) to hit $D_{\text{UV}} \ge 3.8\text{–}4.2$ just below waterproof film coating saturation/pooling.
- [ ] **Calibration Test Strip Wizard:** Single-command `hokusai calibrate` printing a 1-page droplet-weight × pass-count matrix with `1 px` positive/negative hairlines and $B_{D_{\min}}$ dots so a shop dials in a new box of film in 5 minutes on their exposure unit.
- [ ] **Multi-Slot "All-Black" Cartridge Fan-Out:** Fire a single `1-bit` screen across any selected combination of physical ink slots (`K, C, M, Y, LC, LM, LK, LLK`) for shops running all-black UV dye kits.
- [ ] **Single-Click Clogged-Nozzle Failover:** Remap film output away from a clogged channel onto remaining clean slots mid-production so a dead Cyan or Magenta damper never halts film output.
- [ ] **OEM Pigment UV-Blocking Mix Mode (Dual-Purpose Printers):** For printers kept on standard OEM pigment sets (e.g. **Epson Stylus Pro `3880`**), fire calibrated multi-channel near-UV-blocking mixes (`PK + Y + LK/C`, leveraging Yellow pigment's strong `365–405 nm` absorption) without exceeding film dry-time limits.

### B. Supported Printer Matrix & Hardware Honesty
- [ ] **Curated ~10-Printer Screen-Shop Matrix:** Focus strictly on proven `ESC/P2`-capable shop workhorses rather than `3,500` office printers:
  - Epson Stylus Pro `3880` / `4880` / `4900`
  - Epson Artisan `1430` / Stylus Photo `1400`
  - Epson SureColor `P800` / `SC-T3170x`
  - Epson `XP-15000` & verified raw-`ESC/P2` EcoTank models
- [ ] **Explicit `ESC/P-R`-Only Blocklist / Buyers' Guide:** Clearly flag modern consumer inkjets whose firmware stripped raw per-nozzle `ESC/P2` so printmakers never buy a bricked-for-film printer by mistake.

### C. Film Layout, Press Furniture & Workflow Integration
- [ ] **Automated Registration Crosshairs & Center Marks:** Stamp identical `1 px`-accurate registration targets across all `N` spot (`Reveal`) or `4` CMYK (`Benday`) films with configurable bleed/trim offsets.
- [ ] **Human-Readable Screen Slugs:** Auto-typeset crisp `1-bit` identification slugs in the film margin (`Job · Ink/Channel · SAATI 230-48 · 46.0 LPI · 15.0° · N=5.0 · Drop Recipe · Timestamp`).
- [ ] **On-Film Exposure & Washout Control Wedge:** Optional strip along the film edge carrying `2%–95%` tone patches and positive/negative $B_{D_{\min}}$ test dots to verify screen burn and washout on every stencil.
- [ ] **Roll & Sheet Film Ganging / Nesting:** Pack multiple small separations (left-chest logos, neck tags, edition colophons, or multi-screen smaller prints) onto `13" × 19"` sheets or `17"` / `24"` roll film to save waterproof film cost.
- [ ] **One-Click Bridge from `Reveal` & `Benday` + `1-Bit` Bilevel TIFF Archive:** Direct handoff from Photoshop UXP / Krita / CLI (`reveal → hokusai`, `benday → hokusai`), plus standalone bit-packed `1-bit` PackBits/Deflate TIFF export for offline archiving.
- [ ] **Dedication Easter Egg / Credits Tribute:** Honor **William Henry Fox Talbot** (1852 silk-gauze actinic stencil pioneer) alongside Hokusai's *hanshita-e* master-sheet craft.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { JSDOM } from 'jsdom';

import BendayState from '../src/state/BendayState.js';
import { BendayDialog, renderPreviewRgba } from '../src/ui/BendayDialog.js';
import { encodeRgbaToPngDataUrl, encodeRgbaToPngBytes } from '../src/utils/pngDataUrl.js';

/**
 * Helper: parse PNG dimensions and inflate IDAT payload from a `data:image/png;base64,...` URL.
 */
function inspectPngDataUrl(dataUrl) {
  expect(typeof dataUrl).toBe('string');
  expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  const b64 = dataUrl.slice('data:image/png;base64,'.length);
  const buf = Buffer.from(b64, 'base64');

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  expect(Array.from(buf.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  // First chunk IHDR
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];

  // Locate IDAT chunk(s)
  let offset = 8;
  const idatChunks = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IDAT') idatChunks.push(data);
    if (type === 'IEND') break;
    offset += 12 + len;
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  return { width, height, bitDepth, colorType, inflated };
}

describe('BendayState, pngDataUrl & Reveal-Style BendayDialog UI', () => {
  it('encodes lossless 8-bit RGBA PNG data URLs verified via zlib.inflateSync round-trip', () => {
    const W = 60;
    const H = 90;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        rgba[o] = (x * 4) & 0xff;
        rgba[o + 1] = (y * 2) & 0xff;
        rgba[o + 2] = ((x + y) * 3) & 0xff;
        rgba[o + 3] = 255;
      }
    }

    const pngBytes = encodeRgbaToPngBytes(rgba, W, H);
    expect(pngBytes.length).toBeGreaterThan(W * H * 4);

    const dataUrl = encodeRgbaToPngDataUrl(rgba, W, H);
    const info = inspectPngDataUrl(dataUrl);
    expect(info.width).toBe(W);
    expect(info.height).toBe(H);
    expect(info.bitDepth).toBe(8);
    expect(info.colorType).toBe(6);
    expect(info.inflated.length).toBe(H * (1 + W * 4));

    for (let y = 0; y < H; y++) {
      const rowStart = y * (1 + W * 4);
      expect(info.inflated[rowStart]).toBe(0);
      const rowPixels = info.inflated.subarray(rowStart + 1, rowStart + 1 + W * 4);
      expect(Buffer.compare(rowPixels, Buffer.from(rgba.buffer, y * W * 4, W * 4))).toBe(0);
    }
  });

  it('manages SAATI (TPI-µm) presets (355-31 factory default), Rule of N = 5.0 default, custom thread locks, and viewZoom ladder', () => {
    const defaultState = new BendayState({ dpi: 600 });
    expect(defaultState.meshTpi).toBe(355);
    expect(defaultState.threadDiaUm).toBe(31);
    expect(defaultState.getMeshPresetId()).toBe('355-31');
    expect(defaultState.isModified()).toBe(false);
    expect(defaultState.meshSpec.lpiNatural).toBeCloseTo(71.17, 2);

    const state = new BendayState({ meshTpi: 230, dpi: 600 });
    expect(state.ruleOfN).toBe(5.0);
    expect(state.threadDiaUm).toBe(48);
    expect(state.getMeshPresetId()).toBe('230-48');
    expect(state.previewZoom).toBe(0); // Loupe disabled by default
    expect(state.viewZoom).toBe('fit');
    expect(state.isModified()).toBe(true); // 230-48 differs from 355-31 factory default
    expect(state.meshSpec.lpiNatural).toBeCloseTo(46.0, 3);
    expect(state.meshSpec.dMinPx).toBe(5);

    // Select SAATI 355-31 Hi-R factory preset -> unmodified!
    state.setMeshPreset(355, 31);
    expect(state.getMeshPresetId()).toBe('355-31');
    expect(state.isModified()).toBe(false);

    // Custom heavy 40 µm roll on 355 TPI -> preset becomes 'custom'
    state.setThreadDiaUm(40);
    expect(state.getMeshPresetId()).toBe('custom');
    expect(state.threadDiaLocked).toBe(true);
    expect(state.meshSpec.openAreaScale).toBeCloseTo(1.282, 2);

    state.setMeshTpi(305);
    expect(state.threadDiaUm).toBe(40);
    state.resetThreadDiaAuto();
    expect(state.threadDiaLocked).toBe(false);
    expect(state.threadDiaUm).toBe(34);
    expect(state.getMeshPresetId()).toBe('305-34');

    // Zoom ladder: fit -> 0.5 -> 1 -> 2 -> 1 -> 0.5 -> fit
    state.zoomIn();
    expect(state.viewZoom).toBe(0.5);
    state.zoomIn();
    expect(state.viewZoom).toBe(1);
    state.zoomIn();
    expect(state.viewZoom).toBe(2);
    state.zoomOut();
    expect(state.viewZoom).toBe(1);

    state.resetToDefaults();
    expect(state.meshTpi).toBe(355);
    expect(state.threadDiaUm).toBe(31);
    expect(state.ruleOfN).toBe(5.0);
    expect(state.viewZoom).toBe(1); // View magnification preserved across parameter reset
    expect(state.isModified()).toBe(false);
  });

  it('updates CMYK rosette angles from meshAngleDeg and detects moiré on unsafe manual overrides', () => {
    const state = new BendayState({ meshTpi: 230, dpi: 600, meshAngleDeg: 18 });
    expect(state.angles).toEqual({ C: 33, M: 3, Y: 78, K: 63 });
    expect(state.moireReport.safe).toBe(true);

    state.setChannelAngle('K', 18);
    expect(state.anglesOverride).not.toBeNull();
    expect(state.moireReport.safe).toBe(false);
    expect(state.moireReport.warnings).toContain('WARN_SEVERE_MOIRE');

    state.resetAnglesAuto();
    expect(state.anglesOverride).toBeNull();
    expect(state.moireReport.safe).toBe(true);
  });

  it('captures mesh/LPI physics errors cleanly without throwing', () => {
    const state = new BendayState({ meshTpi: 230, dpi: 600 });
    const lpiMax = state.meshSpec.lpiMax;

    state.setLpiOverride(lpiMax + 10);
    expect(state.error).not.toBeNull();
    expect(state.error.code).toBe('ERR_LPI_EXCEEDS_MESH_LIMIT');

    state.resetLpiAuto();
    expect(state.error).toBeNull();
    expect(state.meshSpec).not.toBeNull();
  });

  it('renders calibrated SWOP Coated Neugebauer CMYK composite proof and B&W single-screen film preview accurately', () => {
    // 9 test pixels: Paper, C, M, Y, C+M, C+Y, M+Y, C+M+Y, Rich Black (C+M+Y+K)
    const plates = {
      C: new Uint8Array([0, 255, 0, 0, 255, 255, 0, 255, 160]),
      M: new Uint8Array([0, 0, 255, 0, 255, 0, 255, 255, 128]),
      Y: new Uint8Array([0, 0, 0, 255, 0, 255, 255, 255, 128]),
      K: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 255]),
    };

    const comp = renderPreviewRgba(plates, 9, 1, 'composite');
    expect(Array.from(comp.slice(0, 4))).toEqual([255, 255, 255, 255]);   // Paper
    expect(Array.from(comp.slice(4, 8))).toEqual([0, 174, 239, 255]);     // SWOP Cyan #00AEEF
    expect(Array.from(comp.slice(8, 12))).toEqual([236, 0, 140, 255]);    // SWOP Magenta #EC008C
    expect(Array.from(comp.slice(12, 16))).toEqual([255, 242, 0, 255]);   // SWOP Yellow #FFF200
    expect(Array.from(comp.slice(16, 20))).toEqual([46, 49, 146, 255]);   // C+M #2E3192
    expect(Array.from(comp.slice(20, 24))).toEqual([0, 166, 81, 255]);    // C+Y #00A651
    expect(Array.from(comp.slice(24, 28))).toEqual([237, 28, 36, 255]);   // M+Y #ED1C24
    expect(Array.from(comp.slice(28, 32))).toEqual([38, 35, 36, 255]);    // C+M+Y #262324
    // Rich Black (K=255 + CMY undercolor) -> near #0A0A0A
    expect(comp[32]).toBeLessThanOrEqual(12);
    expect(comp[33]).toBeLessThanOrEqual(12);
    expect(comp[34]).toBeLessThanOrEqual(12);
    expect(comp[35]).toBe(255);

    const filmC = renderPreviewRgba(plates, 9, 1, 'C');
    expect(Array.from(filmC.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(filmC.slice(4, 8))).toEqual([0, 0, 0, 255]);
  });

  it('wires SAATI mesh dropdown, Custom row, Fit/50%/100%/200% zoom, zero-lag ORIGINAL toggle, and direct .visible clearing', async () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const win = dom.window;

    let appliedCount = 0;
    let cancelledCount = 0;
    const W = 60;
    const H = 90;
    const N = W * H;

    const state = new BendayState({
      docName: 'PortraitPoster.tif',
      docWidth: W,
      docHeight: H,
      dpi: 600,
    });
    const dialog = new BendayDialog(doc, state, {
      onApply: async () => {
        appliedCount++;
      },
      onCancel: () => {
        cancelledCount++;
      },
    });

    const resetBtn = doc.getElementById('btn-reset-top');
    const previewImg = doc.getElementById('preview-img');
    const previewContainer = doc.getElementById('preview-container');
    const meshPreset = doc.getElementById('input-mesh-preset');
    const customMeshRow = doc.getElementById('custom-mesh-row');
    const originalBadge = doc.getElementById('original-badge');
    const helpBtn = doc.getElementById('btn-help-toggle');

    // Reveal-style stacked 5-button top header: Reread, Reset, Save Config, Load Config, Halftone (no Cancel button)
    const headerBtnIds = Array.from(doc.querySelectorAll('#knobs-header button')).map((b) => b.id);
    expect(headerBtnIds).toEqual([
      'btn-reread',
      'btn-reset-top',
      'btn-save-config',
      'btn-load-config',
      'btn-benday-apply',
    ]);
    expect(doc.getElementById('btn-benday-apply').textContent).toBe('Halftone');

    expect(resetBtn.disabled).toBe(true);
    expect(meshPreset.value).toBe('355-31');
    expect(customMeshRow.classList.contains('visible')).toBe(false);
    expect(doc.getElementById('stat-mesh-lpi').textContent).toContain('71.2 LPI');
    expect(doc.getElementById('phys-open-area').textContent).toContain('32.1%');
    expect(doc.getElementById('moire-status-badge').textContent).toBe('ROSETTE SAFE');

    const chanC = new Uint8Array(N);
    const chanM = new Uint8Array(N);
    const chanY = new Uint8Array(N);
    const chanK = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        chanC[idx] = Math.round((x / (W - 1)) * 220);
        chanM[idx] = Math.round((y / (H - 1)) * 200);
        chanY[idx] = 32;
        chanK[idx] = x > 20 && x < 40 && y > 30 && y < 60 ? 255 : 24;
      }
    }

    dialog.setFullDocumentData({
      width: W,
      height: H,
      dpi: 600,
      channels: { C: chanC, M: chanM, Y: chanY, K: chanK },
    });

    expect(previewImg.style.display).toBe('block');
    const initialSrc = previewImg.getAttribute('src');
    const initialPng = inspectPngDataUrl(initialSrc);
    expect(initialPng.width).toBe(60);
    expect(initialPng.height).toBe(90);

    // Zero-lag click toggle between Halftone and ORIGINAL (uses direct .visible on #original-badge)
    expect(originalBadge.classList.contains('visible')).toBe(false);
    previewImg.click();
    expect(originalBadge.classList.contains('visible')).toBe(true);
    const origSrc = previewImg.getAttribute('src');
    expect(origSrc).not.toBe(initialSrc);
    previewImg.click();
    expect(originalBadge.classList.contains('visible')).toBe(false);
    expect(previewImg.getAttribute('src')).toBe(initialSrc);

    // SAATI mesh preset selection (230-40 Hi-R) & Custom (TPI / µm) inline row .visible toggle
    meshPreset.value = '230-40';
    meshPreset.dispatchEvent(new win.Event('change'));
    expect(state.meshTpi).toBe(230);
    expect(state.threadDiaUm).toBe(40);
    expect(customMeshRow.classList.contains('visible')).toBe(false);

    meshPreset.value = 'custom';
    meshPreset.dispatchEvent(new win.Event('change'));
    expect(customMeshRow.classList.contains('visible')).toBe(true);
    const customThread = doc.getElementById('input-thread-um');
    customThread.value = '38';
    customThread.dispatchEvent(new win.Event('input'));
    expect(state.threadDiaUm).toBe(38);
    expect(state.getMeshPresetId()).toBe('custom');

    doc.getElementById('btn-mesh-revert').click();
    expect(state.getMeshPresetId()).toBe('355-31');
    expect(customMeshRow.classList.contains('visible')).toBe(false);

    // Zoom controls: Fit -> 50% (30x45) -> 100% (60x90) -> 200% (120x180) + Cmd+0 shortcut
    const zoomSelect = doc.getElementById('preview-zoom');
    zoomSelect.value = '0.5';
    zoomSelect.dispatchEvent(new win.Event('change'));
    expect(previewContainer.classList.contains('is-zoomed')).toBe(true);
    expect(inspectPngDataUrl(previewImg.getAttribute('src')).width).toBe(30);
    expect(inspectPngDataUrl(previewImg.getAttribute('src')).height).toBe(45);

    doc.getElementById('btn-zoom-in').click(); // -> 100%
    expect(state.viewZoom).toBe(1);
    expect(inspectPngDataUrl(previewImg.getAttribute('src')).width).toBe(60);

    doc.getElementById('btn-zoom-in').click(); // -> 200%
    expect(state.viewZoom).toBe(2);
    expect(inspectPngDataUrl(previewImg.getAttribute('src')).width).toBe(120);
    expect(inspectPngDataUrl(previewImg.getAttribute('src')).height).toBe(180);

    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '0', metaKey: true }));
    expect(state.viewZoom).toBe('fit');
    expect(previewContainer.classList.contains('is-zoomed')).toBe(false);

    // Direct .visible toggle on .knob-help, #benday-warnings-box, and #benday-error-banner
    const helpBoxes = Array.from(doc.querySelectorAll('.knob-help'));
    expect(helpBoxes.length).toBeGreaterThanOrEqual(4);
    expect(helpBoxes.every((el) => !el.classList.contains('visible'))).toBe(true);
    helpBtn.click();
    expect(helpBoxes.every((el) => el.classList.contains('visible'))).toBe(true);

    // Trigger severe moiré warning -> #benday-warnings-box gets .visible AND style.display='block'
    const angleK = doc.getElementById('input-angle-k');
    angleK.value = '0';
    angleK.dispatchEvent(new win.Event('input'));
    const warningsBox = doc.getElementById('benday-warnings-box');
    const errorBanner = doc.getElementById('benday-error-banner');
    expect(warningsBox.classList.contains('visible')).toBe(true);
    expect(warningsBox.style.display).toBe('block');

    // Dragging Mesh Bias Angle clears stale manual anglesOverride and hides #benday-warnings-box
    const meshAngleInput = doc.getElementById('input-mesh-angle-num');
    meshAngleInput.value = '15';
    meshAngleInput.dispatchEvent(new win.Event('input'));
    expect(state.anglesOverride).toBeNull();
    expect(warningsBox.classList.contains('visible')).toBe(false);
    expect(warningsBox.style.display).toBe('none');

    // Re-trigger warning, then trigger LPI error -> warningsBox hides ('none'), errorBanner shows ('block')
    angleK.value = '15';
    angleK.dispatchEvent(new win.Event('input'));
    expect(warningsBox.style.display).toBe('block');

    const lpiInput = doc.getElementById('input-lpi-override');
    lpiInput.value = '999';
    lpiInput.dispatchEvent(new win.Event('input'));
    expect(warningsBox.classList.contains('visible')).toBe(false);
    expect(warningsBox.style.display).toBe('none');
    expect(errorBanner.classList.contains('visible')).toBe(true);
    expect(errorBanner.style.display).toBe('block');
    const btnLpiAuto = doc.getElementById('btn-lpi-auto');
    expect(btnLpiAuto.classList.contains('visible')).toBe(true);

    // Clicking #btn-lpi-auto clears the invalid LPI error cleanly (style.display='none')
    btnLpiAuto.click();
    expect(errorBanner.classList.contains('visible')).toBe(false);
    expect(errorBanner.style.display).toBe('none');
    expect(state.error).toBeNull();

    // Reset to Defaults restores N = 5.0, clears warnings AND clears .knob-help .visible!
    resetBtn.click();
    expect(state.ruleOfN).toBe(5.0);
    expect(resetBtn.disabled).toBe(true);
    expect(warningsBox.classList.contains('visible')).toBe(false);
    expect(warningsBox.style.display).toBe('none');
    expect(helpBoxes.every((el) => !el.classList.contains('visible'))).toBe(true);

    // Single-Escape dismiss: 1 Escape immediately invokes onCancel even when viewing a solo C/M/Y/K screen!
    doc.querySelector('[data-preview-mode="C"]').click();
    expect(state.previewMode).toBe('C');
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancelledCount).toBe(1);

    // Backward-compatible direct renderLoupeAtDocCoords(30, 45) unit-test hook
    const loupeUrl = dialog.renderLoupeAtDocCoords(30, 45);
    const loupePng = inspectPngDataUrl(loupeUrl);
    expect(loupePng.width).toBe(256);
    expect(loupePng.height).toBe(256);
    expect(doc.getElementById('loupe-coords').textContent).toBe('30, 45');

    doc.getElementById('btn-benday-apply').click();
    expect(appliedCount).toBe(1);

    dialog.destroy();
  });

  it('renders anti-aliased Fit preview without sub-pixel moiré and virtualizes zoomed viewport slices on large posters', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const W = 1200;
    const H = 1800;
    const N = W * H;
    const state = new BendayState({
      docName: 'BigPoster.tif',
      docWidth: W,
      docHeight: H,
      meshTpi: 230,
      dpi: 300,
    });
    const dialog = new BendayDialog(doc, state, {
      onApply: () => {},
      onCancel: () => {},
    });

    const ramp = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      ramp[i] = i % 256;
    }

    dialog.setFullDocumentData({
      width: W,
      height: H,
      dpi: 300,
      channels: {
        C: ramp,
        M: new Uint8Array(N).fill(64),
        Y: new Uint8Array(N).fill(16),
        K: new Uint8Array(N).fill(12),
      },
    });

    const previewImg = doc.getElementById('preview-img');
    const srcHybrid = previewImg.getAttribute('src');
    const pngInfo = inspectPngDataUrl(srcHybrid);
    expect(pngInfo.width).toBe(560);
    expect(pngInfo.height).toBe(840);

    // Changing Tail Mode to 'cutoff' visibly updates the Fit preview PNG
    doc.querySelector('[data-tail-mode="cutoff"]').click();
    const srcCutoff = previewImg.getAttribute('src');
    expect(srcCutoff).not.toBe(srcHybrid);

    // Switching to 200% zoom virtualizes the viewport crop instead of encoding a 2400x3600 PNG
    state.setViewZoom(2);
    const zoomedPng = inspectPngDataUrl(previewImg.getAttribute('src'));
    expect(zoomedPng.width).toBeLessThanOrEqual(900);
    expect(zoomedPng.height).toBeLessThanOrEqual(800);
    expect(doc.getElementById('preview-scroll-sizer').style.width).toBe('2400px');
    expect(doc.getElementById('preview-scroll-sizer').style.height).toBe('3600px');

    dialog.destroy();
  });

  it('keeps UXP entrypoint script and stylesheet tags present in src/index.html', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
    expect(html).toContain('<script src="index.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="styles.css" />');
  });
});

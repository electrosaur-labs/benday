import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { JSDOM } from 'jsdom';

import { createRequire } from 'module';
import BendayState from '../src/state/BendayState.js';
import {
  BendayDialog,
  MAX_FIT_SUPER_EDGE,
  computeSupersampledProxyChannels,
  renderSupersampledProxyRgba,
  buildAspectPreservingProxy,
} from '../src/ui/BendayDialog.js';
import PhotoshopCmykBridge from '../src/bridge/PhotoshopCmykBridge.js';
import pluginEntry from '../src/index.js';
import { createMockPhotoshopEnv } from './mocks/photoshop.js';

const requireCjs = createRequire(import.meta.url);
const bendayCore = requireCjs('@electrosaur-labs/benday-core');
const uxpMock = requireCjs('./mocks/uxp.js');
const { __mockUxpStorage } = uxpMock;

function loadDialogDom() {
  const htmlPath = path.resolve(__dirname, '../src/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  return dom;
}

describe('Benday v0.2 UI, Hold-to-Blink, PressConfig Round-Trip & Credits Crawl', () => {
  beforeEach(() => {
    __mockUxpStorage.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wires Dot Gain, BVG, Rosette Presets (image-aware/fta/iso/flamenco/manual), HVS telemetry, and Preview = Production parity', () => {
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState();

    const W = 96;
    const H = 96;
    const N = W * H;
    state.setDocumentInfo({ width: W, height: H, resolution: 600, name: 'TypePoster.psd' });

    const dialog = new BendayDialog(doc, state, {});

    // Build synthetic CMYK artwork: C has dominant 50% midtone energy, M moderate, Y light, K empty except 3px text stroke
    const C = new Uint8Array(N).fill(128);
    const M = new Uint8Array(N).fill(50);
    const Y = new Uint8Array(N).fill(15);
    const K = new Uint8Array(N).fill(0);
    for (let y = 10; y < 30; y++) {
      for (let x = 44; x <= 46; x++) {
        K[y * W + x] = 240;
      }
    }

    dialog.setFullDocumentData({
      width: W,
      height: H,
      dpi: 600,
      channels: { C, M, Y, K },
    });

    // Live HVS telemetry populated on header & physics card
    expect(doc.getElementById('hvs-telemetry').textContent).toMatch(/HVS ΔE \d+\.\d · \d+ steps/);
    expect(doc.getElementById('phys-hvs-quality').textContent).toMatch(/ΔE \d+\.\d \(p95 \d+\.\d\) · \d+ gray steps/);

    // Original URL captured before knob changes
    dialog._applyOriginalToggleView(true);
    const baselineOrigUrl = dialog._originalDataUrl;
    dialog._applyOriginalToggleView(false);
    const baselineHalftoneUrl = dialog._halftoneDataUrl;

    // 1. Dot Gain slider `input` updates state, readout, revert button, and `#preview-busy-badge` IMMEDIATELY (< 1 ms)
    // while coalescing heavy preview render to `16 ms` (`change` flushes synchronously and hides `#preview-busy-badge`!)
    const dgSlider = doc.getElementById('slider-dot-gain');
    const busyBadge = doc.getElementById('preview-busy-badge');
    dgSlider.value = '15';
    dgSlider.dispatchEvent(new dom.window.Event('input'));
    expect(state.dotGain).toBe(15);
    expect(doc.getElementById('readout-dot-gain').textContent).toBe('15%');
    expect(doc.getElementById('btn-dot-gain-revert').classList.contains('visible')).toBe(true);
    expect(busyBadge.classList.contains('visible')).toBe(true);
    expect(dialog._halftoneDataUrl).toBe(baselineHalftoneUrl);

    dgSlider.dispatchEvent(new dom.window.Event('change'));
    expect(busyBadge.classList.contains('visible')).toBe(false);
    expect(dialog._halftoneDataUrl).not.toBe(baselineHalftoneUrl);

    // Also verify sub-pixel Fit branch (< 2.5 cellPitchPreviewPx on 3600x3600 @ 300 DPI) reflects dotGain & bvg!
    const largeState = new BendayState({ dpi: 300, docWidth: 3600, docHeight: 3600 });
    const proxy120 = buildAspectPreservingProxy({ C, M, Y, K }, W, H, 80);
    const fitRgbaNoDg = renderSupersampledProxyRgba(proxy120, 3600, 3600, largeState.getSnapshot(), null);
    largeState.setDotGain(16);
    const fitRgbaWithDg = renderSupersampledProxyRgba(proxy120, 3600, 3600, largeState.getSnapshot(), null);
    let diffSum = 0;
    for (let i = 0; i < fitRgbaNoDg.length; i += 4) {
      // Dot gain pullback reduces ink -> brightens RGB reflectance (>= baseline)
      diffSum += fitRgbaWithDg[i] - fitRgbaNoDg[i];
    }
    expect(diffSum).toBeGreaterThan(0);

    // Original view remains 100% unmodified despite dotGain=15 & bvg=true (defaulted On), and `#chk-bvg-box` + `#btn-bvg-revert` sync cleanly
    const chkBvg = doc.getElementById('chk-bvg');
    const chkBvgBox = doc.getElementById('chk-bvg-box');
    const btnBvgRevert = doc.getElementById('btn-bvg-revert');
    expect(state.bvg).toBe(true);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(true);
    expect(btnBvgRevert.classList.contains('visible')).toBe(false);

    chkBvg.checked = false;
    chkBvg.dispatchEvent(new dom.window.Event('change'));
    expect(state.bvg).toBe(false);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(false);
    expect(btnBvgRevert.classList.contains('visible')).toBe(true);

    btnBvgRevert.click();
    expect(state.bvg).toBe(true);
    expect(chkBvgBox.classList.contains('is-checked')).toBe(true);
    expect(btnBvgRevert.classList.contains('visible')).toBe(false);

    dialog._applyOriginalToggleView(true);
    expect(dialog._originalDataUrl).toBe(baselineOrigUrl);
    dialog._applyOriginalToggleView(false);

    // 2. Rosette preset dropdown switches between image-aware, fta, iso, flamenco, manual, and resets to auto
    const presetSel = doc.getElementById('select-rosette-preset');
    presetSel.value = 'fta';
    presetSel.dispatchEvent(new dom.window.Event('change'));
    expect(state.rosettePreset).toBe('fta');
    expect(state.getSnapshot().angles).toEqual({ C: 7.5, M: 67.5, Y: 82.5, K: 37.5 });
    expect(doc.getElementById('btn-angles-auto').classList.contains('visible')).toBe(true);

    presetSel.value = 'flamenco';
    presetSel.dispatchEvent(new dom.window.Event('change'));
    expect(state.getSnapshot().angles.C).toBe(state.getSnapshot().angles.K);

    presetSel.value = 'image-aware';
    presetSel.dispatchEvent(new dom.window.Event('change'));
    expect(state.rosettePreset).toBe('image-aware');
    // C had highest detail energy -> gets primary 45° slot (modulo meshAngleDeg=0 -> 45°)
    expect(state.getSnapshot().angles.C).toBe(45);

    // Typing manual angle switches preset to 'manual'
    const angleKInput = doc.getElementById('input-angle-k');
    angleKInput.value = '41.5';
    angleKInput.dispatchEvent(new dom.window.Event('change'));
    expect(state.rosettePreset).toBe('manual');
    expect(presetSel.value).toBe('manual');

    // Clicking Auto revert restores 'auto'
    doc.getElementById('btn-angles-auto').click();
    expect(state.rosettePreset).toBe('auto');
    expect(state.anglesOverride).toBeNull();

    dialog.destroy();
  });

  it('implements < 300 ms click toggle vs >= 300 ms Hold-to-Blink (400 ms) directly on #preview-container (with #btn-view-original removed), plus pan-drag cancellation', () => {
    vi.useFakeTimers();
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState();
    state.setDocumentInfo({ width: 64, height: 64, resolution: 600, name: 'Blink.psd' });

    expect(doc.getElementById('btn-view-original')).toBeNull();
    expect(doc.querySelector('.screen-strip-hint').textContent).toContain(
      'Click or hold image to blink-compare'
    );
    expect(doc.querySelector('.screen-strip-hint').textContent).not.toContain('Original');

    const dialog = new BendayDialog(doc, state, {});
    const ch = new Uint8Array(64 * 64).fill(110);
    dialog.setFullDocumentData({
      width: 64,
      height: 64,
      dpi: 600,
      channels: { C: ch, M: ch, Y: ch, K: ch },
    });

    const container = doc.getElementById('preview-container');
    const badge = doc.getElementById('original-badge');
    const previewImg = doc.getElementById('preview-img');
    const htUrl = dialog._halftoneDataUrl;

    // 1. Short click (< 300 ms) on #preview-container toggles sticky Original ON, second click toggles OFF
    container.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 40 })
    );
    vi.advanceTimersByTime(120);
    container.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(badge.classList.contains('visible')).toBe(true);
    expect(previewImg.src).not.toBe(htUrl);

    vi.advanceTimersByTime(150);
    container.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 40, clientY: 40 })
    );
    vi.advanceTimersByTime(100);
    container.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(badge.classList.contains('visible')).toBe(false);
    expect(previewImg.src).toBe(htUrl);

    // 2. Press-and-hold (>= 300 ms) on #preview-container enters 400 ms periodic Blink and restores Halftone on release
    container.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, clientY: 50 })
    );
    vi.advanceTimersByTime(299);
    expect(dialog._blinkMode).toBe(false);

    vi.advanceTimersByTime(1); // 300 ms -> Blink starts on Original
    expect(dialog._blinkMode).toBe(true);
    expect(dialog._showingOriginal).toBe(true);

    vi.advanceTimersByTime(400); // 700 ms -> alternates to Halftone
    expect(dialog._showingOriginal).toBe(false);

    vi.advanceTimersByTime(400); // 1100 ms -> alternates back to Original
    expect(dialog._showingOriginal).toBe(true);

    // Release exits Blink immediately back to Halftone and clears interval
    container.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(dialog._blinkMode).toBe(false);
    expect(dialog._showingOriginal).toBe(false);
    expect(dialog._blinkInterval).toBeNull();
    expect(previewImg.src).toBe(htUrl);

    // 3. Zoomed pan-drag (>= 4 px before 300 ms) cancels hold timer and never enters Blink
    state.setViewZoom(2);
    container.dispatchEvent(
      new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 })
    );
    vi.advanceTimersByTime(100);
    container.dispatchEvent(
      new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 112, clientY: 100 })
    );
    vi.advanceTimersByTime(500);
    expect(dialog._blinkMode).toBe(false);
    expect(dialog._showingOriginal).toBe(false);
    container.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));

    dialog.destroy();
  });

  it('round-trips PressConfig via -benday.json Save/Load and .psd generatorSettings + XMP metadata (skipping deleted Benday layers)', async () => {
    expect(pluginEntry.getSuggestedConfigFilename('GigPoster.psd')).toBe('GigPoster-benday.json');
    expect(pluginEntry.getSuggestedConfigFilename('')).toBe('benday.json');

    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState({
      meshTpi: 305,
      threadDiaUm: 34,
      ruleOfN: 4.5,
      dotGain: 13,
      bvg: true,
      rosettePreset: 'iso',
      tailMode: 'clamp',
    });
    state.setDocumentInfo({ width: 32, height: 32, resolution: 600, name: 'GigPoster.psd' });

    // 1. Mock UXP Save / Load via BendayDialog callbacks
    let savedJson = '';
    const dialog = new BendayDialog(doc, state, {
      onSaveConfig: async () => {
        const handle = await uxpMock.storage.localFileSystem.getFileForSaving(
          pluginEntry.getSuggestedConfigFilename(state.docName)
        );
        await handle.write(state.exportPressConfig({ documentName: state.docName }));
        savedJson = handle.content;
      },
      onLoadConfig: async () => {
        const handle = await uxpMock.storage.localFileSystem.getFileForOpening({
          types: ['json'],
        });
        if (handle) {
          state.applyPressConfig(await handle.read());
        }
      },
    });

    await doc.getElementById('btn-save-config').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(savedJson).toContain('"schemaVersion": "0.2.0"');
    expect(savedJson).toContain('"dotGain": 13');
    expect(savedJson).toContain('"bvg": true');

    // Reset state, then Load saved JSON back
    state.resetToDefaults();
    expect(state.dotGain).toBe(0);
    expect(state.bvg).toBe(true);

    __mockUxpStorage.setNextOpenText(savedJson, 'GigPoster-benday.json');
    await doc.getElementById('btn-load-config').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(state.meshTpi).toBe(305);
    expect(state.threadDiaUm).toBe(34);
    expect(state.dotGain).toBe(13);
    expect(state.bvg).toBe(true);
    expect(state.rosettePreset).toBe('iso');
    expect(state.tailMode).toBe('clamp');

    // 2. Commit halftone layer onto mock Photoshop document -> embeds generatorSettings + XMPMetadataAsUTF8
    const psEnv = createMockPhotoshopEnv({ width: 32, height: 32, resolution: 600 });
    await PhotoshopCmykBridge.commitHalftoneLayer(
      psEnv.app,
      psEnv.core,
      psEnv.action,
      psEnv.imaging,
      state.exportEngineConfig()
    );

    expect(psEnv.origDoc.xmpMetadata).toContain('<!-- BENDAY:BEGIN -->');
    const restored = await PhotoshopCmykBridge.readSavedPressConfigFromDocument(psEnv.app, {
      action: psEnv.action,
    });
    expect(restored).not.toBeNull();
    expect(restored.meshTpi).toBe(305);
    expect(restored.dotGain).toBe(13);
    expect(restored.bvg).toBe(true);
    expect(restored.rosettePreset).toBe('iso');

    // Fallback to XMP if layer generatorSettings is cleared (e.g. flattened/copied metadata)
    psEnv.origDoc.layers[0].generatorSettings = {};
    const restoredFromXmp = await PhotoshopCmykBridge.readSavedPressConfigFromDocument(psEnv.app, {
      action: psEnv.action,
    });
    expect(restoredFromXmp).not.toBeNull();
    expect(restoredFromXmp.dotGain).toBe(13);

    // If user deletes the Benday Halftone* layer, stale XMP is NOT surprise-restored!
    psEnv.origDoc.layers = psEnv.origDoc.layers.filter((l) => !l.name.startsWith('Benday Halftone'));
    const afterDelete = await PhotoshopCmykBridge.readSavedPressConfigFromDocument(psEnv.app, {
      action: psEnv.action,
    });
    expect(afterDelete).toBeNull();

    // 3. Overwrite confirmation guard in `handleSaveConfig`: prompts `'Overwrite File?'` when `file.read()` is non-empty!
    const existingEntry = {
      name: 'GigPoster-benday.json',
      content: '{"existing":true}',
      async read() {
        return this.content;
      },
      async write(text) {
        this.content = String(text);
      },
    };
    __mockUxpStorage.setNextSaveResponse(existingEntry);
    const saveCancelPromise = pluginEntry.handleSaveConfig(state, doc);
    await new Promise((r) => setTimeout(r, 5));
    const confirmOverlay = doc.getElementById('confirm-overlay');
    expect(confirmOverlay.classList.contains('visible')).toBe(true);
    expect(doc.getElementById('confirm-title').textContent).toBe('Overwrite File?');
    expect(doc.getElementById('btn-confirm-ok').textContent).toBe('Overwrite');
    doc.getElementById('btn-confirm-cancel').click();
    expect(await saveCancelPromise).toBe(false);
    expect(existingEntry.content).toBe('{"existing":true}');

    __mockUxpStorage.setNextSaveResponse(existingEntry);
    const saveOkPromise = pluginEntry.handleSaveConfig(state, doc);
    await new Promise((r) => setTimeout(r, 5));
    expect(confirmOverlay.classList.contains('visible')).toBe(true);
    doc.getElementById('btn-confirm-ok').click();
    expect(await saveOkPromise).toBe(true);
    expect(existingEntry.content).toContain('"schemaVersion": "0.2.0"');

    // Graceful fallback to `true` when `#confirm-overlay` is absent (headless unit-test callers)
    const headlessEntry = {
      name: 'Headless-benday.json',
      content: '{"prior":1}',
      async read() {
        return this.content;
      },
      async write(text) {
        this.content = String(text);
      },
    };
    __mockUxpStorage.setNextSaveResponse(headlessEntry);
    const emptyDom = new JSDOM('<div></div>');
    expect(await pluginEntry.handleSaveConfig(state, emptyDom.window.document)).toBe(true);
    expect(headlessEntry.content).toContain('"schemaVersion": "0.2.0"');

    dialog.destroy();
  });

  it('runs ★ Credits ★ 24 px/sec crawl, hover/wheel pause, 1879 Ben Day Broadside Easter Egg, 9 Legends check, and 5-step Escape priority', () => {
    vi.useFakeTimers();
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState();
    state.setDocumentInfo({ width: 64, height: 64, resolution: 600, name: 'Credits.psd' });

    let cancelCalls = 0;
    let escapeIntercepts = 0;
    const dialog = new BendayDialog(doc, state, {
      onCancel: () => {
        cancelCalls++;
      },
      onEscapeIntercepted: () => {
        escapeIntercepts++;
      },
    });

    const ch = new Uint8Array(64 * 64).fill(100);
    dialog.setFullDocumentData({
      width: 64,
      height: 64,
      dpi: 600,
      channels: { C: ch, M: ch, Y: ch, K: ch },
    });

    // Verify Scene 1 Benjamin Henry Day Jr. (1838–1916) & Scene 2 all 9 Spec §7.2 Legends with zero FftMoireAnalyzer mentions
    const overlayText = doc.getElementById('credits-overlay').textContent;
    expect(overlayText).toContain('Benjamin Henry Day Jr.');
    expect(overlayText).toContain('1879');
    expect(overlayText).toContain('Joseph Fourier');
    expect(overlayText).toContain('George Biddell Airy');
    expect(overlayText).toContain('Camille Jordan & Robert Tarjan');
    expect(overlayText).toContain('Bronisław Knaster & Alfred Tarski');
    expect(overlayText).toContain('Hans E. J. Neugebauer & CIE');
    expect(overlayText).toContain('Georges Matheron & Jean Serra');
    expect(overlayText).toContain('Fergus Campbell & Janusz Kulikowski');
    expect(overlayText).toContain('Robert Floyd & Louis Steinberg');
    expect(overlayText).toContain('Nobuyuki Otsu');
    expect(overlayText).not.toContain('FftMoireAnalyzer');

    // Set solo mode + sticky Original + open Credits + open 1879 Manifesto Broadside to test full 5-step Escape chain!
    state.setPreviewMode('C');
    dialog._applyOriginalToggleView(true);
    doc.getElementById('btn-show-credits').click();

    const overlay = doc.getElementById('credits-overlay');
    const viewport = doc.getElementById('credits-viewport');
    expect(overlay.classList.contains('visible')).toBe(true);

    // Mock geometry in JSDOM (`clientHeight = 400px`, `scrollHeight = 1400px`) and verify 24 px/sec crawl
    Object.defineProperty(viewport, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(viewport, 'scrollHeight', { value: 1400, configurable: true });
    dialog.credits.open();
    dialog.credits.lastTimestamp = 1000;
    dialog.credits._tick(1100); // +0.1s -> +2.4 px
    dialog.credits._tick(1200); // +0.1s -> +4.8 px
    expect(viewport.scrollTop).toBeGreaterThan(4.5);

    // Hover pauses crawl
    viewport.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
    const scrollPaused = viewport.scrollTop;
    dialog.credits._tick(1300);
    expect(viewport.scrollTop).toBe(scrollPaused);
    viewport.dispatchEvent(new dom.window.MouseEvent('mouseleave'));

    // Wheel scroll pauses crawl permanently (`userHasScrolled = true`)
    viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 50, cancelable: true }));
    expect(dialog.credits.userHasScrolled).toBe(true);
    expect(dialog.credits.isPlaying).toBe(false);

    // Click mascot/medallion -> opens 1879 Ben Day Rapid Shading Medium Broadside Easter Egg
    doc.getElementById('credits-emblem').click();
    const manifesto = doc.getElementById('manifesto-broadside');
    expect(manifesto.classList.contains('visible')).toBe(true);

    const pressEscape = () =>
      doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Escape #1 -> closes 1879 Manifesto Broadside ONLY
    pressEscape();
    expect(manifesto.classList.contains('visible')).toBe(false);
    expect(overlay.classList.contains('visible')).toBe(true);
    expect(cancelCalls).toBe(0);

    // Escape #2 -> closes Credits overlay ONLY
    pressEscape();
    expect(overlay.classList.contains('visible')).toBe(false);
    expect(dialog._showingOriginal).toBe(true);
    expect(cancelCalls).toBe(0);
    expect(escapeIntercepts).toBe(2);

    // Escape #3 -> with all modal overlays closed, 1 Escape immediately dismisses Benday (`onCancel`)
    // even while sticky Original and solo C screen view are active!
    pressEscape();
    expect(cancelCalls).toBe(1);

    dialog.destroy();
  });

  it('locks image-aware rosette angles identically across panned 200% zoomed crops, solo views, BVG state, and commitHalftoneLayer while preserving .psd preset metadata', async () => {
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState();

    // 800x800 @ 300 DPI: at 200% zoom (`sizer = 1600 > 1200`), `_renderZoomedViewport` slices local `haloCh` crops!
    const W = 800;
    const H = 800;
    const N = W * H;
    state.setDocumentInfo({ width: W, height: H, resolution: 300, name: 'SplitPoster.psd' });

    const C = new Uint8Array(N);
    const M = new Uint8Array(N);
    const Y = new Uint8Array(N);
    const K = new Uint8Array(N);

    // Top 65% (`y = 0..519`): Cyan-dominant (`C = 128`). Bottom 35% (`y = 520..799`): Magenta-dominant (`M = 128`).
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (y < 520) {
          C[p] = 128;
        } else {
          M[p] = 128;
        }
      }
    }

    const dialog = new BendayDialog(doc, state, {});
    dialog.setFullDocumentData({
      width: W,
      height: H,
      dpi: 300,
      channels: { C, M, Y, K },
    });

    state.setRosettePreset('image-aware');
    const globalAngles = state.getSnapshot().angles;
    // Global document is Cyan-dominant -> C gets primary 45° slot, M gets 75° (or 15°)
    expect(globalAngles.C).toBe(45);
    expect(globalAngles.M).not.toBe(45);

    // Pan 200% viewport deep into the Magenta-only bottom crop (`y ~ 560..720`)
    const container = doc.getElementById('preview-container');
    Object.defineProperty(container, 'clientWidth', { value: 320, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 320, configurable: true });
    container.scrollLeft = 240;
    container.scrollTop = 1160; // docT = floor(1160 / 2) = 580 (100% inside Magenta-only bottom region!)

    state.setViewZoom(2);
    expect(state.getSnapshot().angles).toEqual(globalAngles);

    // Decode 200% composite PNG (`640x640` scaled 2x from `320x320` crop at `docL=120, docT=580`)
    const decodePngRgba = (dataUrl) => {
      const buf = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
      const pw = buf.readUInt32BE(16);
      const ph = buf.readUInt32BE(20);
      let off = 8;
      const chunks = [];
      while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.subarray(off + 4, off + 8).toString('ascii');
        if (type === 'IDAT') chunks.push(buf.subarray(off + 8, off + 8 + len));
        if (type === 'IEND') break;
        off += 12 + len;
      }
      const raw = zlib.inflateSync(Buffer.concat(chunks));
      const out = new Uint8Array(pw * ph * 4);
      for (let y = 0; y < ph; y++) {
        out.set(raw.subarray(y * (1 + pw * 4) + 1, (y + 1) * (1 + pw * 4)), y * pw * 4);
      }
      return { width: pw, height: ph, rgba: out };
    };

    const compZoom = decodePngRgba(dialog._halftoneDataUrl);
    state.setPreviewMode('M');
    const soloMZoom = decodePngRgba(dialog._halftoneDataUrl);
    state.setPreviewMode('composite');

    // Every pixel in the bottom crop has C=Y=K=0; composite Magenta ink (`SWOP M = [236, 0, 140]`) MUST match solo M (`[0, 0, 0]`) bit-for-bit!
    // (Before [BLOCKING-1], composite bottom crop re-ran 'image-aware' locally, flipping M to 45° while solo M used global M angle!)
    let mismatches = 0;
    for (let i = 0; i < compZoom.width * compZoom.height; i++) {
      const compIsM = compZoom.rgba[i * 4 + 1] === 0; // G === 0 on SWOP Magenta, 255 on Paper
      const soloIsM = soloMZoom.rgba[i * 4] === 0;     // R === 0 on solo black dot, 255 on Paper
      if (compIsM !== soloIsM) mismatches++;
    }
    expect(mismatches).toBe(0);

    // Also verify `commitHalftoneLayer` uses the exact locked `globalAngles` AND serializes `rosettePreset: 'image-aware'` (with `anglesOverride: null`) into `.psd` metadata!
    const smallW = 64;
    const smallH = 64;
    const sC = new Uint8Array(smallW * smallH);
    const sM = new Uint8Array(smallW * smallH);
    const sY = new Uint8Array(smallW * smallH);
    const sK = new Uint8Array(smallW * smallH);
    for (let y = 0; y < smallH; y++) {
      for (let x = 0; x < smallW; x++) {
        if (y < 40) sC[y * smallW + x] = 128;
        else sM[y * smallW + x] = 128;
      }
    }
    state.setDocumentInfo({ width: smallW, height: smallH, resolution: 600, name: 'CommitAware.psd' });
    dialog.setFullDocumentData({ width: smallW, height: smallH, dpi: 600, channels: { C: sC, M: sM, Y: sY, K: sK } });
    state.setRosettePreset('image-aware');
    const engineCfg = state.exportEngineConfig();
    expect(engineCfg.rosettePreset).toBe('image-aware');
    expect(engineCfg.anglesOverride).toBeNull();
    expect(engineCfg.angles.C).toBe(45);

    const psEnv = createMockPhotoshopEnv({
      width: smallW,
      height: smallH,
      resolution: 600,
      channels: { C: sC, M: sM, Y: sY, K: sK },
    });
    const commitRes = await PhotoshopCmykBridge.commitHalftoneLayer(
      psEnv.app,
      psEnv.core,
      psEnv.action,
      psEnv.imaging,
      engineCfg,
      null,
      { width: smallW, height: smallH, dpi: 600, bitsPerChannel: 8, channels: { C: sC, M: sM, Y: sY, K: sK } }
    );
    expect(commitRes.angles).toEqual(engineCfg.angles);

    const restored = await PhotoshopCmykBridge.readSavedPressConfigFromDocument(psEnv.app, { action: psEnv.action });
    expect(restored.rosettePreset).toBe('image-aware');
    expect(restored.anglesOverride).toBeNull();

    // Verify `bvg: true` conditions `_rosetteChannels` inside `BendayState._recompute`:
    // Narrow Rich-Black strokes (`C=185, M=175, Y=170, K=205`) + pure Yellow midtone band (`Y=128` on rows `0..15`) ->
    // with `bvg=false`, strong inks (`K/C/M`) on the strokes dominate so `Y` never gets `45°`;
    // with `bvg=true`, Stage A Rich-Black UCR promotes all narrow strokes to `K=255, C=M=Y=0` (`0` midtone dot weight),
    // leaving `Y=128` as the sole midtone channel so `Y` moves into the `45°` slot!
    const bvgState = new BendayState({ docWidth: 64, docHeight: 64, dpi: 600, rosettePreset: 'image-aware', bvg: false });
    const rC = new Uint8Array(64 * 64);
    const rM = new Uint8Array(64 * 64);
    const rY = new Uint8Array(64 * 64);
    const rK = new Uint8Array(64 * 64);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 64; x++) {
        rY[y * 64 + x] = 128;
      }
    }
    for (let y = 20; y < 58; y += 6) {
      for (let dy = 0; dy < 2; dy++) {
        for (let x = 4; x < 60; x++) {
          const p = (y + dy) * 64 + x;
          rC[p] = 185;
          rM[p] = 175;
          rY[p] = 170;
          rK[p] = 205;
        }
      }
    }
    bvgState.setChannelStatsSource({ C: rC, M: rM, Y: rY, K: rK }, 64, 64);
    const anglesNoBvg = bvgState.getSnapshot().angles;
    expect(anglesNoBvg.Y).not.toBe(45);
    bvgState.setBvg(true);
    const anglesWithBvg = bvgState.getSnapshot().angles;
    expect(anglesWithBvg.Y).toBe(45);

    dialog.destroy();
  });

  it('enforces display:block on UXP scrollable/card containers, border:none 26px number inputs, zero column-flex gap, and zero "plates" prose', () => {
    const cssPath = path.resolve(__dirname, '../src/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = css.match(/\{[^}]*\}/g) || [];
    expect(blocks.length).toBeGreaterThan(20);
    for (const block of blocks) {
      if (/flex-direction\s*:\s*column/i.test(block)) {
        expect(block).not.toMatch(/\bgap\s*:/i);
      }
    }

    // Regression guard against UXP Torq `flex-direction: column` shrink cascade:
    // `#knobs-scroll`, `.knob-section`, `.angle-cell`, and `.telemetry-card` MUST be `display: block` (never `display: flex`).
    const ruleMap = new Map();
    const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = ruleRegex.exec(css)) !== null) {
      const selectors = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sel of selectors) {
        ruleMap.set(sel, (ruleMap.get(sel) || '') + '\n' + m[2]);
      }
    }

    for (const blockSel of ['#knobs-scroll', '.knob-section', '.angle-cell', '.telemetry-card']) {
      const body = ruleMap.get(blockSel) || '';
      expect(body).toMatch(/display\s*:\s*block/i);
      expect(body).not.toMatch(/display\s*:\s*flex/i);
      expect(body).not.toMatch(/flex-direction\s*:\s*column/i);
    }

    for (const inputSel of ['.knob-inline-num', '.knob-full-input', '.mesh-tpi-num', '.angle-cell input']) {
      const body = ruleMap.get(inputSel) || '';
      expect(body).toMatch(/height\s*:\s*26px/i);
      expect(body).toMatch(/border\s*:\s*none/i);
    }
    expect(css).not.toContain('.orig-compare-btn');

    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).not.toMatch(/\bplates?\b/i);

    // Verify stealth link-free Credits markup & Oakland/Berkeley colophon
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const emblem = doc.getElementById('credits-emblem');
    const printTrigger = doc.getElementById('credits-print-trigger');
    const mascotImg = emblem.querySelector('img.credits-mascot-img');
    expect(emblem.hasAttribute('title')).toBe(false);
    expect(printTrigger.hasAttribute('title')).toBe(false);
    expect(mascotImg.getAttribute('draggable')).toBe('false');
    expect(doc.querySelector('.credits-print-caption').textContent).toContain(
      'U.S. Patent No. 214,493'
    );
    expect(doc.getElementById('credits-overlay').textContent).toContain(
      'OAKLAND / BERKELEY SERIGRAPHY TRADITION'
    );
    expect(doc.getElementById('credits-overlay').textContent).toContain('BENDAY ENGINE v0.2');
  });

  it('coalesces 60 fps slider input events, caps Fit supersample to 1400 px, and switches C/M/Y/K screens with ZERO extra halftoneCmyk calls', () => {
    vi.useFakeTimers();
    const dom = loadDialogDom();
    const doc = dom.window.document;
    const state = new BendayState({
      docName: 'FastSwitch.psd',
      docWidth: 160,
      docHeight: 160,
      dpi: 600,
    });
    const dialog = new BendayDialog(doc, state, {});

    const N = 160 * 160;
    const channels = {
      C: new Uint8Array(N).fill(90),
      M: new Uint8Array(N).fill(130),
      Y: new Uint8Array(N).fill(45),
      K: new Uint8Array(N).fill(15),
    };
    dialog.setFullDocumentData({ width: 160, height: 160, dpi: 600, channels });

    // 1. Clicking C -> M -> Y -> K -> Composite in Fit mode hits `_viewPlatesCache` + `_hvsCache` with ZERO `halftoneCmyk` calls!
    const htSpy = vi.spyOn(bendayCore, 'halftoneCmyk');
    htSpy.mockClear();

    const fitCompUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="C"]').click();
    const fitCUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="M"]').click();
    const fitMUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="Y"]').click();
    const fitYUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="K"]').click();
    const fitKUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="composite"]').click();

    expect(htSpy).toHaveBeenCalledTimes(0);
    expect(fitCUrl).not.toBe(fitCompUrl);
    expect(fitMUrl).not.toBe(fitCUrl);
    expect(fitYUrl).not.toBe(fitMUrl);
    expect(fitKUrl).not.toBe(fitYUrl);
    expect(dialog._halftoneDataUrl).toBe(fitCompUrl);

    // 2. Switching to 100% Zoom (`viewZoom = 1`) computes 4-screen plates ONCE, then C -> M -> Y -> K -> Composite makes ZERO extra calls!
    state.setViewZoom(1);
    htSpy.mockClear();
    const zoomCompUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="C"]').click();
    const zoomCUrl = dialog._halftoneDataUrl;
    doc.querySelector('[data-preview-mode="M"]').click();
    doc.querySelector('[data-preview-mode="Y"]').click();
    doc.querySelector('[data-preview-mode="K"]').click();
    doc.querySelector('[data-preview-mode="composite"]').click();

    expect(htSpy).toHaveBeenCalledTimes(0);
    expect(zoomCUrl).not.toBe(zoomCompUrl);
    expect(dialog._halftoneDataUrl).toBe(zoomCompUrl);

    // 3. Rapid `input` ticks on `#input-rule-n-slider` update `#readout-rule-n` immediately without fighting the slider
    // and coalesce preview computation into a single `16 ms` timer tick!
    state.setViewZoom('fit');
    htSpy.mockClear();
    const ruleSlider = doc.getElementById('input-rule-n-slider');
    const busyBadge = doc.getElementById('preview-busy-badge');

    ruleSlider.value = '6.0';
    ruleSlider.dispatchEvent(new dom.window.Event('input'));
    expect(doc.getElementById('readout-rule-n').textContent).toContain('N = 6.0');
    expect(busyBadge.classList.contains('visible')).toBe(true);
    expect(htSpy).toHaveBeenCalledTimes(0);

    ruleSlider.value = '7.5';
    ruleSlider.dispatchEvent(new dom.window.Event('input'));
    expect(doc.getElementById('readout-rule-n').textContent).toContain('N = 7.5');
    expect(htSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(20);
    // Exactly 2 calls after 16 ms coalesced tick: 1 for `_hvsCrop` + 1 for `160x160` Fit plates (instead of 4+ synchronous mid-drag stalls!)
    expect(htSpy).toHaveBeenCalledTimes(2);
    expect(busyBadge.classList.contains('visible')).toBe(false);

    // 4. Verify `computeSupersampledProxyChannels` caps `superSrc` edge to `MAX_FIT_SUPER_EDGE = 1400` on large coarse-ruling posters!
    htSpy.mockClear();
    const bigW = 3000;
    const bigH = 3000;
    const bigCh = {
      C: new Uint8Array(bigW * bigH),
      M: new Uint8Array(bigW * bigH),
      Y: new Uint8Array(bigW * bigH),
      K: new Uint8Array(bigW * bigH),
    };
    const coarseState = new BendayState({
      docWidth: bigW,
      docHeight: bigH,
      dpi: 300,
      meshTpi: 110,
      threadDiaUm: 80,
      ruleOfN: 10,
    });
    const proxy840 = {
      width: 840,
      height: 840,
      scaleX: bigW / 840,
      scaleY: bigH / 840,
      channels: {
        C: new Uint8Array(840 * 840),
        M: new Uint8Array(840 * 840),
        Y: new Uint8Array(840 * 840),
        K: new Uint8Array(840 * 840),
      },
    };
    computeSupersampledProxyChannels(proxy840, bigW, bigH, coarseState.getSnapshot(), bigCh);
    expect(htSpy).toHaveBeenCalledTimes(1);
    expect(htSpy.mock.calls[0][1]).toBe(MAX_FIT_SUPER_EDGE);
    expect(htSpy.mock.calls[0][2]).toBe(MAX_FIT_SUPER_EDGE);

    htSpy.mockRestore();
    dialog.destroy();
  });
});

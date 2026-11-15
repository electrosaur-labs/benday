'use strict';

const { halftoneCmyk, halftoneChannel, SAATI_MESH_PRESETS } = require('@electrosaur-labs/benday-core');
const { encodeRgbaToPngDataUrl } = require('../utils/pngDataUrl');

const MAX_PROXY_EDGE = 840;
const LOUPE_SIZE = 256;
const VIEWPORT_HALO_PX = 16;
const MAX_DIRECT_ZOOM_EDGE = 960;

const CHANNEL_KEYS = Object.freeze(['C', 'M', 'Y', 'K']);

/**
 * Calibrated 8-corner Neugebauer SWOP Coated primary & overprint RGB vertices (0..255):
 *   (0,0,0) Paper   : [255, 255, 255]
 *   (1,0,0) Cyan    : [  0, 174, 239] (#00AEEF)
 *   (0,1,0) Magenta : [236,   0, 140] (#EC008C)
 *   (0,0,1) Yellow  : [255, 242,   0] (#FFF200)
 *   (1,1,0) C + M   : [ 46,  49, 146] (#2E3192)
 *   (1,0,1) C + Y   : [  0, 166,  81] (#00A651)
 *   (0,1,1) M + Y   : [237,  28,  36] (#ED1C24)
 *   (1,1,1) C+M+Y   : [ 38,  35,  36] (#262324)
 * Multiplied by rich Black ink transmittance `(1 - 0.93 * k)`.
 */
const SWOP_CORNERS = Object.freeze({
  p000: [255, 255, 255],
  p100: [0, 174, 239],
  p010: [236, 0, 140],
  p001: [255, 242, 0],
  p110: [46, 49, 146],
  p101: [0, 166, 81],
  p011: [237, 28, 36],
  p111: [38, 35, 36],
});

/**
 * Evaluate calibrated SWOP Coated trilinear Neugebauer RGB for normalized `[0..1]` `(c, m, y, k)`
 * and write `[R, G, B, 255]` into `rgba` at byte offset `outOffset`.
 */
function writeSwopCompositePixel(rgba, outOffset, c, m, y, k) {
  const c0 = 1 - c;
  const m0 = 1 - m;
  const y0 = 1 - y;

  const w000 = c0 * m0 * y0;
  const w100 = c * m0 * y0;
  const w010 = c0 * m * y0;
  const w001 = c0 * m0 * y;
  const w110 = c * m * y0;
  const w101 = c * m0 * y;
  const w011 = c0 * m * y;
  const w111 = c * m * y;

  const rCmy =
    w000 * 255 +
    w010 * 236 +
    w001 * 255 +
    w110 * 46 +
    w011 * 237 +
    w111 * 38;
  const gCmy =
    w000 * 255 +
    w100 * 174 +
    w001 * 242 +
    w110 * 49 +
    w101 * 166 +
    w011 * 28 +
    w111 * 35;
  const bCmy =
    w000 * 255 +
    w100 * 239 +
    w010 * 140 +
    w110 * 146 +
    w101 * 81 +
    w011 * 36 +
    w111 * 36;

  const kTrans = 1 - 0.93 * k;
  rgba[outOffset] = Math.round(rCmy * kTrans);
  rgba[outOffset + 1] = Math.round(gCmy * kTrans);
  rgba[outOffset + 2] = Math.round(bCmy * kTrans);
  rgba[outOffset + 3] = 255;
}

/**
 * Precomputed 16-entry RGB table for binary `{0, 255}` halftone screens (`mask = C | M<<1 | Y<<2 | K<<3`),
 * avoiding 25 floating-point operations per pixel during zoomed binary preview compositing.
 */
const SWOP_BINARY_RGB = (() => {
  const lut = new Uint8Array(16 * 4);
  for (let mask = 0; mask < 16; mask++) {
    writeSwopCompositePixel(
      lut,
      mask * 4,
      mask & 1 ? 1 : 0,
      mask & 2 ? 1 : 0,
      mask & 4 ? 1 : 0,
      mask & 8 ? 1 : 0
    );
  }
  return lut;
})();

/**
 * Read a numeric value safely from either a native `<input>`/`<select>` or a UXP/JSDOM `<sp-slider>`.
 */
function readControlNumber(el) {
  if (!el) return NaN;
  const valProp = el.value;
  if (valProp !== undefined && valProp !== null && valProp !== '') {
    return Number(valProp);
  }
  const attr = typeof el.getAttribute === 'function' ? el.getAttribute('value') : null;
  return attr !== null && attr !== '' ? Number(attr) : NaN;
}

/**
 * Write a control value to both `.value` and `setAttribute('value', ...)` so UXP Spectrum
 * `<sp-slider>` elements and JSDOM custom elements stay 100% synchronized.
 */
function writeControlValue(el, val, activeEl = null) {
  if (!el || el === activeEl) return;
  const str = String(val);
  el.value = str;
  if (typeof el.setAttribute === 'function' && el.tagName && el.tagName.includes('-')) {
    el.setAttribute('value', str);
  }
}

/**
 * Show or hide an element reliably across both JSDOM and Adobe UXP Torq by combining explicit
 * `.classList.add` / `.remove` (never 2-arg `.toggle`) with explicit inline `style.display`.
 */
function setElementVisible(el, show, displayMode = 'block') {
  if (!el) return;
  if (show) {
    el.classList.add('visible');
    el.style.display = displayMode;
  } else {
    el.classList.remove('visible');
    el.style.display = 'none';
  }
}

/**
 * Render discrete `{0, 255}` (or continuous `0..255`) CMYK channels into an RGBA `Uint8ClampedArray`.
 *
 * - `'composite'`: Calibrated 8-corner trilinear Neugebauer SWOP Coated proof multiplied by
 *   rich Black transmittance `(1 - 0.93 * k)`. Used identically for both `ORIGINAL` and `Halftone`
 *   so flipping between them has zero artificial color-space jump.
 * - `'C' | 'M' | 'Y' | 'K'`: Crisp black-on-white single-screen film positive preview:
 *   `val = 255 - plate[p]` (`0` = opaque black film dot, `255` = clear white film).
 *
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} plates
 * @param {number} width
 * @param {number} height
 * @param {'composite'|'C'|'M'|'Y'|'K'} [previewMode='composite']
 * @returns {Uint8ClampedArray}
 */
function renderPreviewRgba(plates, width, height, previewMode = 'composite') {
  const N = width * height;
  const rgba = new Uint8ClampedArray(N * 4);

  if (previewMode !== 'composite' && plates[previewMode]) {
    const ch = plates[previewMode];
    for (let i = 0; i < N; i++) {
      const v = 255 - ch[i];
      const o = i * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
    return rgba;
  }

  const { C, M, Y, K } = plates;
  const inv255 = 1 / 255;
  for (let i = 0; i < N; i++) {
    const cv = C[i];
    const mv = M[i];
    const yv = Y[i];
    const kv = K[i];
    if (((cv | mv | yv | kv) === 0) || ((cv === 0 || cv === 255) && (mv === 0 || mv === 255) && (yv === 0 || yv === 255) && (kv === 0 || kv === 255))) {
      const mOff = ((cv & 1) | ((mv & 1) << 1) | ((yv & 1) << 2) | ((kv & 1) << 3)) * 4;
      const o = i * 4;
      rgba[o] = SWOP_BINARY_RGB[mOff];
      rgba[o + 1] = SWOP_BINARY_RGB[mOff + 1];
      rgba[o + 2] = SWOP_BINARY_RGB[mOff + 2];
      rgba[o + 3] = 255;
    } else {
      writeSwopCompositePixel(
        rgba,
        i * 4,
        cv * inv255,
        mv * inv255,
        yv * inv255,
        kv * inv255
      );
    }
  }
  return rgba;
}

/**
 * Box-downsample 4 CMYK `Uint8Array` channels from `(srcW, srcH)` to aspect-preserving `(dstW, dstH)`
 * (or exact target dimensions `(targetW, targetH)` when specified).
 */
function buildAspectPreservingProxy(channels, srcW, srcH, maxEdge = MAX_PROXY_EDGE, exactDims = null) {
  let dstW;
  let dstH;
  if (exactDims && exactDims.width > 0 && exactDims.height > 0) {
    dstW = exactDims.width;
    dstH = exactDims.height;
  } else {
    const longEdge = Math.max(srcW, srcH);
    if (longEdge <= maxEdge) {
      return {
        width: srcW,
        height: srcH,
        scaleX: 1,
        scaleY: 1,
        channels: {
          C: channels.C,
          M: channels.M,
          Y: channels.Y,
          K: channels.K,
        },
      };
    }
    const ratio = maxEdge / longEdge;
    dstW = Math.max(1, Math.round(srcW * ratio));
    dstH = Math.max(1, Math.round(srcH * ratio));
  }

  if (dstW === srcW && dstH === srcH) {
    return {
      width: srcW,
      height: srcH,
      scaleX: 1,
      scaleY: 1,
      channels: {
        C: channels.C,
        M: channels.M,
        Y: channels.Y,
        K: channels.K,
      },
    };
  }

  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  const xStarts = new Int32Array(dstW);
  const xEnds = new Int32Array(dstW);
  for (let dx = 0; dx < dstW; dx++) {
    const x0 = Math.floor(dx * scaleX);
    const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((dx + 1) * scaleX)));
    xStarts[dx] = x0;
    xEnds[dx] = x1;
  }

  const outChannels = {};
  for (let c = 0; c < CHANNEL_KEYS.length; c++) {
    const key = CHANNEL_KEYS[c];
    const src = channels[key];
    const dst = new Uint8Array(dstW * dstH);
    for (let dy = 0; dy < dstH; dy++) {
      const y0 = Math.floor(dy * scaleY);
      const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((dy + 1) * scaleY)));
      const dstRow = dy * dstW;
      for (let dx = 0; dx < dstW; dx++) {
        const x0 = xStarts[dx];
        const x1 = xEnds[dx];
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) {
          const rowOff = sy * srcW;
          for (let sx = x0; sx < x1; sx++) {
            sum += src[rowOff + sx];
          }
        }
        const count = (y1 - y0) * (x1 - x0);
        dst[dstRow + dx] = Math.floor((sum + (count >> 1)) / count);
      }
    }
    outChannels[key] = dst;
  }

  return {
    width: dstW,
    height: dstH,
    scaleX,
    scaleY,
    channels: outChannels,
  };
}

/**
 * Apply active `tailMode` tonal transfer (`hybrid` linear, `cutoff` clip, `clamp` floor/ceiling)
 * to area-averaged proxy CMYK channels when halftone cells are sub-pixel (`cellPitchPreviewPx < 2.5`)
 * in `Fit` mode, eliminating fake Nyquist display moiré while preserving exact color & tail behavior.
 */
function applyFitTailTransferChannels(proxyChannels, count, tMin, tMax, tailMode) {
  if (tailMode === 'hybrid') {
    return proxyChannels;
  }
  const minByte = Math.max(1, Math.min(254, Math.round(tMin * 255)));
  const maxByte = Math.max(minByte, Math.min(254, Math.round(tMax * 255)));
  const out = {};

  for (let c = 0; c < CHANNEL_KEYS.length; c++) {
    const key = CHANNEL_KEYS[c];
    const src = proxyChannels[key];
    const dst = new Uint8Array(count);
    if (tailMode === 'cutoff') {
      for (let i = 0; i < count; i++) {
        const v = src[i];
        if (v === 0 || v < minByte) {
          dst[i] = 0;
        } else if (v === 255 || v > maxByte) {
          dst[i] = 255;
        } else {
          dst[i] = v;
        }
      }
    } else {
      // 'clamp': pure 0 stays 0, pure 255 stays 255, interior (0, 255) clamps into [minByte, maxByte]
      for (let i = 0; i < count; i++) {
        const v = src[i];
        if (v === 0 || v === 255) {
          dst[i] = v;
        } else if (v < minByte) {
          dst[i] = minByte;
        } else if (v > maxByte) {
          dst[i] = maxByte;
        } else {
          dst[i] = v;
        }
      }
    }
    out[key] = dst;
  }
  return out;
}

/**
 * Render `Fit`-mode RGBA preview without sub-pixel binary Nyquist aliasing:
 * - When `cellPitchPreviewPx < 2.5`, integrates area-averaged CMYK per preview pixel with active
 *   `tailMode` tonal transfer and SWOP Coated LUT.
 * - When `cellPitchPreviewPx >= 2.5` (small documents or very coarse screens), runs real
 *   `halftoneCmyk` at up to `4×4` supersamples per preview pixel and box-averages to `(pW, pH)`.
 */
function renderSupersampledProxyRgba(proxy, docW, docH, snap, fullChannels = null) {
  const { width: pW, height: pH, channels: proxyCh } = proxy;
  const spec = snap.meshSpec;
  const tMin = spec ? spec.tMin : 0.12;
  const tMax = spec ? spec.tMax : 0.88;
  const tailMode = snap.tailMode || 'hybrid';
  const previewMode = snap.previewMode || 'composite';
  const cellPitchPx = spec ? spec.cellPitchPx : 8;
  const cellPitchPreviewPx = cellPitchPx * (pW / Math.max(1, docW));

  if (cellPitchPreviewPx >= 2.5 && fullChannels) {
    const targetSuperW = Math.min(docW, pW * 4);
    const targetSuperH = Math.min(docH, pH * 4);
    const superSrc = buildAspectPreservingProxy(fullChannels, docW, docH, MAX_PROXY_EDGE, {
      width: targetSuperW,
      height: targetSuperH,
    });
    const dpiScale = superSrc.width / docW;
    const baseDpi = (spec && spec.dpi) || snap.dpi || 300;
    const ht = halftoneCmyk(superSrc.channels, superSrc.width, superSrc.height, {
      meshTpi: snap.meshTpi,
      threadDiaUm: snap.threadDiaUm,
      ruleOfN: snap.ruleOfN,
      dpi: baseDpi * dpiScale,
      lpiOverride: snap.lpiOverride == null ? spec.lpiActive : snap.lpiOverride,
      meshAngleDeg: snap.meshAngleDeg,
      anglesOverride: snap.anglesOverride,
      tailMode,
    });
    const avgPlates = buildAspectPreservingProxy(
      ht.plates,
      superSrc.width,
      superSrc.height,
      MAX_PROXY_EDGE,
      { width: pW, height: pH }
    );
    return renderPreviewRgba(avgPlates.channels, pW, pH, previewMode);
  }

  const transferred = applyFitTailTransferChannels(proxyCh, pW * pH, tMin, tMax, tailMode);
  return renderPreviewRgba(transferred, pW, pH, previewMode);
}

/**
 * Scale an RGBA buffer by `zoom` (`0.5` -> 2x2 box-average, `1` -> identity, `2` -> 2x2 crisp nearest-neighbor).
 */
function scaleRgbaByViewZoom(srcRgba, srcW, srcH, zoom) {
  if (zoom === 1) {
    return { rgba: srcRgba, width: srcW, height: srcH };
  }

  if (zoom === 2) {
    const dstW = srcW * 2;
    const dstH = srcH * 2;
    const dst = new Uint8ClampedArray(dstW * dstH * 4);
    const src32 = new Uint32Array(srcRgba.buffer, srcRgba.byteOffset, srcW * srcH);
    const dst32 = new Uint32Array(dst.buffer);
    for (let y = 0; y < srcH; y++) {
      const sRow = y * srcW;
      const dRow0 = (y * 2) * dstW;
      const dRow1 = dRow0 + dstW;
      for (let x = 0; x < srcW; x++) {
        const px = src32[sRow + x];
        const dx = x * 2;
        dst32[dRow0 + dx] = px;
        dst32[dRow0 + dx + 1] = px;
        dst32[dRow1 + dx] = px;
        dst32[dRow1 + dx + 1] = px;
      }
    }
    return { rgba: dst, width: dstW, height: dstH };
  }

  // zoom === 0.5: 2x2 area box-average
  const dstW = Math.max(1, Math.round(srcW * 0.5));
  const dstH = Math.max(1, Math.round(srcH * 0.5));
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = Math.min(srcH - 1, dy * 2);
    const sy1 = Math.min(srcH - 1, sy0 + 1);
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.min(srcW - 1, dx * 2);
      const sx1 = Math.min(srcW - 1, sx0 + 1);
      const o00 = (sy0 * srcW + sx0) * 4;
      const o10 = (sy0 * srcW + sx1) * 4;
      const o01 = (sy1 * srcW + sx0) * 4;
      const o11 = (sy1 * srcW + sx1) * 4;
      const dOff = (dy * dstW + dx) * 4;
      dst[dOff] = (srcRgba[o00] + srcRgba[o10] + srcRgba[o01] + srcRgba[o11] + 2) >> 2;
      dst[dOff + 1] =
        (srcRgba[o00 + 1] + srcRgba[o10 + 1] + srcRgba[o01 + 1] + srcRgba[o11 + 1] + 2) >> 2;
      dst[dOff + 2] =
        (srcRgba[o00 + 2] + srcRgba[o10 + 2] + srcRgba[o01 + 2] + srcRgba[o11 + 2] + 2) >> 2;
      dst[dOff + 3] = 255;
    }
  }
  return { rgba: dst, width: dstW, height: dstH };
}

/**
 * Resample an arbitrary `(srcW, srcH)` RGBA tile into an exact `(dstW, dstH)` (`256x256`) RGBA buffer
 * for backward-compatible `renderLoupeAtDocCoords` unit tests.
 */
function resampleRgbaToSquareLoupe(srcRgba, srcW, srcH, loupeSize = LOUPE_SIZE) {
  if (srcW === loupeSize && srcH === loupeSize) {
    return srcRgba;
  }

  const out = new Uint8ClampedArray(loupeSize * loupeSize * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 26;
    out[i + 1] = 26;
    out[i + 2] = 26;
    out[i + 3] = 255;
  }

  const aspect = srcW / srcH;
  let drawW = loupeSize;
  let drawH = loupeSize;
  let offX = 0;
  let offY = 0;
  if (Math.abs(aspect - 1) > 1e-3) {
    if (aspect > 1) {
      drawH = Math.max(1, Math.round(loupeSize / aspect));
      offY = (loupeSize - drawH) >> 1;
    } else {
      drawW = Math.max(1, Math.round(loupeSize * aspect));
      offX = (loupeSize - drawW) >> 1;
    }
  }

  if (srcW <= drawW && srcH <= drawH) {
    for (let dy = 0; dy < drawH; dy++) {
      const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / drawH));
      for (let dx = 0; dx < drawW; dx++) {
        const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / drawW));
        const sOff = (sy * srcW + sx) * 4;
        const dOff = ((offY + dy) * loupeSize + (offX + dx)) * 4;
        out[dOff] = srcRgba[sOff];
        out[dOff + 1] = srcRgba[sOff + 1];
        out[dOff + 2] = srcRgba[sOff + 2];
        out[dOff + 3] = 255;
      }
    }
    return out;
  }

  const scaleX = srcW / drawW;
  const scaleY = srcH / drawH;
  for (let dy = 0; dy < drawH; dy++) {
    const y0 = Math.floor(dy * scaleY);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((dy + 1) * scaleY)));
    for (let dx = 0; dx < drawW; dx++) {
      const x0 = Math.floor(dx * scaleX);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((dx + 1) * scaleX)));
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const sOff = (sy * srcW + sx) * 4;
          rSum += srcRgba[sOff];
          gSum += srcRgba[sOff + 1];
          bSum += srcRgba[sOff + 2];
        }
      }
      const cnt = (y1 - y0) * (x1 - x0);
      const dOff = ((offY + dy) * loupeSize + (offX + dx)) * 4;
      out[dOff] = Math.round(rSum / cnt);
      out[dOff + 1] = Math.round(gSum / cnt);
      out[dOff + 2] = Math.round(bSum / cnt);
      out[dOff + 3] = 255;
    }
  }

  return out;
}

class BendayDialog {
  /**
   * @param {Document} doc - DOM document
   * @param {import('../state/BendayState')} state
   * @param {object} callbacks
   * @param {Function} callbacks.onApply
   * @param {Function} callbacks.onCancel
   * @param {Function} [callbacks.onReread]
   * @param {Function} [callbacks.onRequestCrop]
   */
  constructor(doc, state, callbacks = {}) {
    this.doc = doc;
    this.state = state;
    this.callbacks = callbacks;

    this._fullData = null; // { channels: { C, M, Y, K }, width, height, dpi }
    this._proxy = null;    // { width, height, scaleX, scaleY, channels }
    this._meanInkPct = { C: 0, M: 0, Y: 0, K: 0 };

    // Cached current-view PNG data URLs for < 2 ms zero-lag ORIGINAL <-> Halftone toggle
    this._halftoneDataUrl = '';
    this._originalDataUrl = '';

    // Blink Comparator & Pan state
    this._showingOriginal = false;
    this._holdTimer = null;
    this._blinkInterval = null;
    this._blinkMode = false;
    this._dragState = null;
    this._suppressNextClickUntil = 0;

    // Viewport virtualization state
    this._scrollDebounceTimer = null;
    this._lastZoomValue = this.state.viewZoom;
    this._viewCenterNorm = { x: 0.5, y: 0.5 };

    // Direct .visible UI state flags
    this._helpVisible = false;
    this._customMeshExpanded = false;

    this._isApplying = false;

    this._bindElements();
    this._populateMeshPresetsIfNeeded();
    this._attachListeners();
    this._unsubscribe = this.state.subscribe((snap, reason) => {
      this._onStateChange(snap, reason);
    });
    this.renderControls(this.state.getSnapshot());
  }

  destroy() {
    this._clearBlinkTimers();
    if (this._scrollDebounceTimer) {
      clearTimeout(this._scrollDebounceTimer);
      this._scrollDebounceTimer = null;
    }
    if (this._keyHandler && this.doc) {
      this.doc.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  _el(id) {
    return this.doc.getElementById(id);
  }

  _bindElements() {
    this.els = {
      root: this._el('benday-dialog-root'),
      docTitle: this._el('benday-doc-title'),
      statMeshLpi: this._el('stat-mesh-lpi'),
      statMinDot: this._el('stat-min-dot'),
      moireBadge: this._el('moire-status-badge'),
      previewStatus: this._el('benday-preview-status'),

      loupeZoom: this._el('loupe-zoom'),
      btnZoomOut: this._el('btn-zoom-out'),
      previewZoom: this._el('preview-zoom'),
      btnZoomIn: this._el('btn-zoom-in'),
      btnHelpToggle: this._el('btn-help-toggle'),

      previewContainer: this._el('preview-container'),
      previewScrollSizer: this._el('preview-scroll-sizer'),
      previewImg: this._el('preview-img'),
      previewPlaceholder: this._el('preview-placeholder'),
      originalBadge: this._el('original-badge'),

      loupeContainer: this._el('loupe-container'),
      loupeImg: this._el('loupe-img'),
      loupeModePill: this._el('loupe-mode-pill'),
      loupeCoords: this._el('loupe-coords'),

      swatchMetaC: this._el('swatch-meta-C'),
      swatchMetaM: this._el('swatch-meta-M'),
      swatchMetaY: this._el('swatch-meta-Y'),
      swatchMetaK: this._el('swatch-meta-K'),

      btnReread: this._el('btn-reread'),
      btnResetTop: this._el('btn-reset-top'),
      btnCancel: this._el('btn-benday-cancel'),
      btnApply: this._el('btn-benday-apply'),

      meshPreset: this._el('input-mesh-preset'),
      customMeshRow: this._el('custom-mesh-row'),
      meshTpi: this._el('input-mesh-tpi'),
      threadUm: this._el('input-thread-um'),
      btnMeshRevert: this._el('btn-mesh-revert'),

      meshAngleSlider: this._el('input-mesh-angle-slider'),
      meshAngleNum: this._el('input-mesh-angle-num'),
      btnMeshAngleRevert: this._el('btn-mesh-angle-revert'),

      ruleNSlider: this._el('input-rule-n-slider'),
      ruleNVal: this._el('readout-rule-n'),
      btnRuleNRevert: this._el('btn-rule-n-revert'),

      lpiInput: this._el('input-lpi-override'),
      lpiHint: this._el('readout-lpi-hint'),
      btnLpiAuto: this._el('btn-lpi-auto'),

      btnTailRevert: this._el('btn-tail-revert'),

      angleC: this._el('input-angle-c'),
      angleM: this._el('input-angle-m'),
      angleY: this._el('input-angle-y'),
      angleK: this._el('input-angle-k'),
      btnAnglesAuto: this._el('btn-angles-auto'),
      moireDetail: this._el('moire-status-detail'),

      physOpenArea: this._el('phys-open-area'),
      physMinDot: this._el('phys-min-dot'),
      physAmRange: this._el('phys-am-range'),
      warningsBox: this._el('benday-warnings-box'),
      errorBanner: this._el('benday-error-banner'),
    };
  }

  _populateMeshPresetsIfNeeded() {
    const sel = this.els.meshPreset;
    if (!sel || sel.options.length > 0) return;
    for (let i = 0; i < SAATI_MESH_PRESETS.length; i++) {
      const p = SAATI_MESH_PRESETS[i];
      const opt = this.doc.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === '230-48') opt.selected = true;
      sel.appendChild(opt);
    }
    const customOpt = this.doc.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom (TPI / µm)…';
    sel.appendChild(customOpt);
  }

  _setHelpVisibility(visible) {
    this._helpVisible = Boolean(visible);
    if (this.els.btnHelpToggle) {
      if (this._helpVisible) this.els.btnHelpToggle.classList.add('active');
      else this.els.btnHelpToggle.classList.remove('active');
    }
    this.doc.querySelectorAll('.knob-help').forEach((el) => {
      setElementVisible(el, this._helpVisible, 'block');
    });
  }

  _bindSliderControl(el, onNumericValue) {
    if (!el) return;
    const handler = () => {
      const val = readControlNumber(el);
      if (Number.isFinite(val)) {
        onNumericValue(val);
      }
    };
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  }

  _bindLiveNumberInput(el, onValue) {
    if (!el) return;
    const onInput = () => {
      const raw = String(el.value || '').trim();
      // Wait if user is mid-typing a trailing decimal point or minus sign
      if (raw.endsWith('.') || raw === '-') return;
      onValue(raw);
    };
    const onChange = () => {
      const raw = String(el.value || '').trim();
      onValue(raw);
    };
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
  }

  _attachListeners() {
    const { els } = this;

    // Bottom Screen Strip swatches (click active solo channel again -> return to composite!)
    const modeBtns = this.doc.querySelectorAll('[data-preview-mode]');
    modeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetMode = btn.getAttribute('data-preview-mode');
        if (targetMode !== 'composite' && this.state.previewMode === targetMode) {
          this.state.setPreviewMode('composite');
        } else {
          this.state.setPreviewMode(targetMode);
        }
      });
    });

    // Keyboard shortcuts: Escape un-solos channel (or dismisses modal); Cmd/Ctrl + 0 / 1 / + / - controls Zoom
    this._keyHandler = (e) => {
      if (e.key === 'Escape') {
        if (this.state.previewMode !== 'composite') {
          e.preventDefault();
          e.stopPropagation();
          this.state.setPreviewMode('composite');
        } else if (!this._isApplying && this.callbacks.onCancel) {
          this.callbacks.onCancel();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey) {
        if (e.key === '0') {
          e.preventDefault();
          this.state.setViewZoom('fit');
        } else if (e.key === '1') {
          e.preventDefault();
          this.state.setViewZoom(1);
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          this.state.zoomIn();
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          this.state.zoomOut();
        }
      }
    };
    this.doc.addEventListener('keydown', this._keyHandler);

    // Header Zoom controls (Fit / 50% / 100% / 200%)
    if (els.previewZoom) {
      els.previewZoom.addEventListener('change', () => {
        const v = els.previewZoom.value;
        this.state.setViewZoom(v === 'fit' ? 'fit' : Number(v));
      });
    }
    if (els.btnZoomIn) {
      els.btnZoomIn.addEventListener('click', () => {
        this.state.zoomIn();
      });
    }
    if (els.btnZoomOut) {
      els.btnZoomOut.addEventListener('click', () => {
        this.state.zoomOut();
      });
    }

    // Legacy Loupe zoom select kept functional if invoked by unit tests (hidden in live UI)
    if (els.loupeZoom) {
      els.loupeZoom.addEventListener('change', () => {
        const z = readControlNumber(els.loupeZoom);
        if (Number.isFinite(z)) {
          this.state.setPreviewZoom(z);
        }
      });
    }

    // Parameter Help (?) toggle — toggles .visible directly on every .knob-help element
    if (els.btnHelpToggle) {
      els.btnHelpToggle.addEventListener('click', () => {
        this._setHelpVisibility(!this._helpVisible);
      });
    }

    // Zero-lag Blink Comparator + Click-Drag Viewport Panning + Scroll Virtualization
    this._bindViewportInteraction();

    // Top action buttons
    if (els.btnReread) {
      els.btnReread.addEventListener('click', async () => {
        if (this._isApplying) return;
        this._setHelpVisibility(false);
        if (this.callbacks.onReread) {
          await this.callbacks.onReread();
        } else if (this.callbacks.onRequestCrop) {
          await this.callbacks.onRequestCrop(this.state.cropCenter);
        }
      });
    }

    if (els.btnResetTop) {
      els.btnResetTop.addEventListener('click', () => {
        if (this._isApplying) return;
        this._customMeshExpanded = false;
        this._setHelpVisibility(false);
        this.state.resetToDefaults();
      });
    }

    if (els.btnCancel) {
      els.btnCancel.addEventListener('click', () => {
        if (!this._isApplying && this.callbacks.onCancel) {
          this.callbacks.onCancel();
        }
      });
    }

    if (els.btnApply) {
      els.btnApply.addEventListener('click', async () => {
        if (this._isApplying || this.state.error) return;
        if (this.callbacks.onApply) {
          await this.callbacks.onApply();
        }
      });
    }

    // SAATI paired Screen Mesh preset dropdown + Custom (TPI / µm) inline row + Revert
    if (els.meshPreset) {
      els.meshPreset.addEventListener('change', () => {
        const val = els.meshPreset.value;
        if (val === 'custom') {
          this._customMeshExpanded = true;
          setElementVisible(els.customMeshRow, true, 'flex');
          return;
        }
        this._customMeshExpanded = false;
        const match = SAATI_MESH_PRESETS.find((p) => p.id === val);
        if (match) {
          this.state.setMeshPreset(match.meshTpi, match.threadDiaUm);
        }
      });
    }

    this._bindLiveNumberInput(els.meshTpi, (raw) => {
      if (raw === '') return;
      const val = Number(raw);
      if (Number.isFinite(val) && val > 0 && val !== this.state.meshTpi) {
        this._customMeshExpanded = true;
        this.state.setMeshPreset(val, this.state.threadDiaUm);
      }
    });

    this._bindLiveNumberInput(els.threadUm, (raw) => {
      if (raw === '') return;
      const val = Number(raw);
      if (Number.isFinite(val) && val > 0 && Math.abs(val - this.state.threadDiaUm) > 1e-6) {
        this._customMeshExpanded = true;
        this.state.setMeshPreset(this.state.meshTpi, val);
      }
    });

    if (els.btnMeshRevert) {
      els.btnMeshRevert.addEventListener('click', () => {
        this._customMeshExpanded = false;
        this.state.setMeshPreset(230, 48);
      });
    }

    // Mesh bias angle <sp-slider> + live numeric input + revert
    this._bindSliderControl(els.meshAngleSlider, (val) => {
      if (Math.abs(val - this.state.meshAngleDeg) > 1e-6) {
        this.state.setMeshAngleDeg(val);
      }
    });
    this._bindLiveNumberInput(els.meshAngleNum, (raw) => {
      if (raw === '') return;
      const val = Number(raw);
      if (Number.isFinite(val) && Math.abs(val - this.state.meshAngleDeg) > 1e-6) {
        this.state.setMeshAngleDeg(val);
      }
    });
    if (els.btnMeshAngleRevert) {
      els.btnMeshAngleRevert.addEventListener('click', () => {
        this.state.setMeshAngleDeg(0);
      });
    }

    // Rule of N <sp-slider> + revert (default 5.0)
    this._bindSliderControl(els.ruleNSlider, (val) => {
      if (Math.abs(val - this.state.ruleOfN) > 1e-6) {
        this.state.setRuleOfN(val);
      }
    });
    if (els.btnRuleNRevert) {
      els.btnRuleNRevert.addEventListener('click', () => {
        this.state.setRuleOfN(5.0);
      });
    }

    // LPI override ('input' + 'change') & Auto revert
    this._bindLiveNumberInput(els.lpiInput, (raw) => {
      const nextVal = raw === '' ? null : Number(raw);
      if (nextVal === null && this.state.lpiOverride === null) return;
      if (nextVal !== null && Number.isFinite(nextVal) && this.state.lpiOverride === nextVal) return;
      this.state.setLpiOverride(nextVal);
    });
    if (els.btnLpiAuto) {
      els.btnLpiAuto.addEventListener('click', () => {
        if (els.lpiInput) els.lpiInput.value = '';
        this.state.resetLpiAuto();
      });
    }

    // Tail mode filter chips + revert
    const tailBtns = this.doc.querySelectorAll('[data-tail-mode]');
    tailBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.setTailMode(btn.getAttribute('data-tail-mode'));
      });
    });
    if (els.btnTailRevert) {
      els.btnTailRevert.addEventListener('click', () => {
        this.state.setTailMode('hybrid');
      });
    }

    // Rosette angles ('input' + 'change') & Auto revert
    const angleInputs = [
      ['C', els.angleC],
      ['M', els.angleM],
      ['Y', els.angleY],
      ['K', els.angleK],
    ];
    for (const [ch, inputEl] of angleInputs) {
      this._bindLiveNumberInput(inputEl, (raw) => {
        if (raw === '') return;
        const val = Number(raw);
        if (Number.isFinite(val)) {
          this.state.setChannelAngle(ch, val);
        }
      });
    }
    if (els.btnAnglesAuto) {
      els.btnAnglesAuto.addEventListener('click', () => {
        this.state.resetAnglesAuto();
      });
    }
  }

  _clearBlinkTimers() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._blinkInterval) {
      clearInterval(this._blinkInterval);
      this._blinkInterval = null;
    }
  }

  /**
   * Swap cached `src` strings in `< 2 ms` with zero halftone recomputation and zero Loupe overhead.
   * Encodes `_originalDataUrl` lazily on first click for a given viewport/mode so slider drags skip it.
   */
  _applyOriginalToggleView(showOrig) {
    if (!this._fullData || !this.els.previewImg) return;
    this._showingOriginal = Boolean(showOrig);
    if (this._showingOriginal && !this._originalDataUrl && typeof this._buildLazyOriginalUrl === 'function') {
      this._originalDataUrl = this._buildLazyOriginalUrl();
    }
    this.els.previewImg.src = this._showingOriginal
      ? this._originalDataUrl
      : this._halftoneDataUrl;
    setElementVisible(this.els.originalBadge, this._showingOriginal, 'block');
  }

  _scheduleViewportScrollRender() {
    if (this._scrollDebounceTimer) {
      clearTimeout(this._scrollDebounceTimer);
    }
    this._scrollDebounceTimer = setTimeout(() => {
      this._scrollDebounceTimer = null;
      if (this._fullData && typeof this.state.viewZoom === 'number') {
        this._recordScrollCenter();
        this._renderMainPreview(true);
      }
    }, 40);
  }

  _recordScrollCenter() {
    const container = this.els.previewContainer;
    if (!container || !this._fullData || typeof this.state.viewZoom !== 'number') return;
    const zoom = this.state.viewZoom;
    const sizerW = Math.max(1, Math.round(this._fullData.width * zoom));
    const sizerH = Math.max(1, Math.round(this._fullData.height * zoom));
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw > 0 && ch > 0) {
      this._viewCenterNorm = {
        x: Math.max(0, Math.min(1, (container.scrollLeft + cw * 0.5) / sizerW)),
        y: Math.max(0, Math.min(1, (container.scrollTop + ch * 0.5) / sizerH)),
      };
    }
  }

  _bindViewportInteraction() {
    const container = this.els.previewContainer;
    const img = this.els.previewImg;
    if (!container) return;

    container.addEventListener('scroll', () => {
      if (!this._fullData || typeof this.state.viewZoom !== 'number') return;
      this._scheduleViewportScrollRender();
    });

    const onPointerDown = (e) => {
      if (!this._fullData) return;
      if (e.button != null && e.button !== 0) return;

      this._clearBlinkTimers();
      this._blinkMode = false;
      this._dragState = {
        startX: e.clientX || 0,
        startY: e.clientY || 0,
        scrollL: container.scrollLeft || 0,
        scrollT: container.scrollTop || 0,
        moved: false,
      };

      this._holdTimer = setTimeout(() => {
        if (this._dragState && !this._dragState.moved) {
          this._blinkMode = true;
          this._applyOriginalToggleView(true);
          this._blinkInterval = setInterval(() => {
            this._applyOriginalToggleView(!this._showingOriginal);
          }, 400);
        }
      }, 320);
    };

    const onPointerMove = (e) => {
      if (!this._dragState) return;
      const dx = (e.clientX || 0) - this._dragState.startX;
      const dy = (e.clientY || 0) - this._dragState.startY;
      if (!this._dragState.moved && Math.hypot(dx, dy) >= 4) {
        this._dragState.moved = true;
        this._clearBlinkTimers();
        if (this._blinkMode) {
          this._blinkMode = false;
          this._applyOriginalToggleView(false);
        }
        if (typeof this.state.viewZoom === 'number') {
          container.classList.add('is-panning');
        }
      }

      if (this._dragState.moved && typeof this.state.viewZoom === 'number') {
        container.scrollLeft = Math.max(0, this._dragState.scrollL - dx);
        container.scrollTop = Math.max(0, this._dragState.scrollT - dy);
        this._scheduleViewportScrollRender();
      }
    };

    const onPointerUp = () => {
      if (!this._dragState) return;
      const wasMoved = this._dragState.moved;
      const wasBlink = this._blinkMode;
      this._dragState = null;
      container.classList.remove('is-panning');
      this._clearBlinkTimers();

      if (wasBlink) {
        this._blinkMode = false;
        this._applyOriginalToggleView(false);
      } else if (!wasMoved) {
        this._applyOriginalToggleView(!this._showingOriginal);
        this._suppressNextClickUntil = Date.now() + 100;
      }
    };

    const onPointerCancelOrLeave = () => {
      if (!this._dragState) return;
      const wasBlink = this._blinkMode;
      this._dragState = null;
      container.classList.remove('is-panning');
      this._clearBlinkTimers();
      if (wasBlink) {
        this._blinkMode = false;
        this._applyOriginalToggleView(false);
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointerleave', onPointerCancelOrLeave);
    container.addEventListener('pointercancel', onPointerCancelOrLeave);

    if (img) {
      img.addEventListener('click', () => {
        if (!this._fullData) return;
        if (Date.now() < this._suppressNextClickUntil) return;
        this._applyOriginalToggleView(!this._showingOriginal);
      });
    }
  }

  /**
   * Populate full continuous-tone CMYK document channels `{ channels: { C, M, Y, K }, width, height, dpi }`,
   * build the aspect-preserving proxy (`<= 840px` long edge), compute per-screen mean ink %, and render
   * the initial halftone `<img src="data:image/png;base64,...">`.
   */
  setFullDocumentData(fullData) {
    this._clearBlinkTimers();
    this._showingOriginal = false;
    this._blinkMode = false;
    this._viewCenterNorm = { x: 0.5, y: 0.5 };
    this._origUrlCacheKey = '';
    this._buildLazyOriginalUrl = null;
    setElementVisible(this.els.originalBadge, false, 'block');

    if (!fullData || !fullData.channels || !(fullData.width > 0) || !(fullData.height > 0)) {
      this._fullData = null;
      this._proxy = null;
      this._halftoneDataUrl = '';
      this._originalDataUrl = '';
      if (this.els.previewImg) {
        this.els.previewImg.removeAttribute('src');
        setElementVisible(this.els.previewImg, false, 'block');
      }
      if (this.els.previewPlaceholder) {
        this.els.previewPlaceholder.style.display = 'block';
      }
      this.renderControls(this.state.getSnapshot());
      return;
    }

    this._fullData = fullData;
    this._proxy = buildAspectPreservingProxy(
      fullData.channels,
      fullData.width,
      fullData.height,
      MAX_PROXY_EDGE
    );

    const pCount = this._proxy.width * this._proxy.height;
    for (let c = 0; c < CHANNEL_KEYS.length; c++) {
      const k = CHANNEL_KEYS[c];
      const arr = this._proxy.channels[k];
      let sum = 0;
      for (let i = 0; i < pCount; i++) sum += arr[i];
      this._meanInkPct[k] = Math.round((sum / (pCount * 255)) * 100);
    }

    this.renderControls(this.state.getSnapshot());
    this._renderMainPreview(false);
  }

  /**
   * Backward-compatible alias for `setFullDocumentData` (used by unit tests & small crop callers).
   */
  setPreviewCropData(cropData) {
    this.setFullDocumentData(cropData);
  }

  /**
   * Render a pixel-accurate `256x256` Loupe PNG centered at native document coordinates `(docX, docY)`
   * using `@electrosaur-labs/benday-core`'s `halftoneCmyk` engine. Kept functional for direct unit-test
   * invocation; Loupe UI listeners are disabled in live Photoshop UXP.
   *
   * @param {number} docX
   * @param {number} docY
   * @returns {string|null} `data:image/png;base64,...` URL
   */
  renderLoupeAtDocCoords(docX, docY) {
    if (!this._fullData || !this.els.loupeImg) return null;
    const snap = this.state.getSnapshot();
    const factor = snap.previewZoom > 0 ? snap.previewZoom : 1;
    if (snap.error || !snap.meshSpec) {
      return null;
    }

    const docW = this._fullData.width;
    const docH = this._fullData.height;
    const spanW = Math.min(docW, LOUPE_SIZE * factor);
    const spanH = Math.min(docH, LOUPE_SIZE * factor);

    const left = Math.max(0, Math.min(docW - spanW, Math.round(docX - spanW * 0.5)));
    const top = Math.max(0, Math.min(docH - spanH, Math.round(docY - spanH * 0.5)));

    const step = factor === 4 && spanW >= 512 && spanH >= 512 ? 2 : 1;
    const tileW = Math.max(1, Math.floor(spanW / step));
    const tileH = Math.max(1, Math.floor(spanH / step));
    const tileCh = {};
    for (let c = 0; c < CHANNEL_KEYS.length; c++) {
      const k = CHANNEL_KEYS[c];
      const src = this._fullData.channels[k];
      const dst = new Uint8Array(tileW * tileH);
      if (step === 1) {
        for (let y = 0; y < tileH; y++) {
          const sOff = (top + y) * docW + left;
          dst.set(src.subarray(sOff, sOff + tileW), y * tileW);
        }
      } else {
        for (let y = 0; y < tileH; y++) {
          const sy0 = top + y * 2;
          const r0 = sy0 * docW + left;
          const r1 = (sy0 + 1) * docW + left;
          const dRow = y * tileW;
          for (let x = 0; x < tileW; x++) {
            const sx = x * 2;
            dst[dRow + x] =
              (src[r0 + sx] + src[r0 + sx + 1] + src[r1 + sx] + src[r1 + sx + 1] + 2) >> 2;
          }
        }
      }
      tileCh[k] = dst;
    }

    let tileRgba;
    if (this._showingOriginal) {
      tileRgba = renderPreviewRgba(tileCh, tileW, tileH, snap.previewMode);
    } else {
      const baseDpi = this._fullData.dpi || snap.dpi || 300;
      const cfg = {
        ...this.state.exportEngineConfig(),
        dpi: baseDpi / step,
        originX: (docW * 0.5 - left) / step,
        originY: (docH * 0.5 - top) / step,
      };
      const ht = halftoneCmyk(tileCh, tileW, tileH, cfg);
      tileRgba = renderPreviewRgba(ht.plates, tileW, tileH, snap.previewMode);
    }

    const loupeRgba = resampleRgbaToSquareLoupe(tileRgba, tileW, tileH, LOUPE_SIZE);
    const dataUrl = encodeRgbaToPngDataUrl(loupeRgba, LOUPE_SIZE, LOUPE_SIZE);
    this.els.loupeImg.src = dataUrl;

    if (this.els.loupeModePill) {
      const modeTag = snap.previewMode === 'composite' ? '' : ` · ${snap.previewMode}`;
      this.els.loupeModePill.textContent = `1:${factor} · ${snap.meshSpec.lpiActive.toFixed(1)} LPI${modeTag}`;
    }
    if (this.els.loupeCoords) {
      this.els.loupeCoords.textContent = `${docX}, ${docY}`;
    }

    return dataUrl;
  }

  _renderZoomedViewport(snap, preserveShowingOriginal = false) {
    const zoom = snap.viewZoom;
    const { width: docW, height: docH, dpi: docDpi, channels: fullCh } = this._fullData;
    const container = this.els.previewContainer;
    const sizer = this.els.previewScrollSizer;
    const img = this.els.previewImg;

    const sizerW = Math.max(1, Math.round(docW * zoom));
    const sizerH = Math.max(1, Math.round(docH * zoom));

    if (container) container.classList.toggle('is-zoomed', true);
    if (sizer) {
      sizer.style.width = `${sizerW}px`;
      sizer.style.height = `${sizerH}px`;
    }

    const contW = container ? container.clientWidth : 0;
    const contH = container ? container.clientHeight : 0;

    let docL = 0;
    let docT = 0;
    let docR = docW;
    let docB = docH;

    if (sizerW > MAX_DIRECT_ZOOM_EDGE || sizerH > MAX_DIRECT_ZOOM_EDGE) {
      const effContW = contW > 0 ? contW : 840;
      const effContH = contH > 0 ? contH : 720;
      const scrollL = container
        ? Math.max(0, Math.min(Math.max(0, sizerW - effContW), container.scrollLeft || 0))
        : 0;
      const scrollT = container
        ? Math.max(0, Math.min(Math.max(0, sizerH - effContH), container.scrollTop || 0))
        : 0;

      const align = zoom === 0.5 ? 2 : 1;
      docL = Math.max(0, Math.min(docW - 1, Math.floor(scrollL / zoom / align) * align));
      docT = Math.max(0, Math.min(docH - 1, Math.floor(scrollT / zoom / align) * align));
      docR = Math.max(
        docL + 1,
        Math.min(docW, Math.ceil((scrollL + effContW) / zoom / align) * align)
      );
      docB = Math.max(
        docT + 1,
        Math.min(docH, Math.ceil((scrollT + effContH) / zoom / align) * align)
      );
    }

    const haloL = Math.max(0, docL - VIEWPORT_HALO_PX);
    const haloT = Math.max(0, docT - VIEWPORT_HALO_PX);
    const haloR = Math.min(docW, docR + VIEWPORT_HALO_PX);
    const haloB = Math.min(docH, docB + VIEWPORT_HALO_PX);
    const haloW = haloR - haloL;
    const haloH = haloB - haloT;

    const activeKeys = snap.previewMode === 'composite' ? CHANNEL_KEYS : [snap.previewMode];
    let haloCh;
    if (haloL === 0 && haloT === 0 && haloW === docW && haloH === docH) {
      haloCh = fullCh;
    } else {
      haloCh = {};
      for (let c = 0; c < activeKeys.length; c++) {
        const key = activeKeys[c];
        const src = fullCh[key];
        const dst = new Uint8Array(haloW * haloH);
        for (let y = 0; y < haloH; y++) {
          const sOff = (haloT + y) * docW + haloL;
          dst.set(src.subarray(sOff, sOff + haloW), y * haloW);
        }
        haloCh[key] = dst;
      }
    }

    let rawPlates;
    if (snap.previewMode === 'composite') {
      const cfg = {
        ...this.state.exportEngineConfig(),
        dpi: docDpi || snap.dpi,
        originX: docW * 0.5 - haloL,
        originY: docH * 0.5 - haloT,
      };
      rawPlates = halftoneCmyk(haloCh, haloW, haloH, cfg).plates;
    } else {
      const soloKey = snap.previewMode;
      rawPlates = {
        [soloKey]: halftoneChannel(haloCh[soloKey], haloW, haloH, {
          meshSpec: snap.meshSpec,
          angleDeg: snap.angles[soloKey],
          tailMode: snap.tailMode || 'hybrid',
          channelKey: soloKey,
          originX: docW * 0.5 - haloL,
          originY: docH * 0.5 - haloT,
        }),
      };
    }

    const cropW = docR - docL;
    const cropH = docB - docT;
    const trimX = docL - haloL;
    const trimY = docT - haloT;

    let croppedPlates;
    let croppedOrig;
    if (trimX === 0 && trimY === 0 && cropW === haloW && cropH === haloH) {
      croppedPlates = rawPlates;
      croppedOrig = haloCh;
    } else {
      croppedPlates = {};
      croppedOrig = {};
      for (let c = 0; c < activeKeys.length; c++) {
        const key = activeKeys[c];
        const pSrc = rawPlates[key];
        const oSrc = haloCh[key];
        const pDst = new Uint8Array(cropW * cropH);
        const oDst = new Uint8Array(cropW * cropH);
        for (let y = 0; y < cropH; y++) {
          const sOff = (trimY + y) * haloW + trimX;
          const dOff = y * cropW;
          pDst.set(pSrc.subarray(sOff, sOff + cropW), dOff);
          oDst.set(oSrc.subarray(sOff, sOff + cropW), dOff);
        }
        croppedPlates[key] = pDst;
        croppedOrig[key] = oDst;
      }
    }

    const htNativeRgba = renderPreviewRgba(croppedPlates, cropW, cropH, snap.previewMode);
    const htScaled = scaleRgbaByViewZoom(htNativeRgba, cropW, cropH, zoom);
    this._halftoneDataUrl = encodeRgbaToPngDataUrl(htScaled.rgba, htScaled.width, htScaled.height);

    const origCacheKey = `zoom:${docL},${docT},${cropW},${cropH},${zoom},${snap.previewMode}`;
    if (this._origUrlCacheKey !== origCacheKey) {
      this._origUrlCacheKey = origCacheKey;
      this._originalDataUrl = '';
    }
    this._buildLazyOriginalUrl = () => {
      const origNativeRgba = renderPreviewRgba(croppedOrig, cropW, cropH, snap.previewMode);
      const origScaled = scaleRgbaByViewZoom(origNativeRgba, cropW, cropH, zoom);
      return encodeRgbaToPngDataUrl(origScaled.rgba, origScaled.width, origScaled.height);
    };

    if (!preserveShowingOriginal) {
      this._showingOriginal = false;
    }
    if (this._showingOriginal && !this._originalDataUrl) {
      this._originalDataUrl = this._buildLazyOriginalUrl();
    }
    setElementVisible(this.els.originalBadge, this._showingOriginal, 'block');

    img.style.left = `${Math.round(docL * zoom)}px`;
    img.style.top = `${Math.round(docT * zoom)}px`;
    img.style.width = `${htScaled.width}px`;
    img.style.height = `${htScaled.height}px`;
    img.src = this._showingOriginal ? this._originalDataUrl : this._halftoneDataUrl;
    setElementVisible(img, true, 'block');

    if (this.els.previewPlaceholder) {
      this.els.previewPlaceholder.style.display = 'none';
    }

    return { width: htScaled.width, height: htScaled.height, label: `${Math.round(zoom * 100)}%` };
  }

  _renderMainPreview(preserveShowingOriginal = false) {
    if (!this._fullData || !this._proxy || !this.els.previewImg) return;
    const snap = this.state.getSnapshot();
    if (snap.error || !snap.meshSpec) return;

    const t0 = Date.now();

    if (typeof snap.viewZoom === 'number') {
      const info = this._renderZoomedViewport(snap, preserveShowingOriginal);
      const elapsed = Date.now() - t0;
      this.setStatusText(`${info.label} (${info.width}×${info.height} px) · ${elapsed} ms`);
      return;
    }

    // Fit mode
    const { width: docW, height: docH, dpi: docDpi } = this._fullData;
    const { width: pW, height: pH } = this._proxy;

    if (this.els.previewContainer) {
      this.els.previewContainer.classList.toggle('is-zoomed', false);
    }
    if (this.els.previewScrollSizer) {
      this.els.previewScrollSizer.style.width = '';
      this.els.previewScrollSizer.style.height = '';
    }

    let htRgba;
    if (docW === pW && docH === pH && docW * docH <= 320 * 320) {
      const cfg = {
        ...this.state.exportEngineConfig(),
        dpi: docDpi || snap.dpi,
      };
      const res = halftoneCmyk(this._fullData.channels, docW, docH, cfg);
      htRgba = renderPreviewRgba(res.plates, docW, docH, snap.previewMode);
    } else {
      htRgba = renderSupersampledProxyRgba(
        this._proxy,
        docW,
        docH,
        snap,
        this._fullData.channels
      );
    }

    this._halftoneDataUrl = encodeRgbaToPngDataUrl(htRgba, pW, pH);
    const fitOrigKey = `fit:${pW},${pH},${snap.previewMode}`;
    if (this._origUrlCacheKey !== fitOrigKey) {
      this._origUrlCacheKey = fitOrigKey;
      this._originalDataUrl = '';
    }
    this._buildLazyOriginalUrl = () => {
      const origRgba = renderPreviewRgba(this._proxy.channels, pW, pH, snap.previewMode);
      return encodeRgbaToPngDataUrl(origRgba, pW, pH);
    };

    if (!preserveShowingOriginal) {
      this._showingOriginal = false;
    }
    if (this._showingOriginal && !this._originalDataUrl) {
      this._originalDataUrl = this._buildLazyOriginalUrl();
    }
    setElementVisible(this.els.originalBadge, this._showingOriginal, 'block');

    const img = this.els.previewImg;
    img.style.left = '';
    img.style.top = '';
    img.style.width = '';
    img.style.height = '';
    img.src = this._showingOriginal ? this._originalDataUrl : this._halftoneDataUrl;
    setElementVisible(img, true, 'block');

    if (this.els.previewPlaceholder) {
      this.els.previewPlaceholder.style.display = 'none';
    }

    const elapsed = Date.now() - t0;
    this.setStatusText(`Fit (${pW}×${pH}) · ${elapsed} ms`);
  }

  setStatusText(msg) {
    if (this.els.previewStatus) {
      this.els.previewStatus.textContent = msg || '';
    }
  }

  setApplying(applying, progressMsg) {
    this._isApplying = Boolean(applying);
    if (this.els.btnApply) {
      this.els.btnApply.disabled = this._isApplying || Boolean(this.state.error);
      this.els.btnApply.textContent = this._isApplying ? 'Applying…' : 'Apply Halftone';
    }
    if (this.els.btnCancel) {
      this.els.btnCancel.disabled = this._isApplying;
    }
    if (this.els.btnReread) {
      this.els.btnReread.disabled = this._isApplying;
    }
    if (progressMsg != null) {
      this.setStatusText(progressMsg);
    }
  }

  _syncScrollForZoomTransition(nextZoom) {
    const container = this.els.previewContainer;
    if (!container || !this._fullData) {
      this._lastZoomValue = nextZoom;
      return;
    }

    if (typeof this._lastZoomValue === 'number') {
      this._recordScrollCenter();
    }

    if (typeof nextZoom === 'number') {
      const sizerW = Math.max(1, Math.round(this._fullData.width * nextZoom));
      const sizerH = Math.max(1, Math.round(this._fullData.height * nextZoom));
      if (this.els.previewScrollSizer) {
        this.els.previewScrollSizer.style.width = `${sizerW}px`;
        this.els.previewScrollSizer.style.height = `${sizerH}px`;
      }
      container.classList.toggle('is-zoomed', true);
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw > 0 && ch > 0) {
        container.scrollLeft = Math.max(0, Math.round(this._viewCenterNorm.x * sizerW - cw * 0.5));
        container.scrollTop = Math.max(0, Math.round(this._viewCenterNorm.y * sizerH - ch * 0.5));
      }
    } else {
      container.scrollLeft = 0;
      container.scrollTop = 0;
      this._viewCenterNorm = { x: 0.5, y: 0.5 };
    }

    this._lastZoomValue = nextZoom;
  }

  _onStateChange(snap, reason) {
    this.renderControls(snap);
    if (reason === 'previewZoom') {
      return;
    }
    if (reason === 'viewZoom') {
      this._syncScrollForZoomTransition(snap.viewZoom);
      this._renderMainPreview(this._showingOriginal);
      return;
    }
    if (reason !== 'cropCenter') {
      this._renderMainPreview(false);
    }
  }

  renderControls(snap) {
    const { els } = this;
    const activeEl = this.doc ? this.doc.activeElement : null;

    if (els.docTitle) {
      els.docTitle.textContent = `${snap.docName} — ${snap.docWidth}×${snap.docHeight} @ ${snap.dpi} DPI`;
    }

    // Header Zoom controls
    if (els.previewZoom) {
      els.previewZoom.value = String(snap.viewZoom);
    }
    if (els.btnZoomOut) {
      els.btnZoomOut.disabled = snap.viewZoom === 'fit';
    }
    if (els.btnZoomIn) {
      els.btnZoomIn.disabled = snap.viewZoom === 2;
    }

    if (els.loupeZoom) {
      els.loupeZoom.value = String(snap.previewZoom);
    }

    // Sync screen swatch bar & per-channel angle/coverage metadata
    this.doc.querySelectorAll('[data-preview-mode]').forEach((btn) => {
      const active = btn.getAttribute('data-preview-mode') === snap.previewMode;
      btn.classList.toggle('is-active', active);
    });

    const swatchMap = [
      ['C', els.swatchMetaC],
      ['M', els.swatchMetaM],
      ['Y', els.swatchMetaY],
      ['K', els.swatchMetaK],
    ];
    for (const [key, metaEl] of swatchMap) {
      if (metaEl) {
        const degTxt = snap.angles[key].toFixed(1).replace(/\.0$/, '');
        const pctTxt = this._fullData ? `${this._meanInkPct[key]}%` : '--%';
        metaEl.textContent = `${degTxt}° · ${pctTxt}`;
      }
    }

    // Sync Tail Mode filter chips
    this.doc.querySelectorAll('[data-tail-mode]').forEach((btn) => {
      const active = btn.getAttribute('data-tail-mode') === snap.tailMode;
      btn.classList.toggle('is-active', active);
      btn.classList.toggle('active', active);
    });
    if (els.btnTailRevert) {
      setElementVisible(els.btnTailRevert, snap.tailMode !== 'hybrid', 'inline-block');
    }

    // Top Reset to Defaults button (always updated even on snap.error!)
    if (els.btnResetTop) {
      els.btnResetTop.disabled = this._isApplying || !snap.isModified;
    }

    // Paired SAATI Screen Mesh preset & Custom (TPI / µm) inline row
    const showCustomMesh = this._customMeshExpanded || snap.meshPresetId === 'custom';
    if (els.meshPreset) {
      els.meshPreset.value = showCustomMesh ? 'custom' : snap.meshPresetId;
    }
    if (els.customMeshRow) {
      setElementVisible(els.customMeshRow, showCustomMesh, 'flex');
    }
    if (els.meshTpi) writeControlValue(els.meshTpi, snap.meshTpi, activeEl);
    if (els.threadUm) writeControlValue(els.threadUm, snap.threadDiaUm, activeEl);
    if (els.btnMeshRevert) {
      setElementVisible(
        els.btnMeshRevert,
        snap.meshTpi !== 230 || Math.abs(snap.threadDiaUm - 48) > 1e-6,
        'inline-block'
      );
    }

    // Mesh bias angle <sp-slider> & number
    if (els.meshAngleSlider) writeControlValue(els.meshAngleSlider, snap.meshAngleDeg);
    if (els.meshAngleNum) writeControlValue(els.meshAngleNum, snap.meshAngleDeg, activeEl);
    if (els.btnMeshAngleRevert) {
      setElementVisible(els.btnMeshAngleRevert, Math.abs(snap.meshAngleDeg) > 1e-6, 'inline-block');
    }

    // Rule of N <sp-slider> & readout (default 5.0)
    if (els.ruleNSlider) writeControlValue(els.ruleNSlider, snap.ruleOfN);
    if (els.ruleNVal) {
      const dPx = snap.meshSpec ? ` · ${snap.meshSpec.dMinPx} px` : '';
      els.ruleNVal.textContent = `N = ${snap.ruleOfN.toFixed(1)}${dPx}`;
    }
    if (els.btnRuleNRevert) {
      setElementVisible(els.btnRuleNRevert, Math.abs(snap.ruleOfN - 5.0) > 1e-6, 'inline-block');
    }

    // LPI override & Auto revert (always synced BEFORE checking snap.error so invalid LPI can be reverted!)
    if (els.btnLpiAuto) {
      setElementVisible(els.btnLpiAuto, snap.lpiOverride != null, 'inline-block');
    }
    if (els.lpiInput && els.lpiInput !== activeEl) {
      els.lpiInput.value = snap.lpiOverride == null ? '' : String(snap.lpiOverride);
    }

    // Rosette angles
    if (els.angleC) writeControlValue(els.angleC, snap.angles.C.toFixed(1).replace(/\.0$/, ''), activeEl);
    if (els.angleM) writeControlValue(els.angleM, snap.angles.M.toFixed(1).replace(/\.0$/, ''), activeEl);
    if (els.angleY) writeControlValue(els.angleY, snap.angles.Y.toFixed(1).replace(/\.0$/, ''), activeEl);
    if (els.angleK) writeControlValue(els.angleK, snap.angles.K.toFixed(1).replace(/\.0$/, ''), activeEl);
    if (els.btnAnglesAuto) {
      const overridden = Boolean(snap.anglesOverride);
      if (overridden) els.btnAnglesAuto.classList.add('is-locked');
      else els.btnAnglesAuto.classList.remove('is-locked');
      setElementVisible(els.btnAnglesAuto, overridden, 'inline-block');
    }

    if (snap.error) {
      // Clear any previous warning box cleanly so it never stays stuck under an error
      if (els.warningsBox) {
        els.warningsBox.textContent = '';
        setElementVisible(els.warningsBox, false, 'block');
      }
      if (els.errorBanner) {
        els.errorBanner.textContent = `${snap.error.code}: ${snap.error.message}`;
        setElementVisible(els.errorBanner, true, 'block');
      }
      if (els.btnApply) els.btnApply.disabled = true;
      return;
    }

    if (els.errorBanner) {
      els.errorBanner.textContent = '';
      setElementVisible(els.errorBanner, false, 'block');
    }
    if (els.btnApply) {
      els.btnApply.disabled = this._isApplying;
    }

    const spec = snap.meshSpec;
    if (spec) {
      if (els.statMeshLpi) {
        els.statMeshLpi.textContent = `${spec.meshTpi} TPI · ${spec.lpiActive.toFixed(1)} LPI`;
      }
      if (els.statMinDot) {
        els.statMinDot.textContent = `D_min ${spec.dMinPx} px`;
      }
      if (els.lpiInput) {
        els.lpiInput.placeholder = `${spec.lpiNatural.toFixed(1)} (Auto)`;
      }
      if (els.lpiHint) {
        els.lpiHint.textContent =
          snap.lpiOverride == null
            ? `Auto: ${spec.lpiNatural.toFixed(1)} LPI (max ${spec.lpiMax.toFixed(1)})`
            : `Manual: ${spec.lpiActive.toFixed(1)} LPI (max ${spec.lpiMax.toFixed(1)})`;
      }
      if (els.physOpenArea) {
        els.physOpenArea.textContent = `${spec.openAreaPct.toFixed(1)}% (${spec.openAreaScale.toFixed(2)}× d_min)`;
      }
      if (els.physMinDot) {
        els.physMinDot.textContent = `${spec.dMinPx} px · ${spec.dMinUm.toFixed(0)} µm · ${(spec.tMin * 100).toFixed(1)}% cell (${spec.aMinPx} px²)`;
      }
      if (els.physAmRange) {
        els.physAmRange.textContent = `${(spec.tMin * 100).toFixed(0)}% – ${(spec.tMax * 100).toFixed(0)}% AM (${spec.cellPitchPx.toFixed(1)} px pitch)`;
      }
    }

    const moire = snap.moireReport;
    if (moire && els.moireBadge && els.moireDetail) {
      const hasSevere = moire.warnings.includes('WARN_SEVERE_MOIRE');
      const hasHarmonic = moire.warnings.includes('WARN_HARMONIC_MOIRE');
      els.moireBadge.classList.remove('badge-safe', 'badge-warn', 'badge-danger');
      if (hasSevere) {
        els.moireBadge.classList.add('badge-danger');
        els.moireBadge.textContent = 'SEVERE MOIRÉ';
      } else if (hasHarmonic) {
        els.moireBadge.classList.add('badge-warn');
        els.moireBadge.textContent = 'HARMONIC BEAT';
      } else {
        els.moireBadge.classList.add('badge-safe');
        els.moireBadge.textContent = 'ROSETTE SAFE';
      }

      const beatText = moire.worstBeat
        ? ` · peak ${(moire.maxContrast * 100).toFixed(1)}% @ ${moire.worstBeat.wavelengthMm.toFixed(1)} mm (${moire.worstBeat.channel})`
        : '';
      els.moireDetail.textContent = `Min thread clearance: ${moire.minClearanceDeg.toFixed(1)}° (±${moire.slopDeg}° slop)${beatText}`;
    }

    if (els.warningsBox && spec && moire) {
      const combined = [...spec.warnings, ...moire.warnings];
      if (combined.length === 0) {
        els.warningsBox.textContent = '';
        setElementVisible(els.warningsBox, false, 'block');
      } else {
        const msgs = combined.map((code) => {
          if (code === 'WARN_LOW_DPI') {
            const minRecDpi = Math.max(300, Math.ceil(5.0 * spec.lpiActive));
            return `Low DPI (${Math.round(spec.dpi)} DPI at ${spec.lpiActive.toFixed(1)} LPI) — use >= ${minRecDpi} DPI or raise Rule of N`;
          }
          if (code === 'WARN_NARROW_AM_RANGE') {
            const minAmDpi = Math.max(300, Math.ceil(Math.sqrt(spec.aMinPx / 0.20) * spec.lpiActive));
            return `Narrow AM range (${(spec.tMin * 100).toFixed(0)}%–${(spec.tMax * 100).toFixed(0)}%) — lower LPI, raise Rule of N, or use >= ${minAmDpi} DPI`;
          }
          if (code === 'WARN_SEVERE_MOIRE') {
            return 'Severe moiré clash — click ↺ next to CMYK Rosette Angles for safe mesh clearance';
          }
          if (code === 'WARN_HARMONIC_MOIRE') {
            return 'Harmonic mesh beat — nudge LPI slightly or reset CMYK Rosette Angles';
          }
          return code;
        });
        els.warningsBox.textContent = msgs.join(' · ');
        setElementVisible(els.warningsBox, true, 'block');
      }
    }
  }
}

module.exports = {
  SWOP_CORNERS,
  BendayDialog,
  renderPreviewRgba,
  buildAspectPreservingProxy,
  renderSupersampledProxyRgba,
};

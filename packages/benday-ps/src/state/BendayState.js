'use strict';

const {
  STANDARD_THREAD_UM,
  STANDARD_MESH_TPI,
  SAATI_MESH_PRESETS,
  ROSETTE_PRESETS,
  ROSETTE_PRESET_IDS,
  getDefaultThreadDiaUm,
  computeMeshSpec,
  computeRosetteAngles,
  resolveRosettePresetAngles,
  analyzeMoire,
  norm90,
  snapCmykEdges,
  parsePressConfig,
  serializePressConfig,
} = require('@electrosaur-labs/benday-core');

const DEFAULT_MESH_TPI = 355;
const DEFAULT_THREAD_UM = 31;
const DEFAULT_RULE_OF_N = 5.0;
const DEFAULT_MESH_ANGLE_DEG = 0;
const DEFAULT_DPI = 600;
const DEFAULT_DOT_GAIN = 0;
const DEFAULT_BVG = true;
const VIEW_ZOOM_STEPS = Object.freeze(['fit', 0.5, 1, 2]);

function normalizeViewZoom(z) {
  if (z === 'fit' || z === '' || z == null) return 'fit';
  const num = Number(z);
  if (num === 0.5 || num === 1 || num === 2) return num;
  return null;
}

class BendayState {
  constructor(initial = {}) {
    this._listeners = new Set();
    this._rosetteChannels = null;
    this._rosetteWidth = 0;
    this._rosetteHeight = 0;
    this.reset(initial, false);
  }

  reset(initial = {}, notify = true) {
    const meshTpi = initial.meshTpi != null ? Number(initial.meshTpi) : DEFAULT_MESH_TPI;
    const hasCustomThread = initial.threadDiaUm != null;

    this.docName = initial.docName || 'Untitled.psd';
    this.docWidth = initial.docWidth || 2400;
    this.docHeight = initial.docHeight || 3000;
    this.dpi = initial.dpi != null ? Number(initial.dpi) : DEFAULT_DPI;
    this.bitsPerChannel = initial.bitsPerChannel || 8;

    this.meshTpi = meshTpi;
    this.threadDiaUm = hasCustomThread
      ? Number(initial.threadDiaUm)
      : getDefaultThreadDiaUm(meshTpi);
    const catalogDefault =
      Number.isFinite(meshTpi) && meshTpi > 0 ? getDefaultThreadDiaUm(meshTpi) : null;
    this.threadDiaLocked =
      initial.threadDiaLocked != null
        ? Boolean(initial.threadDiaLocked)
        : hasCustomThread &&
          (catalogDefault == null || Math.abs(this.threadDiaUm - catalogDefault) > 1e-6);

    this.meshAngleDeg =
      initial.meshAngleDeg != null ? norm90(Number(initial.meshAngleDeg)) : DEFAULT_MESH_ANGLE_DEG;
    this.ruleOfN = initial.ruleOfN != null ? Number(initial.ruleOfN) : DEFAULT_RULE_OF_N;
    this.lpiOverride = initial.lpiOverride != null ? Number(initial.lpiOverride) : null;
    this.anglesOverride = initial.anglesOverride
      ? {
          C: norm90(Number(initial.anglesOverride.C)),
          M: norm90(Number(initial.anglesOverride.M)),
          Y: norm90(Number(initial.anglesOverride.Y)),
          K: norm90(Number(initial.anglesOverride.K)),
        }
      : null;

    const requestedPreset =
      initial.rosettePreset != null
        ? String(initial.rosettePreset)
        : this.anglesOverride
        ? 'manual'
        : 'auto';
    this.rosettePreset = ROSETTE_PRESET_IDS.includes(requestedPreset)
      ? requestedPreset
      : 'auto';

    this.tailMode = initial.tailMode || 'hybrid';
    this.dotGain =
      initial.dotGain != null
        ? Math.max(0, Math.min(20, Number(initial.dotGain) || 0))
        : DEFAULT_DOT_GAIN;
    this.bvg = initial.bvg != null ? Boolean(initial.bvg) : DEFAULT_BVG;

    this.previewMode = initial.previewMode || 'composite';
    // Loupe disabled (0) by default in live UI; preserved for backward-compatible unit tests
    this.previewZoom = initial.previewZoom != null ? Number(initial.previewZoom) : 0;
    this.viewZoom = normalizeViewZoom(initial.viewZoom) || 'fit';
    this.cropCenter = initial.cropCenter
      ? { x: Number(initial.cropCenter.x), y: Number(initial.cropCenter.y) }
      : { x: 0.5, y: 0.5 };

    this.meshSpec = null;
    this.angles = computeRosetteAngles(this.meshAngleDeg);
    this.moireReport = null;
    this.error = null;

    this._recompute();
    if (notify) this._emit('reset');
  }

  subscribe(listener) {
    if (typeof listener === 'function') {
      this._listeners.add(listener);
    }
    return () => this._listeners.delete(listener);
  }

  unsubscribe(listener) {
    this._listeners.delete(listener);
  }

  _emit(reason) {
    const snapshot = this.getSnapshot();
    for (const fn of this._listeners) {
      fn(snapshot, reason);
    }
  }

  getMeshPresetId() {
    for (let i = 0; i < SAATI_MESH_PRESETS.length; i++) {
      const p = SAATI_MESH_PRESETS[i];
      if (p.meshTpi === this.meshTpi && Math.abs(p.threadDiaUm - this.threadDiaUm) < 1e-6) {
        return p.id;
      }
    }
    return 'custom';
  }

  /**
   * Register channel buffers (e.g. proxy CMYK) so `'image-aware'` preset resolves live
   * optimal HVS rosette slot assignments in < 2 ms.
   */
  setChannelStatsSource(channels, width, height, emitIfImageAware = true) {
    this._rosetteChannels = channels || null;
    this._rosetteWidth = width || 0;
    this._rosetteHeight = height || 0;
    if (this.rosettePreset === 'image-aware') {
      this._recompute();
      if (emitIfImageAware) {
        this._emit('angles');
      }
    }
  }

  _recompute() {
    let nextMeshSpec = null;
    let specErr = null;
    try {
      nextMeshSpec = computeMeshSpec({
        meshTpi: this.meshTpi,
        threadDiaUm: this.threadDiaUm,
        ruleOfN: this.ruleOfN,
        dpi: this.dpi,
        lpiOverride: this.lpiOverride,
      });
    } catch (err) {
      specErr = err;
    }

    if (this.rosettePreset === 'manual' && this.anglesOverride) {
      this.angles = { ...this.anglesOverride };
    } else if (this.anglesOverride && this.rosettePreset === 'auto') {
      this.angles = { ...this.anglesOverride };
    } else {
      let rosetteSrc = this._rosetteChannels;
      if (
        this.bvg &&
        rosetteSrc &&
        this.rosettePreset === 'image-aware' &&
        this._rosetteWidth > 0 &&
        this._rosetteHeight > 0
      ) {
        const basePitch = nextMeshSpec ? nextMeshSpec.cellPitchPx : 6.5;
        const proxyScale = this._rosetteWidth / Math.max(1, this.docWidth);
        rosetteSrc = snapCmykEdges(rosetteSrc, this._rosetteWidth, this._rosetteHeight, {
          cellPitchPx: Math.max(1.5, basePitch * proxyScale),
        });
      }
      this.angles = resolveRosettePresetAngles(
        this.rosettePreset,
        this.meshAngleDeg,
        rosetteSrc,
        this._rosetteWidth,
        this._rosetteHeight,
        this.anglesOverride
      );
    }

    if (specErr) {
      this.meshSpec = null;
      this.moireReport = null;
      this.error = {
        code: specErr.code || 'ERR_INVALID_CONFIG',
        message: specErr.message || String(specErr),
      };
      return;
    }

    try {
      this.meshSpec = nextMeshSpec;
      this.error = null;
      this.moireReport = analyzeMoire({
        meshTpi: this.meshSpec.meshTpi,
        threadDiaUm: this.meshSpec.threadDiaUm,
        lpi: this.meshSpec.lpiActive,
        angles: this.angles,
        meshAngleDeg: this.meshAngleDeg,
      });
    } catch (err) {
      this.meshSpec = null;
      this.moireReport = null;
      this.error = {
        code: err.code || 'ERR_INVALID_CONFIG',
        message: err.message || String(err),
      };
    }
  }

  setDocumentInfo({ name, width, height, resolution, bitsPerChannel }) {
    if (name != null) this.docName = String(name);
    if (width > 0) this.docWidth = Number(width);
    if (height > 0) this.docHeight = Number(height);
    if (resolution != null) this.dpi = Number(resolution);
    if (bitsPerChannel != null) this.bitsPerChannel = bitsPerChannel;
    this._recompute();
    this._emit('document');
  }

  setMeshPreset(meshTpi, threadDiaUm) {
    this.meshTpi = Number(meshTpi);
    this.threadDiaUm = Number(threadDiaUm);
    const catalogDefault =
      Number.isFinite(this.meshTpi) && this.meshTpi > 0
        ? getDefaultThreadDiaUm(this.meshTpi)
        : null;
    this.threadDiaLocked =
      catalogDefault == null || Math.abs(this.threadDiaUm - catalogDefault) > 1e-6;
    this._recompute();
    this._emit('meshPreset');
  }

  setMeshTpi(meshTpi) {
    this.meshTpi = Number(meshTpi);
    if (!this.threadDiaLocked && Number.isFinite(this.meshTpi) && this.meshTpi > 0) {
      this.threadDiaUm = getDefaultThreadDiaUm(this.meshTpi);
    }
    this._recompute();
    this._emit('meshTpi');
  }

  setThreadDiaUm(threadDiaUm) {
    this.threadDiaUm = Number(threadDiaUm);
    const catalogDefault =
      Number.isFinite(this.meshTpi) && this.meshTpi > 0
        ? getDefaultThreadDiaUm(this.meshTpi)
        : null;
    this.threadDiaLocked =
      catalogDefault == null || Math.abs(this.threadDiaUm - catalogDefault) > 1e-6;
    this._recompute();
    this._emit('threadDiaUm');
  }

  resetThreadDiaAuto() {
    this.threadDiaLocked = false;
    if (Number.isFinite(this.meshTpi) && this.meshTpi > 0) {
      this.threadDiaUm = getDefaultThreadDiaUm(this.meshTpi);
    }
    this._recompute();
    this._emit('threadDiaUm');
  }

  setMeshAngleDeg(meshAngleDeg) {
    const raw = Number(meshAngleDeg);
    this.meshAngleDeg = Number.isFinite(raw) ? norm90(raw) : 0;
    if (this.rosettePreset === 'manual') {
      this.rosettePreset = 'auto';
    }
    this.anglesOverride = null;
    this._recompute();
    this._emit('meshAngleDeg');
  }

  setRuleOfN(ruleOfN) {
    this.ruleOfN = Number(ruleOfN);
    this.lpiOverride = null;
    this._recompute();
    this._emit('ruleOfN');
  }

  setLpiOverride(lpiOverride) {
    if (lpiOverride === null || lpiOverride === '' || lpiOverride === undefined) {
      this.lpiOverride = null;
    } else {
      this.lpiOverride = Number(lpiOverride);
    }
    this._recompute();
    this._emit('lpiOverride');
  }

  resetLpiAuto() {
    this.lpiOverride = null;
    this._recompute();
    this._emit('lpiOverride');
  }

  setRosettePreset(presetId) {
    if (!ROSETTE_PRESET_IDS.includes(presetId)) return;
    this.rosettePreset = presetId;
    if (presetId === 'manual') {
      if (!this.anglesOverride) {
        this.anglesOverride = { ...this.angles };
      }
    } else {
      this.anglesOverride = null;
    }
    this._recompute();
    this._emit('angles');
  }

  setChannelAngle(channelKey, deg) {
    if (!['C', 'M', 'Y', 'K'].includes(channelKey)) return;
    const base = this.anglesOverride
      ? { ...this.anglesOverride }
      : { ...this.angles };
    base[channelKey] = norm90(Number(deg));
    this.anglesOverride = base;
    this.rosettePreset = 'manual';
    this._recompute();
    this._emit('angles');
  }

  setAnglesOverride(anglesObj) {
    if (!anglesObj) {
      this.anglesOverride = null;
      if (this.rosettePreset === 'manual') {
        this.rosettePreset = 'auto';
      }
    } else {
      this.anglesOverride = {
        C: norm90(Number(anglesObj.C)),
        M: norm90(Number(anglesObj.M)),
        Y: norm90(Number(anglesObj.Y)),
        K: norm90(Number(anglesObj.K)),
      };
      this.rosettePreset = 'manual';
    }
    this._recompute();
    this._emit('angles');
  }

  resetAnglesAuto() {
    this.anglesOverride = null;
    this.rosettePreset = 'auto';
    this._recompute();
    this._emit('angles');
  }

  setTailMode(tailMode) {
    if (['hybrid', 'cutoff', 'clamp'].includes(tailMode)) {
      this.tailMode = tailMode;
      this._emit('tailMode');
    }
  }

  setDotGain(dotGain) {
    const val = Number(dotGain);
    if (!Number.isFinite(val)) return;
    const clamped = Math.max(0, Math.min(20, val));
    if (Math.abs(clamped - this.dotGain) > 1e-6) {
      this.dotGain = clamped;
      this._emit('dotGain');
    }
  }

  resetDotGain() {
    if (this.dotGain !== 0) {
      this.dotGain = 0;
      this._emit('dotGain');
    }
  }

  setBvg(enabled) {
    const next = Boolean(enabled);
    if (next !== this.bvg) {
      this.bvg = next;
      this._recompute();
      this._emit('bvg');
    }
  }

  setPreviewMode(previewMode) {
    if (['composite', 'C', 'M', 'Y', 'K'].includes(previewMode)) {
      this.previewMode = previewMode;
      this._emit('previewMode');
    }
  }

  setPreviewZoom(zoom) {
    const z = Number(zoom);
    if ([0, 1, 2, 4].includes(z)) {
      this.previewZoom = z;
      this._emit('previewZoom');
    }
  }

  setViewZoom(zoom) {
    const z = normalizeViewZoom(zoom);
    if (z !== null && z !== this.viewZoom) {
      this.viewZoom = z;
      this._emit('viewZoom');
    }
  }

  zoomIn() {
    const idx = VIEW_ZOOM_STEPS.indexOf(this.viewZoom);
    const next = VIEW_ZOOM_STEPS[Math.min(VIEW_ZOOM_STEPS.length - 1, (idx < 0 ? 0 : idx) + 1)];
    this.setViewZoom(next);
  }

  zoomOut() {
    const idx = VIEW_ZOOM_STEPS.indexOf(this.viewZoom);
    const prev = VIEW_ZOOM_STEPS[Math.max(0, (idx < 0 ? 0 : idx) - 1)];
    this.setViewZoom(prev);
  }

  isModified() {
    return (
      this.meshTpi !== DEFAULT_MESH_TPI ||
      Math.abs(this.threadDiaUm - DEFAULT_THREAD_UM) > 1e-6 ||
      this.threadDiaLocked ||
      Math.abs(this.meshAngleDeg - DEFAULT_MESH_ANGLE_DEG) > 1e-6 ||
      Math.abs(this.ruleOfN - DEFAULT_RULE_OF_N) > 1e-6 ||
      this.lpiOverride !== null ||
      this.anglesOverride !== null ||
      this.rosettePreset !== 'auto' ||
      this.tailMode !== 'hybrid' ||
      Math.abs(this.dotGain - DEFAULT_DOT_GAIN) > 1e-6 ||
      this.bvg !== DEFAULT_BVG ||
      this.previewMode !== 'composite'
    );
  }

  resetToDefaults() {
    this.reset(
      {
        docName: this.docName,
        docWidth: this.docWidth,
        docHeight: this.docHeight,
        dpi: this.dpi,
        bitsPerChannel: this.bitsPerChannel,
        previewZoom: this.previewZoom,
        viewZoom: this.viewZoom,
      },
      true
    );
  }

  setCropCenter(xNorm, yNorm) {
    this.cropCenter = {
      x: Math.max(0, Math.min(1, Number(xNorm))),
      y: Math.max(0, Math.min(1, Number(yNorm))),
    };
    this._emit('cropCenter');
  }

  exportEngineConfig() {
    return {
      meshTpi: this.meshTpi,
      threadDiaUm: this.threadDiaUm,
      ruleOfN: this.ruleOfN,
      dpi: this.dpi,
      lpiOverride: this.lpiOverride,
      meshAngleDeg: this.meshAngleDeg,
      rosettePreset: this.rosettePreset,
      angles: { ...this.angles },
      anglesOverride: this.anglesOverride ? { ...this.anglesOverride } : null,
      tailMode: this.tailMode,
      dotGain: this.dotGain,
      bvg: this.bvg,
    };
  }

  getPressConfigObject() {
    return {
      meshTpi: this.meshTpi,
      threadDiaUm: this.threadDiaUm,
      meshPresetId: this.getMeshPresetId(),
      ruleOfN: this.ruleOfN,
      meshAngleDeg: this.meshAngleDeg,
      lpiOverride: this.lpiOverride,
      tailMode: this.tailMode,
      rosettePreset: this.rosettePreset,
      anglesOverride: this.anglesOverride ? { ...this.anglesOverride } : null,
      dotGain: this.dotGain,
      bvg: this.bvg,
    };
  }

  exportPressConfig(meta = undefined) {
    return serializePressConfig(this.getPressConfigObject(), meta);
  }

  applyPressConfig(input) {
    const parsed = parsePressConfig(input);
    this.reset(
      {
        docName: this.docName,
        docWidth: this.docWidth,
        docHeight: this.docHeight,
        dpi: this.dpi,
        bitsPerChannel: this.bitsPerChannel,
        previewZoom: this.previewZoom,
        viewZoom: this.viewZoom,
        meshTpi: parsed.meshTpi,
        threadDiaUm: parsed.threadDiaUm,
        meshAngleDeg: parsed.meshAngleDeg,
        ruleOfN: parsed.ruleOfN,
        lpiOverride: parsed.lpiOverride,
        tailMode: parsed.tailMode,
        rosettePreset: parsed.rosettePreset,
        anglesOverride: parsed.anglesOverride,
        dotGain: parsed.dotGain,
        bvg: parsed.bvg,
      },
      true
    );
    return parsed;
  }

  getSnapshot() {
    return {
      docName: this.docName,
      docWidth: this.docWidth,
      docHeight: this.docHeight,
      dpi: this.dpi,
      bitsPerChannel: this.bitsPerChannel,
      meshTpi: this.meshTpi,
      threadDiaUm: this.threadDiaUm,
      threadDiaLocked: this.threadDiaLocked,
      meshPresetId: this.getMeshPresetId(),
      meshAngleDeg: this.meshAngleDeg,
      ruleOfN: this.ruleOfN,
      lpiOverride: this.lpiOverride,
      rosettePreset: this.rosettePreset,
      anglesOverride: this.anglesOverride ? { ...this.anglesOverride } : null,
      angles: { ...this.angles },
      tailMode: this.tailMode,
      dotGain: this.dotGain,
      bvg: this.bvg,
      previewMode: this.previewMode,
      previewZoom: this.previewZoom,
      viewZoom: this.viewZoom,
      cropCenter: { ...this.cropCenter },
      meshSpec: this.meshSpec,
      moireReport: this.moireReport,
      error: this.error,
      isModified: this.isModified(),
      standardMeshTpi: STANDARD_MESH_TPI,
      standardThreadUm: STANDARD_THREAD_UM,
      saatiMeshPresets: SAATI_MESH_PRESETS,
      rosettePresets: ROSETTE_PRESETS,
    };
  }
}

module.exports = BendayState;

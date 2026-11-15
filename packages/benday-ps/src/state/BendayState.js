'use strict';

const {
  STANDARD_THREAD_UM,
  STANDARD_MESH_TPI,
  SAATI_MESH_PRESETS,
  getDefaultThreadDiaUm,
  computeMeshSpec,
  computeRosetteAngles,
  analyzeMoire,
  norm90,
} = require('@electrosaur-labs/benday-core');

const DEFAULT_MESH_TPI = 230;
const DEFAULT_THREAD_UM = 48;
const DEFAULT_RULE_OF_N = 5.0;
const DEFAULT_MESH_ANGLE_DEG = 0;
const DEFAULT_DPI = 600;
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

    this.tailMode = initial.tailMode || 'hybrid';
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

  _recompute() {
    this.angles = this.anglesOverride
      ? { ...this.anglesOverride }
      : computeRosetteAngles(this.meshAngleDeg);

    try {
      this.meshSpec = computeMeshSpec({
        meshTpi: this.meshTpi,
        threadDiaUm: this.threadDiaUm,
        ruleOfN: this.ruleOfN,
        dpi: this.dpi,
        lpiOverride: this.lpiOverride,
      });
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

  setChannelAngle(channelKey, deg) {
    if (!['C', 'M', 'Y', 'K'].includes(channelKey)) return;
    const base = this.anglesOverride
      ? { ...this.anglesOverride }
      : computeRosetteAngles(this.meshAngleDeg);
    base[channelKey] = norm90(Number(deg));
    this.anglesOverride = base;
    this._recompute();
    this._emit('angles');
  }

  setAnglesOverride(anglesObj) {
    if (!anglesObj) {
      this.anglesOverride = null;
    } else {
      this.anglesOverride = {
        C: norm90(Number(anglesObj.C)),
        M: norm90(Number(anglesObj.M)),
        Y: norm90(Number(anglesObj.Y)),
        K: norm90(Number(anglesObj.K)),
      };
    }
    this._recompute();
    this._emit('angles');
  }

  resetAnglesAuto() {
    this.anglesOverride = null;
    this._recompute();
    this._emit('angles');
  }

  setTailMode(tailMode) {
    if (['hybrid', 'cutoff', 'clamp'].includes(tailMode)) {
      this.tailMode = tailMode;
      this._emit('tailMode');
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
      this.tailMode !== 'hybrid' ||
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
      anglesOverride: this.anglesOverride ? { ...this.anglesOverride } : null,
      tailMode: this.tailMode,
    };
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
      anglesOverride: this.anglesOverride ? { ...this.anglesOverride } : null,
      angles: { ...this.angles },
      tailMode: this.tailMode,
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
    };
  }
}

module.exports = BendayState;

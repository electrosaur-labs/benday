'use strict';

const { entrypoints, storage } = require('uxp');
const { app, core, action, imaging } = require('photoshop');

const BendayState = require('./state/BendayState');
const PhotoshopCmykBridge = require('./bridge/PhotoshopCmykBridge');
const { BendayDialog } = require('./ui/BendayDialog');

let bendayState = null;
let bendayDialog = null;
let dialogOpen = false;
let usingUxpShowModal = false;
let cachedFullCmyk = null;
let pendingApplyConfig = null;
let rereadRequested = false;
let reopenModalWithoutReread = false;
let lastEscapeInterceptedAt = 0;

function closeDialogElement() {
  const dlg = document.getElementById('bendayDialog');
  dialogOpen = false;
  if (dlg && typeof dlg.close === 'function') {
    try {
      dlg.close();
    } catch (_) {
      /* already closed */
    }
  }
}

function getSuggestedConfigFilename(docName) {
  const base = String(docName || '')
    .replace(/\.[^./\\]+$/, '')
    .trim();
  return base ? `${base}-benday.json` : 'benday.json';
}

let _confirmDialogResolve = null;
let _confirmDialogDoc = null;

function _resolveConfirmDialog(result) {
  const doc =
    _confirmDialogDoc ||
    (bendayDialog && bendayDialog.doc) ||
    (typeof document !== 'undefined' ? document : null);
  const overlay = doc ? doc.getElementById('confirm-overlay') : null;
  if (overlay) {
    overlay.classList.remove('visible');
    overlay.setAttribute('style', 'display: none');
  }
  const resolve = _confirmDialogResolve;
  _confirmDialogResolve = null;
  _confirmDialogDoc = null;
  if (resolve) resolve(Boolean(result));
}

function showConfirmDialog(title, message, confirmLabel = 'OK', docOverride = null) {
  const doc =
    docOverride ||
    (bendayDialog && bendayDialog.doc) ||
    (typeof document !== 'undefined' ? document : null);
  const overlay = doc ? doc.getElementById('confirm-overlay') : null;
  if (!overlay) {
    return Promise.resolve(true); // graceful fallback in unit tests where #confirm-overlay is absent
  }

  if (_confirmDialogResolve) {
    _resolveConfirmDialog(false);
  }

  _confirmDialogDoc = doc;
  const titleEl = doc.getElementById('confirm-title');
  const msgEl = doc.getElementById('confirm-message');
  const okBtn = doc.getElementById('btn-confirm-ok');
  const cancelBtn = doc.getElementById('btn-confirm-cancel');

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (okBtn) {
    okBtn.textContent = confirmLabel;
    okBtn.onclick = () => _resolveConfirmDialog(true);
  }
  if (cancelBtn) {
    cancelBtn.onclick = () => _resolveConfirmDialog(false);
  }
  overlay._cancelConfirm = () => _resolveConfirmDialog(false);
  overlay.classList.add('visible');
  overlay.setAttribute('style', 'display: flex');

  return new Promise((resolve) => {
    _confirmDialogResolve = resolve;
  });
}

async function handleSaveConfig(stateOverride = null, docOverride = null) {
  const activeState = stateOverride || bendayState;
  if (!activeState) return false;
  const fsApi = storage && storage.localFileSystem;
  if (!fsApi || typeof fsApi.getFileForSaving !== 'function') {
    await app.showAlert('Benday Save Config\n\nUXP file picker is not available in this host.');
    return false;
  }

  try {
    const suggested = getSuggestedConfigFilename(activeState.docName);
    const jsonText = activeState.exportPressConfig({ documentName: activeState.docName });
    const file = await fsApi.getFileForSaving(suggested, { types: ['json'] });
    if (!file) return false; // user cancelled picker

    let alreadyExists = false;
    if (typeof file.read === 'function') {
      try {
        const existing = await file.read();
        alreadyExists = Boolean(existing && existing.length > 0);
      } catch (_) {
        alreadyExists = false;
      }
    }

    if (alreadyExists) {
      const proceed = await showConfirmDialog(
        'Overwrite File?',
        `"${file.name || suggested}" already exists and will be overwritten. Continue?`,
        'Overwrite',
        docOverride
      );
      if (!proceed) return false;
    }

    await file.write(jsonText);
    if (bendayDialog) {
      bendayDialog.setStatusText(`Saved ${file.name || suggested}`);
    }
    return true;
  } catch (err) {
    console.error('[Benday] Save Config failed:', err);
    await app.showAlert(`Benday Save Error\n\n${err.message || err}`);
    return false;
  }
}

async function handleLoadConfig() {
  if (!bendayState) return false;
  const fsApi = storage && storage.localFileSystem;
  if (!fsApi || typeof fsApi.getFileForOpening !== 'function') {
    await app.showAlert('Benday Load Config\n\nUXP file picker is not available in this host.');
    return false;
  }

  try {
    const picked = await fsApi.getFileForOpening({ types: ['json'] });
    const file = Array.isArray(picked) ? picked[0] : picked;
    if (!file) return false; // user cancelled picker
    const rawText = await file.read();
    bendayState.applyPressConfig(rawText);
    if (bendayDialog) {
      bendayDialog.setStatusText(`Loaded ${file.name || 'PressConfig'}`);
    }
    return true;
  } catch (err) {
    console.error('[Benday] Load Config failed:', err);
    await app.showAlert(`Benday Load Error\n\n${err.message || err}`);
    return false;
  }
}

async function loadDocumentChannelsIntoDialog() {
  const check = PhotoshopCmykBridge.validateDocument(app);
  if (!check.ok) {
    console.warn(`[Benday] Document validation rejected (${check.code}): ${check.message}`);
    await app.showAlert(`${check.title}\n\n${check.message}`);
    return false;
  }

  bendayState.setDocumentInfo(check.docInfo);
  bendayDialog.setApplying(false, 'Reading CMYK channels…');
  bendayDialog.setFullDocumentData(null);

  try {
    cachedFullCmyk = await PhotoshopCmykBridge.readFullCmykChannels(app, {
      core,
      action,
      imaging,
    });
    const rawXmp = await PhotoshopCmykBridge.queryDocumentXmp(action);
    if (
      PhotoshopCmykBridge.isFlattenedBendayDocument(
        rawXmp,
        cachedFullCmyk && cachedFullCmyk.channels
      )
    ) {
      cachedFullCmyk = null;
      await app.showAlert(
        'Already Halftoned\n\nActive document "' +
          (check.docInfo.name || 'Untitled') +
          '" is a flattened Benday halftone.\n\nOpen the original continuous-tone CMYK artwork before running Benday.'
      );
      return false;
    }
    bendayDialog.setFullDocumentData(cachedFullCmyk);
    return true;
  } catch (err) {
    cachedFullCmyk = null;
    console.error('[Benday] readFullCmykChannels failed:', err && err.stack ? err.stack : err);
    bendayDialog.setStatusText(`Preview unavailable: ${err.message || err}`);
    return true;
  }
}

async function executePendingApply() {
  const engineConfig = pendingApplyConfig;
  const preReadChannels = cachedFullCmyk ? cachedFullCmyk.channels : null;
  pendingApplyConfig = null;
  cachedFullCmyk = null;
  if (!engineConfig) return;

  try {
    if (bendayDialog) {
      bendayDialog.setApplying(true, 'Generating full-resolution CMYK screens…');
    }
    console.log('[Benday] Applying full-resolution halftone with config:', engineConfig);
    await PhotoshopCmykBridge.commitHalftoneLayer(
      app,
      core,
      action,
      imaging,
      engineConfig,
      (_frac, msg) => {
        if (bendayDialog) bendayDialog.setStatusText(msg);
      },
      preReadChannels
    );
    if (bendayDialog) {
      bendayDialog.setApplying(false, 'Applied');
    }
  } catch (err) {
    console.error('[Benday] commitHalftoneLayer failed:', err && err.stack ? err.stack : err);
    if (bendayDialog) {
      bendayDialog.setApplying(false, `Error: ${err.message || err}`);
    }
    await app.showAlert(`Benday Error\n\n${err.message || err}`);
  }
}

function initPlugin() {
  if (bendayState && bendayDialog) return;
  bendayState = new BendayState();
  bendayDialog = new BendayDialog(document, bendayState, {
    onCancel: () => {
      pendingApplyConfig = null;
      rereadRequested = false;
      reopenModalWithoutReread = false;
      cachedFullCmyk = null;
      closeDialogElement();
    },
    onEscapeIntercepted: () => {
      lastEscapeInterceptedAt = Date.now();
    },
    onSaveConfig: handleSaveConfig,
    onLoadConfig: handleLoadConfig,
    onReread: async () => {
      if (bendayState) {
        bendayState.resetToDefaults();
      }
      if (bendayDialog) {
        bendayDialog._customMeshExpanded = false;
      }
      if (usingUxpShowModal && dialogOpen) {
        // Close modal temporarily so readFullCmykChannels can open/close split docs unobstructed
        rereadRequested = true;
        cachedFullCmyk = null;
        closeDialogElement();
      } else {
        await loadDocumentChannelsIntoDialog();
      }
    },
    onApply: async () => {
      if (!bendayDialog || !bendayState) return;
      rereadRequested = false;
      reopenModalWithoutReread = false;
      pendingApplyConfig = bendayState.exportEngineConfig();
      closeDialogElement();
      if (!usingUxpShowModal) {
        await executePendingApply();
      }
    },
  });

  const dlg = document.getElementById('bendayDialog');
  if (dlg) {
    // If UXP `<dialog>` fires native `cancel` on Escape before DOM `keydown`, intercept modal overlays ONLY
    dlg.addEventListener('cancel', (e) => {
      if (bendayDialog && bendayDialog.dismissTopTransientLayer()) {
        e.preventDefault();
        lastEscapeInterceptedAt = Date.now();
        reopenModalWithoutReread = Boolean(usingUxpShowModal && cachedFullCmyk);
      } else {
        if (bendayDialog) {
          bendayDialog._clearBlinkTimers();
          bendayDialog._blinkMode = false;
        }
        pendingApplyConfig = null;
        rereadRequested = false;
        reopenModalWithoutReread = false;
        cachedFullCmyk = null;
      }
    });

    dlg.addEventListener('close', () => {
      dialogOpen = false;
      if (_confirmDialogResolve) {
        _resolveConfirmDialog(false);
      }
      // If UXP natively closed `<dialog>` on the exact same Escape keypress that dismissed Credits/Blink/Solo,
      // immediately re-show `uxpShowModal` reusing `cachedFullCmyk` without re-reading Photoshop channels!
      if (
        usingUxpShowModal &&
        cachedFullCmyk &&
        !pendingApplyConfig &&
        !rereadRequested &&
        Date.now() - lastEscapeInterceptedAt < 150
      ) {
        reopenModalWithoutReread = true;
      }
      if (!pendingApplyConfig && !rereadRequested && !reopenModalWithoutReread) {
        cachedFullCmyk = null;
      }
    });
  }

  const btnConfirmOk = document.getElementById('btn-confirm-ok');
  if (btnConfirmOk) {
    btnConfirmOk.onclick = () => _resolveConfirmDialog(true);
  }
  const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
  if (btnConfirmCancel) {
    btnConfirmCancel.onclick = () => _resolveConfirmDialog(false);
  }
}

async function showDialog() {
  if (dialogOpen) return;

  const initialCheck = PhotoshopCmykBridge.validateDocument(app);
  if (!initialCheck.ok) {
    console.warn(
      `[Benday] Document validation rejected (${initialCheck.code}): ${initialCheck.message}`
    );
    await app.showAlert(`${initialCheck.title}\n\n${initialCheck.message}`);
    return;
  }

  if (await PhotoshopCmykBridge.queryHasActiveSelection(action)) {
    console.warn('[Benday] Document validation rejected (ERR_ACTIVE_SELECTION via ActionManager)');
    await app.showAlert(
      'Active Selection\n\nBenday operates on the entire CMYK document.\n\nDeselect via Select → Deselect (Cmd/Ctrl+D), then run Benday again.'
    );
    return;
  }

  console.log('[Benday] Opening dialog for document:', initialCheck.docInfo);
  initPlugin();

  const dlg = document.getElementById('bendayDialog');
  if (!dlg) return;

  // Reset knobs cleanly on fresh dialog open (matching Reveal)
  bendayState.resetToDefaults();
  if (bendayDialog) {
    bendayDialog._customMeshExpanded = false;
    bendayDialog._setHelpVisibility(false);
  }

  const modalOpts = {
    resize: 'both',
    size: {
      width: 1100,
      height: 850,
      minWidth: 680,
      minHeight: 520,
      maxWidth: 1920,
      maxHeight: 1400,
    },
  };

  pendingApplyConfig = null;
  rereadRequested = false;
  reopenModalWithoutReread = false;

  // Loop supports:
  //   1. `Reread Document`: closes uxpShowModal, re-reads full CMYK channels outside modal, re-opens.
  //   2. `reopenModalWithoutReread`: if UXP `<dialog>` natively closed on Escape while dismissing
  //      Credits / Blink / Solo, re-opens uxpShowModal immediately reusing `cachedFullCmyk`.
  do {
    const skipChannelRead = Boolean(reopenModalWithoutReread && cachedFullCmyk);
    rereadRequested = false;
    reopenModalWithoutReread = false;

    if (!skipChannelRead) {
      const loaded = await loadDocumentChannelsIntoDialog();
      if (!loaded) {
        cachedFullCmyk = null;
        return;
      }
    }

    dialogOpen = true;
    if (typeof dlg.uxpShowModal === 'function') {
      usingUxpShowModal = true;
      try {
        await dlg.uxpShowModal(modalOpts);
      } finally {
        dialogOpen = false;
        usingUxpShowModal = false;
      }
    } else {
      usingUxpShowModal = false;
      dlg.showModal(modalOpts);
      return;
    }
  } while (rereadRequested || reopenModalWithoutReread);

  if (pendingApplyConfig) {
    await executePendingApply();
  } else {
    cachedFullCmyk = null;
  }
}

if (typeof document !== 'undefined') {
  entrypoints.setup({
    commands: {
      'benday.showDialog': showDialog,
    },
  });
}

module.exports = {
  initPlugin,
  showDialog,
  showConfirmDialog,
  getSuggestedConfigFilename,
  handleSaveConfig,
  handleLoadConfig,
};

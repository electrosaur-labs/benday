'use strict';

const { entrypoints } = require('uxp');
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
      cachedFullCmyk = null;
      closeDialogElement();
    },
    onReread: async () => {
      if (usingUxpShowModal && dialogOpen) {
        // Close modal temporarily so readFullCmykChannels can open/close split docs unobstructed,
        // preserving current BendayState knob settings across the modal loop!
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
      pendingApplyConfig = bendayState.exportEngineConfig();
      closeDialogElement();
      if (!usingUxpShowModal) {
        await executePendingApply();
      }
    },
  });

  const dlg = document.getElementById('bendayDialog');
  if (dlg) {
    dlg.addEventListener('close', () => {
      dialogOpen = false;
      if (!pendingApplyConfig && !rereadRequested) {
        cachedFullCmyk = null;
      }
    });
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

  console.log('[Benday] Opening dialog for document:', initialCheck.docInfo);
  initPlugin();

  const dlg = document.getElementById('bendayDialog');
  if (!dlg) return;

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

  // Loop supports `Reread Document`: closes uxpShowModal, re-reads full CMYK channels outside
  // the modal while keeping current BendayState knobs intact, and re-opens uxpShowModal seamlessly.
  do {
    rereadRequested = false;
    const loaded = await loadDocumentChannelsIntoDialog();
    if (!loaded) {
      cachedFullCmyk = null;
      return;
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
  } while (rereadRequested);

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
};

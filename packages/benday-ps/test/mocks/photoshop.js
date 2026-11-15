'use strict';

const INTERNAL_ID = Symbol('internalActionManagerId');

/**
 * Strict mock Photoshop v27.5+ UXP host environment for testing PhotoshopCmykBridge.
 *
 * Enforces real Photoshop UXP runtime invariants & regressions:
 *   1. `app.activeDocument` is getter-only externally (direct assignment throws TypeError).
 *   2. `origDoc.duplicate()` throws `Error: The document with an id of undefined does not exist.`
 *      by default (matching the real Adobe Photoshop v27.5+ UXP DOM `apiVersion: 2` regression!),
 *      and `dup.flatten()` / `doc.closeWithoutSaving()` throw to enforce 100% pure `batchPlay`.
 *   3. `{ _obj: 'duplicate' }` in `batchPlay` returns `[{}]` WITHOUT `documentID`, forcing safe
 *      post-duplicate ID discovery (`listOpenDocIds` / `queryActiveDocId`).
 *   4. Closed `Document` proxies poison `.id` with a throwing getter to catch any stale proxy access.
 *   5. `splitChannels` creates 4 + extraChannels Grayscale docs whose sole layer is a locked
 *      `Background` (`isBackgroundLayer: true`), leaving `activeDocument` on the last split doc.
 *   6. `imaging.putPixels` throws if the target layer still has `isBackgroundLayer === true`
 *      or if `imageData.meta.componentSize !== targetDoc.bitsPerChannel`.
 *   7. Supports `omitDomId: true` and `useUnderscoreId: true` to test UXP proxies whose `.id`
 *      is `undefined` (`_id` or pure ActionManager `batchPlay` `get` fallbacks).
 */
function createMockPhotoshopEnv(options = {}) {
  const {
    width = 64,
    height = 64,
    resolution = 600,
    mode = 'CMYKColorMode',
    bitsPerChannel = 8,
    priorHalftoneLayer = false,
    topLayerIsGroup = false,
    extraChannels = 0,
    splitOrder = null,      // optional custom array e.g. [{ key: 'K', suffix: 'Black' }, ...]
    exposeSplitTitles = true,
    omitDomId = false,
    useUnderscoreId = false,
    blockNewDocumentTabs = false,
    ignoreCleanupSelect = false,
    cmykInkChannels = null, // { C, M, Y, K } in ink space (0..255); PS grayscale stores 255 - ink
    throwOnStep = null,     // 'getPixels' | 'putPixels' | 'fill' | 'applyImage'
  } = options;

  let modalTabBlockActive = blockNewDocumentTabs;
  let ignoreSelectActive = false;
  let getPixelsCallCount = 0;

  let nextDocId = 100;
  let nextLayerId = 500;
  const pixelCount = width * height;

  const attachEntityId = (obj, numericId) => {
    obj[INTERNAL_ID] = numericId;
    if (omitDomId) {
      // Neither `.id` nor `._id` exposed on UXP proxy — forces pure ActionManager `get` fallbacks
      return obj;
    }
    if (useUnderscoreId) {
      obj._id = numericId;
      return obj;
    }
    obj.id = numericId;
    return obj;
  };

  const getInternalId = (obj) => (obj ? obj[INTERNAL_ID] : undefined);

  const poisonClosedDocProxy = (doc) => {
    doc.closed = true;
    Object.defineProperty(doc, 'id', {
      configurable: true,
      get() {
        throw new Error('Cannot read .id on a closed UXP Document proxy');
      },
    });
  };

  const defaultInk = (val) => new Uint8Array(pixelCount).fill(val);
  const baseInk = cmykInkChannels || {
    C: defaultInk(64),
    M: defaultInk(128),
    Y: defaultInk(0),
    K: defaultInk(255),
  };

  const makeLayer = (props) => attachEntityId({ ...props }, ++nextLayerId);

  const priorLayerObj = makeLayer({
    name: 'Benday Halftone (230 TPI · 22.5 LPI · N=4)',
    visible: true,
    isBackgroundLayer: false,
  });
  const artLayerObj = makeLayer({
    name: 'Artwork',
    visible: true,
    isBackgroundLayer: false,
  });
  const topGroupObj = makeLayer({
    name: 'Top Ink Group',
    visible: true,
    isGroup: true,
    layers: [artLayerObj],
  });

  let initialLayers;
  if (topLayerIsGroup) {
    initialLayers = priorHalftoneLayer ? [priorLayerObj, topGroupObj] : [topGroupObj];
  } else {
    initialLayers = priorHalftoneLayer ? [priorLayerObj, artLayerObj] : [artLayerObj];
  }

  const componentChannels = Object.freeze(['cyan', 'magenta', 'yellow', 'black']);

  const cloneLayerTree = (layers) =>
    layers.map((l) =>
      makeLayer({
        name: l.name,
        visible: l.visible,
        isBackgroundLayer: l.isBackgroundLayer,
        isGroup: l.isGroup,
        layers: l.layers ? cloneLayerTree(l.layers) : undefined,
      })
    );

  const hasVisiblePriorBenday = (layers) =>
    layers.some(
      (l) =>
        (l.name.startsWith('Benday Halftone') && l.visible) ||
        (l.layers && hasVisiblePriorBenday(l.layers))
    );

  const findLayerByIdOrName = (layers, ref) => {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (
        (typeof ref._id === 'number' && getInternalId(l) === ref._id) ||
        (typeof ref._name === 'string' && l.name === ref._name)
      ) {
        return l;
      }
      if (l.layers) {
        const sub = findLayerByIdOrName(l.layers, ref);
        if (sub) return sub;
      }
    }
    return null;
  };

  const removeLayerByRef = (layers, ref) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (
        (typeof ref._id === 'number' && getInternalId(l) === ref._id) ||
        (typeof ref._name === 'string' && l.name === ref._name)
      ) {
        const [removed] = layers.splice(i, 1);
        return removed;
      }
      if (l.layers) {
        const sub = removeLayerByRef(l.layers, ref);
        if (sub) return sub;
      }
    }
    return null;
  };

  const createdTempDocs = [];
  const batchPlayLog = [];
  const putPixelsBuffers = {}; // docId -> { buffer, meta, layerID }
  const appliedChannels = {};  // psChannel -> source docId
  const historyCalls = [];
  const alerts = [];
  let lastFillDescriptor = null;

  const origDocId = ++nextDocId;
  const origDoc = attachEntityId(
    {
      name: 'Poster_Artwork.psd',
      mode,
      width,
      height,
      resolution,
      bitsPerChannel,
      componentChannels,
      activeChannels: componentChannels,
      xmpMetadata: options.initialXmp || '',
      layers: initialLayers,
      async duplicate() {
        // Exact Adobe Photoshop v27.5+ UXP DOM regression error string!
        throw new Error('The document with an id of undefined does not exist.');
      },
      async flatten() {
        throw new Error('UXP DOM doc.flatten() is forbidden; use batchPlay flattenImage.');
      },
      async closeWithoutSaving() {
        throw new Error('UXP DOM doc.closeWithoutSaving() is forbidden; use batchPlay close.');
      },
    },
    origDocId
  );

  let currentActiveDoc = options.noDocument ? null : origDoc;
  let currentTargetLayerId = origDoc.layers[0] ? getInternalId(origDoc.layers[0]) : null;

  const app = {
    documents: options.noDocument ? [] : [origDoc],
    async showAlert(msg) {
      alerts.push(msg);
    },
  };
  Object.defineProperty(app, 'activeDocument', {
    get() {
      return currentActiveDoc;
    },
    enumerable: true,
  });

  const splitGrayscaleData = new Map(); // docId -> Uint8Array grayscale (0 = 100% ink, 255 = 0% paper)
  let currentSelectedChannel = 'CMYK';

  const closeDocInMock = (td) => {
    if (!td) return;
    poisonClosedDocProxy(td);
    const idx = app.documents.indexOf(td);
    if (idx >= 0) app.documents.splice(idx, 1);
    if (currentActiveDoc === td) {
      currentActiveDoc = app.documents[app.documents.length - 1] || null;
      currentTargetLayerId =
        currentActiveDoc && currentActiveDoc.layers[0]
          ? getInternalId(currentActiveDoc.layers[0])
          : null;
    }
  };

  const action = {
    async batchPlay(descriptors) {
      const results = [];
      for (const desc of descriptors) {
        batchPlayLog.push(desc);

        if (desc._obj === 'get' && Array.isArray(desc._target)) {
          const propTarget = desc._target[0] || {};
          const objTarget = desc._target[1] || {};
          if (propTarget._property === 'numberOfDocuments') {
            results.push({ numberOfDocuments: app.documents.length });
            continue;
          }
          if (propTarget._property === 'documentID') {
            if (typeof objTarget._index === 'number') {
              const d = app.documents[objTarget._index - 1];
              results.push({ documentID: d ? getInternalId(d) : undefined });
            } else {
              results.push({
                documentID: currentActiveDoc ? getInternalId(currentActiveDoc) : undefined,
              });
            }
            continue;
          }
          if (propTarget._property === 'layerID') {
            results.push({ layerID: currentTargetLayerId ?? undefined });
            continue;
          }
          if (propTarget._property === 'title') {
            if (!exposeSplitTitles) {
              results.push({});
              continue;
            }
            const d =
              typeof objTarget._id === 'number'
                ? app.documents.find((doc) => getInternalId(doc) === objTarget._id)
                : currentActiveDoc;
            results.push({ title: d ? d.name : undefined });
            continue;
          }
          if (propTarget._property === 'XMPMetadataAsUTF8') {
            const d =
              typeof objTarget._id === 'number'
                ? app.documents.find((doc) => getInternalId(doc) === objTarget._id)
                : currentActiveDoc;
            results.push({ XMPMetadataAsUTF8: d && d.xmpMetadata ? d.xmpMetadata : '' });
            continue;
          }
          if (propTarget._property === 'generatorSettings') {
            let lyr = null;
            if (currentActiveDoc && currentActiveDoc.layers) {
              if (objTarget._ref === 'layer' && (objTarget._id != null || objTarget._name != null)) {
                lyr = findLayerByIdOrName(currentActiveDoc.layers, objTarget);
              } else {
                lyr = findLayerByIdOrName(currentActiveDoc.layers, { _id: currentTargetLayerId });
              }
            }
            results.push({
              generatorSettings: lyr && lyr.generatorSettings ? { ...lyr.generatorSettings } : {},
            });
            continue;
          }
          results.push({});
          continue;
        }

        if (
          desc._obj === 'set' &&
          Array.isArray(desc._target) &&
          desc._target[0] &&
          desc._target[0]._property === 'XMPMetadataAsUTF8'
        ) {
          if (currentActiveDoc && desc.to && typeof desc.to.XMPMetadataAsUTF8 === 'string') {
            currentActiveDoc.xmpMetadata = desc.to.XMPMetadataAsUTF8;
          }
          results.push({});
          continue;
        }

        if (
          desc._obj === 'set' &&
          Array.isArray(desc._target) &&
          desc._target[0] &&
          desc._target[0]._property === 'generatorSettings'
        ) {
          if (currentActiveDoc && currentActiveDoc.layers && desc.to) {
            const targetLayer = findLayerByIdOrName(currentActiveDoc.layers, {
              _id: currentTargetLayerId,
            });
            if (targetLayer) {
              targetLayer.generatorSettings = { ...(targetLayer.generatorSettings || {}), ...desc.to };
            }
          }
          results.push({});
          continue;
        }

        if (desc._obj === 'duplicate') {
          if (modalTabBlockActive) {
            results.push({
              _obj: 'error',
              _result: -25920,
              message: "The command 'Duplicate' is not currently available.",
            });
            continue;
          }
          let srcDoc = currentActiveDoc;
          if (desc._target && desc._target[0] && typeof desc._target[0]._id === 'number') {
            srcDoc = app.documents.find((d) => getInternalId(d) === desc._target[0]._id);
          }
          if (!srcDoc) {
            throw new Error('No active source document to duplicate');
          }
          const clonedLayers = cloneLayerTree(srcDoc.layers);
          const dupId = ++nextDocId;
          const dup = attachEntityId(
            {
              name: desc.name || 'Dup',
              mode: srcDoc.mode,
              width: srcDoc.width,
              height: srcDoc.height,
              resolution: srcDoc.resolution,
              bitsPerChannel: srcDoc.bitsPerChannel,
              layers: clonedLayers,
              flattenedWithPriorVisible: false,
              closed: false,
              async duplicate() {
                throw new Error('The document with an id of undefined does not exist.');
              },
              async flatten() {
                throw new Error('UXP DOM doc.flatten() is forbidden; use batchPlay flattenImage.');
              },
              async closeWithoutSaving() {
                throw new Error(
                  'UXP DOM doc.closeWithoutSaving() is forbidden; use batchPlay close.'
                );
              },
            },
            dupId
          );
          app.documents.push(dup);
          currentActiveDoc = dup;
          currentTargetLayerId = dup.layers[0] ? getInternalId(dup.layers[0]) : null;
          createdTempDocs.push(dup);
          // Match Photoshop v27.5+ behavior: return `{}` WITHOUT `documentID`!
          results.push({});
          continue;
        }

        if (desc._obj === 'hide' && Array.isArray(desc.null) && currentActiveDoc) {
          for (const ref of desc.null) {
            const targetLayer = findLayerByIdOrName(currentActiveDoc.layers, ref);
            if (targetLayer) targetLayer.visible = false;
          }
          results.push({});
          continue;
        }

        if (desc._obj === 'show' && Array.isArray(desc.null) && currentActiveDoc) {
          for (const ref of desc.null) {
            const targetLayer = findLayerByIdOrName(currentActiveDoc.layers, ref);
            if (targetLayer) targetLayer.visible = true;
          }
          results.push({});
          continue;
        }

        if (desc._obj === 'select' && desc._target && desc._target[0]._ref === 'document') {
          if (ignoreSelectActive && desc._target[0]._id !== origDocId) {
            // Simulate Photoshop refusing to switch activeDocument away from origDoc
            results.push({});
            continue;
          }
          const targetDoc = app.documents.find((d) => getInternalId(d) === desc._target[0]._id);
          if (!targetDoc) {
            throw new Error(`Cannot select unknown document ID ${desc._target[0]._id}`);
          }
          currentActiveDoc = targetDoc;
          currentTargetLayerId = targetDoc.layers[0] ? getInternalId(targetDoc.layers[0]) : null;
        } else if (
          desc._obj === 'set' &&
          desc._target &&
          desc._target[0]._ref === 'layer' &&
          desc._target[0]._property === 'background'
        ) {
          if (!currentActiveDoc || !currentActiveDoc.layers[0]) {
            throw new Error('No active document/layer for background promotion');
          }
          currentActiveDoc.layers[0].isBackgroundLayer = false;
          currentActiveDoc.layers[0].name = (desc.to && desc.to.name) || 'Layer 0';
          currentTargetLayerId = getInternalId(currentActiveDoc.layers[0]);
        } else if (desc._obj === 'convertMode' && currentActiveDoc) {
          currentActiveDoc.bitsPerChannel = desc.depth;
        } else if (desc._obj === 'flattenImage' && currentActiveDoc) {
          currentActiveDoc.flattenedWithPriorVisible = hasVisiblePriorBenday(
            currentActiveDoc.layers
          );
          currentActiveDoc.flattenedAllHidden = !currentActiveDoc.layers.some(
            (l) => l.visible !== false
          );
          const bgLayer = makeLayer({
            name: 'Background',
            visible: true,
            isBackgroundLayer: true,
          });
          currentActiveDoc.layers = [bgLayer];
          currentTargetLayerId = getInternalId(bgLayer);
        } else if (desc._obj === 'splitChannels') {
          const srcDoc = currentActiveDoc;
          closeDocInMock(srcDoc);

          const polluted = srcDoc.flattenedWithPriorVisible;
          const allHidden = srcDoc.flattenedAllHidden;
          const entries = splitOrder
            ? splitOrder.map((item) =>
                typeof item === 'string' ? { key: item, suffix: item } : item
              )
            : (() => {
                const list = [
                  { key: 'C', suffix: 'C' },
                  { key: 'M', suffix: 'M' },
                  { key: 'Y', suffix: 'Y' },
                  { key: 'K', suffix: 'K' },
                ];
                for (let e = 0; e < extraChannels; e++) {
                  list.push({ key: `Alpha_${e + 1}`, suffix: `Alpha_${e + 1}` });
                }
                return list;
              })();
          for (const entry of entries) {
            const chKey = entry.key;
            const suffix = entry.suffix || chKey;
            const chDocId = ++nextDocId;
            const gray = new Uint8Array(pixelCount);
            const srcInk = baseInk[chKey] || new Uint8Array(pixelCount).fill(128);
            for (let i = 0; i < pixelCount; i++) {
              gray[i] = polluted ? 123 : allHidden ? 255 : 255 - srcInk[i];
            }
            splitGrayscaleData.set(chDocId, gray);

            const bgLayer = makeLayer({
              name: 'Background',
              visible: true,
              isBackgroundLayer: true,
            });
            const chDoc = attachEntityId(
              {
                name: `${origDoc.name}_${suffix}`,
                mode: 'Grayscale',
                width,
                height,
                resolution,
                bitsPerChannel: 8,
                layers: [bgLayer],
                closed: false,
                async closeWithoutSaving() {
                  throw new Error(
                    'UXP DOM doc.closeWithoutSaving() is forbidden; use batchPlay close.'
                  );
                },
              },
              chDocId
            );
            app.documents.push(chDoc);
            currentActiveDoc = chDoc; // Leaves activeDocument on the LAST split doc!
            currentTargetLayerId = getInternalId(bgLayer);
            createdTempDocs.push(chDoc);
          }
        } else if (desc._obj === 'delete' && desc._target && desc._target[0]._ref === 'layer') {
          removeLayerByRef(currentActiveDoc.layers, desc._target[0]);
        } else if (desc._obj === 'make' && desc._target && desc._target[0]._ref === 'layer') {
          const newLayer = makeLayer({
            name: (desc.using && desc.using.name) || 'Layer',
            visible: true,
            isBackgroundLayer: false,
          });
          // Real PS behavior: if top/active layer is a group, `make layer` inserts inside the group!
          if (currentActiveDoc.layers[0] && currentActiveDoc.layers[0].isGroup) {
            currentActiveDoc.layers[0].layers.unshift(newLayer);
          } else {
            currentActiveDoc.layers.unshift(newLayer);
          }
          currentTargetLayerId = getInternalId(newLayer);
        } else if (
          desc._obj === 'move' &&
          desc._target &&
          desc._target[0]._ref === 'layer' &&
          desc.to &&
          desc.to._value === 'front'
        ) {
          // Real Photoshop v27.5+ behavior: when the newly created layer is ALREADY at root index 0,
          // Bring to Front is disabled and returns `{ _obj: 'error', message: 'The command "Move" is not currently available.' }`!
          if (
            currentActiveDoc &&
            currentActiveDoc.layers[0] &&
            getInternalId(currentActiveDoc.layers[0]) === currentTargetLayerId
          ) {
            results.push({
              _obj: 'error',
              _result: -25920,
              message: 'The command "Move" is not currently available.',
            });
            continue;
          }
          const moved = removeLayerByRef(currentActiveDoc.layers, { _id: currentTargetLayerId });
          if (moved) {
            currentActiveDoc.layers.unshift(moved);
          }
        } else if (desc._obj === 'fill') {
          if (throwOnStep === 'fill') {
            if (ignoreCleanupSelect) ignoreSelectActive = true;
            throw new Error('Simulated fill failure');
          }
          if (desc.color && Object.prototype.hasOwnProperty.call(desc.color, 'yellow')) {
            throw new Error('Invalid ActionManager key "yellow" on cMYKColorClass');
          }
          lastFillDescriptor = desc;
        } else if (desc._obj === 'select' && desc._target && desc._target[0]._ref === 'channel') {
          currentSelectedChannel = desc._target[0]._value;
          if (currentActiveDoc === origDoc) {
            origDoc.activeChannels = [currentSelectedChannel];
          }
        } else if (desc._obj === 'applyImageEvent') {
          if (throwOnStep === 'applyImage') {
            if (ignoreCleanupSelect) ignoreSelectActive = true;
            throw new Error('Simulated applyImage failure');
          }
          const srcDocId = desc.with.to._ref[1]._id;
          appliedChannels[currentSelectedChannel] = srcDocId;
        } else if (desc._obj === 'close') {
          // Real Photoshop ActionManager behavior: `{ _obj: 'close' }` ALWAYS closes `app.activeDocument`,
          // ignoring `documentID` unless that document was selected as `activeDocument` first!
          if (currentActiveDoc) {
            closeDocInMock(currentActiveDoc);
          }
        }

        results.push({});
      }
      return results;
    },
  };

  const imaging = {
    async getPixels({ documentID, sourceBounds }) {
      getPixelsCallCount++;
      if (throwOnStep === 'getPixels') {
        throw new Error('Simulated getPixels failure');
      }
      if (typeof documentID !== 'number' || !Number.isFinite(documentID)) {
        throw new Error(`The document with an id of ${documentID} does not exist.`);
      }
      const fullGray = splitGrayscaleData.get(documentID);
      if (!fullGray) throw new Error(`No mock grayscale buffer for doc ${documentID}`);
      const left = sourceBounds ? sourceBounds.left : 0;
      const top = sourceBounds ? sourceBounds.top : 0;
      const right = sourceBounds ? sourceBounds.right : width;
      const bottom = sourceBounds ? sourceBounds.bottom : height;
      const cw = right - left;
      const ch = bottom - top;
      const cropped = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          cropped[y * cw + x] = fullGray[(top + y) * width + (left + x)];
        }
      }
      let disposed = false;
      return {
        imageData: {
          width: cw,
          height: ch,
          async getData() {
            return cropped;
          },
          dispose() {
            disposed = true;
          },
          get isDisposed() {
            return disposed;
          },
        },
      };
    },
    async createImageDataFromBuffer(buffer, meta) {
      return {
        buffer,
        meta,
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
    },
    async putPixels({ documentID, layerID, imageData }) {
      if (throwOnStep === 'putPixels') {
        throw new Error('Simulated putPixels failure');
      }
      if (typeof documentID !== 'number' || !Number.isFinite(documentID)) {
        throw new Error(`The document with an id of ${documentID} does not exist.`);
      }
      if (typeof layerID !== 'number' || !Number.isFinite(layerID)) {
        throw new Error(`The layer with an id of ${layerID} does not exist.`);
      }
      const targetDoc = app.documents.find((d) => getInternalId(d) === documentID);
      if (!targetDoc) {
        throw new Error(`putPixels: unknown documentID ${documentID}`);
      }
      if (imageData.meta.componentSize !== targetDoc.bitsPerChannel) {
        throw new Error(
          `putPixels bit-depth mismatch on doc ${documentID}: buffer=${imageData.meta.componentSize}, doc=${targetDoc.bitsPerChannel}`
        );
      }
      const targetLayer = targetDoc.layers.find((l) => getInternalId(l) === layerID);
      if (!targetLayer || targetLayer.isBackgroundLayer) {
        throw new Error(
          `Cannot putPixels on locked Background layer (doc ${documentID}, layer ${layerID})`
        );
      }
      putPixelsBuffers[documentID] = {
        buffer: imageData.buffer,
        meta: imageData.meta,
        layerID,
      };
    },
  };

  const core = {
    async executeAsModal(fn) {
      const ctx = {
        reportProgress: () => {},
        hostControl: {
          async suspendHistory({ documentID, name }) {
            if (typeof documentID !== 'number' || !Number.isFinite(documentID)) {
              throw new Error(`The document with an id of ${documentID} does not exist.`);
            }
            const id = `susp_${historyCalls.length + 1}`;
            historyCalls.push({ type: 'suspend', id, documentID, name });
            return id;
          },
          async resumeHistory(id, commit = true) {
            historyCalls.push({ type: 'resume', id, commit });
          },
        },
      };
      return await fn(ctx);
    },
  };

  return {
    app,
    core,
    action,
    imaging,
    origDoc,
    origDocId,
    createdTempDocs,
    batchPlayLog,
    putPixelsBuffers,
    appliedChannels,
    historyCalls,
    alerts,
    getLastFillDescriptor: () => lastFillDescriptor,
    getGetPixelsCallCount: () => getPixelsCallCount,
    setModalTabBlockActive: (flag) => {
      modalTabBlockActive = Boolean(flag);
    },
  };
}

// Default singleton exports for `require('photoshop')`
const defaultEnv = createMockPhotoshopEnv();

module.exports = {
  ...defaultEnv,
  createMockPhotoshopEnv,
};

'use strict';

const { halftoneCmyk } = require('@electrosaur-labs/benday-core');

const LAYER_PREFIX = 'Benday Halftone';
const CHANNEL_ORDER = Object.freeze([
  { key: 'C', psChannel: 'cyan' },
  { key: 'M', psChannel: 'magenta' },
  { key: 'Y', psChannel: 'yellow' },
  { key: 'K', psChannel: 'black' },
]);

function logInfo(msg, ...rest) {
  if (typeof console !== 'undefined' && typeof console.log === 'function') {
    console.log(`[Benday] ${msg}`, ...rest);
  }
}

function logWarn(msg, ...rest) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[Benday] ${msg}`, ...rest);
  }
}

/**
 * Inspect `action.batchPlay` result array for silent ActionManager `{ _obj: 'error' }` descriptors
 * (such as `-25920` when a UXP modal dialog blocks opening new document tabs) and throw cleanly.
 */
function assertBatchPlayOk(res, label) {
  if (!Array.isArray(res)) return;
  for (let i = 0; i < res.length; i++) {
    const item = res[i];
    if (item && item._obj === 'error') {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error(`[Benday] batchPlay error in ${label}:`, item);
      }
      throw new Error(`Photoshop ${label} failed: ${item.message || JSON.stringify(item)}`);
    }
  }
}

/**
 * Safely extract a finite integer ID from a UXP Document or Layer proxy without throwing
 * if the proxy is stale or exposes `_id` instead of `id`.
 */
function getEntityId(obj) {
  if (!obj) return undefined;
  try {
    const id = obj.id;
    if (typeof id === 'number' && Number.isFinite(id)) return id;
  } catch (_) {
    /* ignore dead UXP proxy getter */
  }
  try {
    const altId = obj._id;
    if (typeof altId === 'number' && Number.isFinite(altId)) return altId;
  } catch (_) {
    /* ignore dead UXP proxy getter */
  }
  return undefined;
}

/**
 * Safely convert UXP `app.documents` (array-like proxy or Array) into a plain JS Array.
 */
function getOpenDocsArray(app) {
  if (!app || !app.documents) return [];
  try {
    return Array.from(app.documents);
  } catch (_) {
    const out = [];
    try {
      const len = app.documents.length || 0;
      for (let i = 0; i < len; i++) {
        out.push(app.documents[i]);
      }
    } catch (_2) {
      /* ignore */
    }
    return out;
  }
}

function findDocById(app, docId) {
  if (!Number.isFinite(docId)) return null;
  const docs = getOpenDocsArray(app);
  for (let i = 0; i < docs.length; i++) {
    if (getEntityId(docs[i]) === docId) return docs[i];
  }
  return null;
}

/**
 * Query active document ID directly from ActionManager (`batchPlay`) as fallback.
 */
async function queryActiveDocId(action) {
  if (!action || typeof action.batchPlay !== 'function') return undefined;
  try {
    const res = await action.batchPlay(
      [
        {
          _obj: 'get',
          _target: [
            { _ref: 'property', _property: 'documentID' },
            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
          ],
        },
      ],
      {}
    );
    const id = res && res[0] && res[0].documentID;
    return typeof id === 'number' && Number.isFinite(id) ? id : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Query active target layer ID directly from ActionManager (`batchPlay`) as fallback.
 */
async function queryActiveLayerId(action) {
  if (!action || typeof action.batchPlay !== 'function') return undefined;
  try {
    const res = await action.batchPlay(
      [
        {
          _obj: 'get',
          _target: [
            { _ref: 'property', _property: 'layerID' },
            { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
          ],
        },
      ],
      {}
    );
    const id = res && res[0] && res[0].layerID;
    return typeof id === 'number' && Number.isFinite(id) ? id : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Query a document's `title` string directly via ActionManager (`_property: 'title'` on `{ _ref: 'document', _id }`).
 * Returns `''` if unavailable (e.g. headless unit-test mocks that omit `title`).
 */
async function queryDocumentTitle(action, docId) {
  if (!action || typeof action.batchPlay !== 'function' || !Number.isFinite(docId)) {
    return '';
  }
  try {
    const res = await action.batchPlay(
      [
        {
          _obj: 'get',
          _target: [
            { _ref: 'property', _property: 'title' },
            { _ref: 'document', _id: docId },
          ],
        },
      ],
      {}
    );
    const title = res && res[0] && res[0].title;
    return typeof title === 'string' ? title : '';
  } catch (_) {
    return '';
  }
}

/**
 * Match a Photoshop `splitChannels` Grayscale document title to `'C' | 'M' | 'Y' | 'K' | null`.
 * Checks channel suffix first (e.g. `_Cyan`, `_C`, ` Cyan`) so base filenames like `Black_Cat.psd_C`
 * never misclassify Cyan as Black.
 */
function classifySplitChannelTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return null;
  const base = title.trim().replace(/\.(?:psd|psb|tiff?)$/i, '');
  if (/(?:^|[_\s-])(?:cyan|c)$/i.test(base)) return 'C';
  if (/(?:^|[_\s-])(?:magenta|m)$/i.test(base)) return 'M';
  if (/(?:^|[_\s-])(?:yellow|y)$/i.test(base)) return 'Y';
  if (/(?:^|[_\s-])(?:black|k)$/i.test(base)) return 'K';
  if (/\bcyan\b/i.test(base)) return 'C';
  if (/\bmagenta\b/i.test(base)) return 'M';
  if (/\byellow\b/i.test(base)) return 'Y';
  if (/\bblack\b/i.test(base)) return 'K';
  return null;
}

/**
 * List all currently open finite integer document IDs directly via ActionManager (`numberOfDocuments`
 * + 1-based `_index` `documentID`), with `app.documents` DOM fallback.
 */
async function listOpenDocIds(app, action) {
  if (action && typeof action.batchPlay === 'function') {
    try {
      const cntRes = await action.batchPlay(
        [
          {
            _obj: 'get',
            _target: [
              { _ref: 'property', _property: 'numberOfDocuments' },
              { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' },
            ],
          },
        ],
        {}
      );
      const numDocs = cntRes && cntRes[0] && cntRes[0].numberOfDocuments;
      if (typeof numDocs === 'number' && numDocs >= 0) {
        const bpIds = [];
        for (let idx = 1; idx <= numDocs; idx++) {
          const dRes = await action.batchPlay(
            [
              {
                _obj: 'get',
                _target: [
                  { _ref: 'property', _property: 'documentID' },
                  { _ref: 'document', _index: idx },
                ],
              },
            ],
            {}
          );
          const dId = dRes && dRes[0] && dRes[0].documentID;
          if (typeof dId === 'number' && Number.isFinite(dId)) bpIds.push(dId);
        }
        if (numDocs === 0 || bpIds.length > 0) return bpIds;
      }
    } catch (_) {
      /* fall back to DOM app.documents */
    }
  }

  const docs = getOpenDocsArray(app);
  const ids = [];
  for (let i = 0; i < docs.length; i++) {
    const id = getEntityId(docs[i]);
    if (Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

/**
 * Format canonical Benday output layer name.
 */
function formatBendayLayerName({ meshTpi, lpiActive, ruleOfN }) {
  return `${LAYER_PREFIX} (${meshTpi} TPI · ${Number(lpiActive).toFixed(1)} LPI · N=${ruleOfN})`;
}

/**
 * Validate active Photoshop document before opening the Benday modal dialog.
 * Rejects missing documents or non-CMYK documents cleanly with profile-conversion guidance.
 *
 * @param {object} app - Photoshop UXP app object
 * @returns {{ ok: boolean, code?: string, title: string, message: string, docInfo?: object }}
 */
function validateDocument(app) {
  const doc = app && app.activeDocument;
  if (!doc) {
    return {
      ok: false,
      code: 'ERR_NO_DOCUMENT',
      title: 'No Open Document',
      message: 'Please open a CMYK document in Photoshop before running Electrosaur: Benday.',
    };
  }

  const modeStr = String(doc.mode || '');
  if (!modeStr.toUpperCase().includes('CMYK')) {
    return {
      ok: false,
      code: 'ERR_NOT_CMYK',
      title: 'CMYK Document Required',
      message:
        `Active document "${doc.name || 'Untitled'}" is in ${modeStr || 'non-CMYK'} mode.\n\n` +
        'Convert your document to your shop CMYK profile first via Edit → Convert to Profile... ' +
        '(or Image → Mode → CMYK Color), then run Benday again.',
    };
  }

  if (!(doc.width > 0) || !(doc.height > 0)) {
    return {
      ok: false,
      code: 'ERR_EMPTY_DOCUMENT',
      title: 'Invalid Document Dimensions',
      message: 'Active CMYK document has zero width or height.',
    };
  }

  return {
    ok: true,
    title: 'OK',
    message: '',
    docInfo: {
      id: getEntityId(doc),
      name: doc.name || 'Untitled.psd',
      mode: modeStr,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution || 300,
      bitsPerChannel: doc.bitsPerChannel || 8,
    },
  };
}

/**
 * Compute clamped integer pixel bounds for 1:1 native-resolution preview crop.
 */
function computeCropBounds(docWidth, docHeight, cropCenter = { x: 0.5, y: 0.5 }, cropSize = 320) {
  const w = Math.min(docWidth, Math.max(16, Math.round(cropSize)));
  const h = Math.min(docHeight, Math.max(16, Math.round(cropSize)));
  const cx = Math.round((cropCenter.x == null ? 0.5 : cropCenter.x) * docWidth);
  const cy = Math.round((cropCenter.y == null ? 0.5 : cropCenter.y) * docHeight);
  const left = Math.max(0, Math.min(docWidth - w, cx - (w >> 1)));
  const top = Math.max(0, Math.min(docHeight - h, cy - (h >> 1)));
  return {
    left,
    top,
    right: left + w,
    bottom: top + h,
    width: w,
    height: h,
  };
}

/**
 * Recursively hide any prior `Benday Halftone*` layers on a document (**Re-run Guard**).
 */
function hidePriorBendayLayers(layers) {
  if (!layers) return 0;
  let hidden = 0;
  const arr = Array.from(layers);
  for (let i = 0; i < arr.length; i++) {
    const layer = arr[i];
    if (layer && typeof layer.name === 'string' && layer.name.startsWith(LAYER_PREFIX)) {
      try {
        layer.visible = false;
      } catch (_) {
        /* fallback handled via batchPlay hide */
      }
      hidden++;
    }
    if (layer && layer.layers && layer.layers.length > 0) {
      hidden += hidePriorBendayLayers(layer.layers);
    }
  }
  return hidden;
}

/**
 * Check whether a Photoshop document uses 16-bit channels.
 */
function isDoc16Bit(doc) {
  if (!doc) return false;
  if (doc.bitsPerChannel === 16) return true;
  return String(doc.bitsPerChannel || '').includes('16');
}

/**
 * Extract raw pixel array from UXP imaging.getPixels() result and dispose imageData handle.
 */
async function extractPixelsBuffer(pixelResult) {
  if (pixelResult && pixelResult.imageData) {
    try {
      const data = await pixelResult.imageData.getData({ chunky: true });
      return data;
    } finally {
      if (typeof pixelResult.imageData.dispose === 'function') {
        pixelResult.imageData.dispose();
      }
    }
  }
  if (pixelResult && pixelResult.pixels) {
    return pixelResult.pixels;
  }
  throw new Error('Unexpected imaging.getPixels response shape');
}

/**
 * Select an open Photoshop document by finite integer ID via batchPlay.
 */
async function selectDocumentById(action, docId) {
  if (!action || typeof action.batchPlay !== 'function' || !Number.isFinite(docId)) return;
  await action.batchPlay(
    [{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }],
    {}
  );
}

/**
 * Collect ActionManager layer references (`_id` when finite, `_name` fallback) of any prior
 * `Benday Halftone*` layers recursively across root & groups.
 */
function collectPriorBendayLayerRefs(layers, out = []) {
  if (!layers) return out;
  const arr = Array.from(layers);
  for (let i = 0; i < arr.length; i++) {
    const layer = arr[i];
    if (layer && typeof layer.name === 'string' && layer.name.startsWith(LAYER_PREFIX)) {
      const id = getEntityId(layer);
      out.push(
        Number.isFinite(id)
          ? { _ref: 'layer', _id: id }
          : { _ref: 'layer', _name: layer.name }
      );
    }
    if (layer && layer.layers && layer.layers.length > 0) {
      collectPriorBendayLayerRefs(layer.layers, out);
    }
  }
  return out;
}

/**
 * Collect ActionManager layer references (`_id` when finite, `_name` fallback) for root layers
 * that are NOT `Benday Halftone*` output layers.
 */
function collectNonBendayRootLayerRefs(layers) {
  const refs = [];
  const domLayers = [];
  if (!layers) return { refs, domLayers };
  const arr = Array.from(layers);
  for (let i = 0; i < arr.length; i++) {
    const layer = arr[i];
    if (!layer) continue;
    const isBenday = typeof layer.name === 'string' && layer.name.startsWith(LAYER_PREFIX);
    if (isBenday) continue;
    domLayers.push(layer);
    const id = getEntityId(layer);
    refs.push(
      Number.isFinite(id)
        ? { _ref: 'layer', _id: id }
        : { _ref: 'layer', _name: layer.name }
    );
  }
  return { refs, domLayers };
}

/**
 * Return `true` if at least one non-`Benday Halftone*` layer in the tree is currently visible.
 */
function hasVisibleNonBendayLayer(layers) {
  if (!layers) return false;
  const arr = Array.from(layers);
  for (let i = 0; i < arr.length; i++) {
    const layer = arr[i];
    if (!layer) continue;
    const isBenday = typeof layer.name === 'string' && layer.name.startsWith(LAYER_PREFIX);
    if (!isBenday && layer.visible !== false) {
      return true;
    }
  }
  return false;
}

/**
 * Safely close all temporary documents by finite integer ID via pure `batchPlay` without saving,
 * enforcing a 3-gate safety lock (`select` -> verify `activeNow === tdId` and `activeNow !== origDocId` -> `close`)
 * so Photoshop ActionManager NEVER closes `origDoc` when `close` targets the active document.
 */
async function cleanupTempDocs(app, action, tempDocIds, origDocId) {
  if (!action || typeof action.batchPlay !== 'function') return;

  const uniqueIds = [];
  const seen = new Set();
  for (let i = tempDocIds.length - 1; i >= 0; i--) {
    const id = tempDocIds[i];
    if (Number.isFinite(id) && id !== origDocId && !seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  if (uniqueIds.length > 0) {
    const openIds = new Set(await listOpenDocIds(app, action));
    for (let i = 0; i < uniqueIds.length; i++) {
      const tdId = uniqueIds[i];
      if (openIds.size > 0 && !openIds.has(tdId)) continue;

      try {
        await selectDocumentById(action, tdId);
      } catch (_) {
        logWarn('Skipping close for temp doc', tdId, 'because selectDocumentById failed');
        continue;
      }

      const activeNow =
        (await queryActiveDocId(action)) ?? getEntityId(app && app.activeDocument);

      if (activeNow !== tdId || (origDocId != null && activeNow === origDocId)) {
        logWarn(
          'Skipping close for temp doc',
          tdId,
          'because active doc is',
          activeNow
        );
        continue;
      }

      try {
        await action.batchPlay(
          [
            {
              _obj: 'close',
              saving: { _enum: 'yesNo', _value: 'no' },
              _target: [{ _ref: 'document', _id: tdId }],
              documentID: tdId,
            },
          ],
          {}
        );
      } catch (_) {
        /* already closed */
      }
    }
  }

  if (Number.isFinite(origDocId)) {
    const openAfter = new Set(await listOpenDocIds(app, action));
    if (openAfter.size === 0 || openAfter.has(origDocId)) {
      try {
        await selectDocumentById(action, origDocId);
      } catch (_) {
        /* ignore if document is no longer selectable */
      }
    }
  }
}

/**
 * Pure-`batchPlay` temporary CMYK split workflow:
 *   select(origDocId) -> duplicate(targetEnum) -> Re-run Guard -> 8-bit -> flattenImage -> splitChannels.
 *
 * Avoids Adobe Photoshop v27.5+ UXP DOM regressions in `doc.duplicate()`, `doc.flatten()`, and
 * `doc.closeWithoutSaving()`, and tracks only finite integer IDs in `tempDocIds`.
 *
 * @returns {Promise<number[]>} 4 split Grayscale document IDs sorted ascending: [idC, idM, idY, idK]
 */
async function createTempSplitChannels(app, action, origDocId, origIs16, tempDocIds) {
  if (!Number.isFinite(origDocId)) {
    throw new Error(`Invalid active CMYK document ID (${origDocId})`);
  }

  await selectDocumentById(action, origDocId);

  const beforeDupIds = new Set(await listOpenDocIds(app, action));
  beforeDupIds.add(origDocId);

  // Pure batchPlay duplicate targeting active document (`targetEnum`) — bypasses broken UXP DOM `doc.duplicate()`
  const dupRes = await action.batchPlay(
    [
      {
        _obj: 'duplicate',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        name: '__Benday_Temp__',
      },
    ],
    {}
  );
  assertBatchPlayOk(dupRes, 'duplicate');

  let dupDocId =
    dupRes && dupRes[0] && typeof dupRes[0].documentID === 'number'
      ? dupRes[0].documentID
      : undefined;

  if (!Number.isFinite(dupDocId)) {
    const afterDupIds = await listOpenDocIds(app, action);
    dupDocId = afterDupIds.find((id) => !beforeDupIds.has(id));
  }
  if (!Number.isFinite(dupDocId)) {
    const activeId = getEntityId(app && app.activeDocument);
    if (Number.isFinite(activeId) && activeId !== origDocId) {
      dupDocId = activeId;
    }
  }
  if (!Number.isFinite(dupDocId)) {
    const queriedId = await queryActiveDocId(action);
    if (Number.isFinite(queriedId) && queriedId !== origDocId) {
      dupDocId = queriedId;
    }
  }

  if (!Number.isFinite(dupDocId) || dupDocId === origDocId) {
    throw new Error('Failed to resolve duplicated temporary CMYK document ID');
  }
  tempDocIds.push(dupDocId);

  await selectDocumentById(action, dupDocId);

  // Re-run Guard: hide prior Benday Halftone* layers before flattening, and if prior commit hid
  // all underlying source layers, re-enable them on this temporary duplicate so flattenImage
  // captures the original continuous-tone artwork rather than blank white.
  const dupDoc = findDocById(app, dupDocId) || (app && app.activeDocument);
  if (dupDoc && dupDoc.layers) {
    const priorDupRefs = collectPriorBendayLayerRefs(dupDoc.layers);
    hidePriorBendayLayers(dupDoc.layers);
    if (priorDupRefs.length > 0) {
      try {
        await action.batchPlay(
          [
            {
              _obj: 'hide',
              null: priorDupRefs,
            },
          ],
          {}
        );
      } catch (_) {
        /* DOM layer.visible already applied where supported */
      }
    }

    if (!hasVisibleNonBendayLayer(dupDoc.layers)) {
      const { refs: srcRefs, domLayers: srcDomLayers } = collectNonBendayRootLayerRefs(
        dupDoc.layers
      );
      for (let i = 0; i < srcDomLayers.length; i++) {
        try {
          srcDomLayers[i].visible = true;
        } catch (_) {
          /* fallback handled via batchPlay show */
        }
      }
      if (srcRefs.length > 0) {
        try {
          await action.batchPlay(
            [
              {
                _obj: 'show',
                null: srcRefs,
              },
            ],
            {}
          );
        } catch (_) {
          /* DOM layer.visible already applied where supported */
        }
      }
    }
  }

  // Convert duplicate to 8-bit if origDoc is 16-bit
  if (origIs16 || isDoc16Bit(dupDoc)) {
    await action.batchPlay(
      [
        {
          _obj: 'convertMode',
          depth: 8,
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {}
    );
  }

  // Pure batchPlay flatten over white (never call UXP DOM `dupDoc.flatten()`)
  const flatRes = await action.batchPlay([{ _obj: 'flattenImage' }], {});
  assertBatchPlayOk(flatRes, 'flattenImage');

  // Record existing open document IDs prior to splitChannels
  const preSplitIds = new Set(await listOpenDocIds(app, action));
  preSplitIds.add(origDocId);
  preSplitIds.add(dupDocId);

  const splitRes = await action.batchPlay([{ _obj: 'splitChannels' }], {});
  assertBatchPlayOk(splitRes, 'splitChannels');

  const postSplitIds = await listOpenDocIds(app, action);
  const splitDocIds = postSplitIds
    .filter((id) => Number.isFinite(id) && !preSplitIds.has(id))
    .sort((a, b) => a - b);

  for (let i = 0; i < splitDocIds.length; i++) {
    tempDocIds.push(splitDocIds[i]);
  }

  if (splitDocIds.length < 4) {
    throw new Error(
      `splitChannels expected at least 4 CMYK Grayscale documents, got ${splitDocIds.length}`
    );
  }

  // Verify [C, M, Y, K] order by querying each split document's ActionManager `title`,
  // falling back cleanly to `splitDocIds.slice(0, 4)` when `title` is unpopulated.
  const matchedByKey = {};
  for (let i = 0; i < splitDocIds.length; i++) {
    const sId = splitDocIds[i];
    const title = await queryDocumentTitle(action, sId);
    const chKey = classifySplitChannelTitle(title);
    if (chKey && matchedByKey[chKey] === undefined) {
      matchedByKey[chKey] = sId;
    }
  }

  const orderedCmykIds =
    matchedByKey.C !== undefined &&
    matchedByKey.M !== undefined &&
    matchedByKey.Y !== undefined &&
    matchedByKey.K !== undefined
      ? [matchedByKey.C, matchedByKey.M, matchedByKey.Y, matchedByKey.K]
      : splitDocIds.slice(0, 4);

  logInfo(
    `Split CMYK channels from temp doc ${dupDocId} -> [${orderedCmykIds.join(', ')}]` +
      (splitDocIds.length > 4 ? ` (+${splitDocIds.length - 4} extra)` : '')
  );

  // Return the 4 CMYK component channel doc IDs [C, M, Y, K]; extra alpha/spot IDs stay in tempDocIds for cleanup
  return orderedCmykIds;
}

/**
 * Read a 1:1 native-resolution continuous-tone CMYK crop from the active document
 * (with prior Benday Halftone* layers hidden and 255 - gray ink polarity applied).
 */
async function readPreviewCrop(app, cropBounds, psDeps) {
  const validation = validateDocument(app);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const ps = psDeps || require('photoshop');
  const { core, action, imaging } = ps;
  const origDoc = app.activeDocument;
  const origIs16 = isDoc16Bit(origDoc);
  const dpi = origDoc.resolution || 300;

  const bounds = cropBounds
    ? {
        left: Math.max(0, Math.floor(cropBounds.left)),
        top: Math.max(0, Math.floor(cropBounds.top)),
        right: Math.min(origDoc.width, Math.ceil(cropBounds.right)),
        bottom: Math.min(origDoc.height, Math.ceil(cropBounds.bottom)),
      }
    : computeCropBounds(origDoc.width, origDoc.height);

  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Preview crop bounds are empty');
  }

  const runRead = async () => {
    const t0 = Date.now();
    const tempDocIds = [];
    let origDocId = getEntityId(app.activeDocument) ?? getEntityId(origDoc);
    if (!Number.isFinite(origDocId)) {
      origDocId = await queryActiveDocId(action);
    }

    try {
      const splitDocIds = await createTempSplitChannels(
        app,
        action,
        origDocId,
        origIs16,
        tempDocIds
      );
      const channels = {};
      const pixelCount = width * height;

      for (let c = 0; c < CHANNEL_ORDER.length; c++) {
        const chKey = CHANNEL_ORDER[c].key;
        const chId = splitDocIds[c];
        const pxRes = await imaging.getPixels({
          documentID: chId,
          componentSize: 8,
          colorSpace: 'Grayscale',
          sourceBounds: {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
          },
        });
        const gray = await extractPixelsBuffer(pxRes);
        if (gray.length !== pixelCount) {
          throw new Error(
            `Channel ${chKey} preview read returned ${gray.length} bytes, expected ${pixelCount}`
          );
        }
        // Polarity contract: Photoshop Grayscale split-channel encodes 0 = 100% ink, 255 = 0% paper
        const ink = new Uint8Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
          ink[i] = 255 - gray[i];
        }
        channels[chKey] = ink;
      }

      logInfo(
        `Read preview crop (${bounds.left},${bounds.top}) ${width}x${height} px from doc ${origDocId} in ${Date.now() - t0} ms`
      );

      return {
        channels,
        width,
        height,
        dpi,
        bounds,
      };
    } finally {
      await cleanupTempDocs(app, action, tempDocIds, origDocId);
    }
  };

  if (core && typeof core.executeAsModal === 'function') {
    return await core.executeAsModal(runRead, { commandName: 'Benday: Read Preview Crop' });
  }
  return await runRead();
}

/**
 * Pre-modal full-document continuous-tone CMYK channel read (with Re-run Guard and 255 - gray
 * ink polarity applied). Executed BEFORE `dlg.uxpShowModal(...)` opens so Photoshop's modal window
 * manager never blocks temporary document creation, and reused during `commitHalftoneLayer`.
 */
async function readFullCmykChannels(app, psDeps) {
  const validation = validateDocument(app);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const ps = psDeps || require('photoshop');
  const { core, action, imaging } = ps;
  const origDoc = app.activeDocument;
  const width = origDoc.width;
  const height = origDoc.height;
  const origIs16 = isDoc16Bit(origDoc);
  const dpi = origDoc.resolution || 300;
  const pixelCount = width * height;

  const runReadFull = async () => {
    const t0 = Date.now();
    const tempDocIds = [];
    let origDocId = getEntityId(app.activeDocument) ?? getEntityId(origDoc);
    if (!Number.isFinite(origDocId)) {
      origDocId = await queryActiveDocId(action);
    }

    try {
      const splitDocIds = await createTempSplitChannels(
        app,
        action,
        origDocId,
        origIs16,
        tempDocIds
      );
      const channels = {};

      for (let c = 0; c < CHANNEL_ORDER.length; c++) {
        const chKey = CHANNEL_ORDER[c].key;
        const chId = splitDocIds[c];
        const pxRes = await imaging.getPixels({
          documentID: chId,
          componentSize: 8,
          colorSpace: 'Grayscale',
          sourceBounds: { left: 0, top: 0, right: width, bottom: height },
        });
        const gray = await extractPixelsBuffer(pxRes);
        if (gray.length !== pixelCount) {
          throw new Error(
            `Channel ${chKey} full read returned ${gray.length} bytes, expected ${pixelCount}`
          );
        }
        const ink = new Uint8Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
          ink[i] = 255 - gray[i];
        }
        channels[chKey] = ink;
      }

      logInfo(
        `Read full CMYK channels (${width}x${height} px) from doc ${origDocId} in ${Date.now() - t0} ms`
      );

      return {
        channels,
        width,
        height,
        dpi,
      };
    } finally {
      await cleanupTempDocs(app, action, tempDocIds, origDocId);
    }
  };

  if (core && typeof core.executeAsModal === 'function') {
    return await core.executeAsModal(runReadFull, { commandName: 'Benday: Read CMYK Channels' });
  }
  return await runReadFull();
}

/**
 * Pure-JS < 1 ms 1:1 crop slicer over cached `readFullCmykChannels` data.
 * Requires zero Photoshop / ActionManager calls while `uxpShowModal` is open.
 */
function sliceCmykCrop(fullData, cropBounds) {
  if (!fullData || !fullData.channels || !(fullData.width > 0) || !(fullData.height > 0)) {
    throw new Error('Invalid full CMYK channel cache for crop slicing');
  }

  const fullW = fullData.width;
  const fullH = fullData.height;
  const bounds = cropBounds
    ? {
        left: Math.max(0, Math.floor(cropBounds.left)),
        top: Math.max(0, Math.floor(cropBounds.top)),
        right: Math.min(fullW, Math.ceil(cropBounds.right)),
        bottom: Math.min(fullH, Math.ceil(cropBounds.bottom)),
      }
    : computeCropBounds(fullW, fullH);

  const cw = bounds.right - bounds.left;
  const ch = bounds.bottom - bounds.top;
  if (!(cw > 0) || !(ch > 0)) {
    throw new Error('Preview crop bounds are empty');
  }

  const channels = {};
  for (let c = 0; c < CHANNEL_ORDER.length; c++) {
    const chKey = CHANNEL_ORDER[c].key;
    const src = fullData.channels[chKey];
    if (!(src instanceof Uint8Array) || src.length !== fullW * fullH) {
      throw new Error(`Missing or invalid cached ${chKey} channel buffer`);
    }
    const dst = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      const srcOffset = (bounds.top + y) * fullW + bounds.left;
      dst.set(src.subarray(srcOffset, srcOffset + cw), y * cw);
    }
    channels[chKey] = dst;
  }

  return {
    channels,
    width: cw,
    height: ch,
    dpi: fullData.dpi || 300,
    bounds: {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: cw,
      height: ch,
    },
  };
}

/**
 * Commit full-resolution discrete {0, 255} CMYK halftone screens onto a single top CMYK pixel layer
 * on origDoc inside a single executeAsModal & single Undo step (suspendHistory).
 */
async function commitHalftoneLayer(
  app,
  core,
  action,
  imaging,
  stateConfig = {},
  onProgress,
  preReadChannels = null
) {
  const validation = validateDocument(app);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const origDoc = app.activeDocument;
  const width = origDoc.width;
  const height = origDoc.height;
  const dpi = origDoc.resolution || stateConfig.dpi || 300;
  const origIs16 = isDoc16Bit(origDoc);
  const pixelCount = width * height;
  const report = typeof onProgress === 'function' ? onProgress : () => {};

  return await core.executeAsModal(
    async (executionContext) => {
      const tStart = Date.now();
      const updateModalProgress = (frac, message) => {
        report(frac, message);
        if (executionContext && typeof executionContext.reportProgress === 'function') {
          executionContext.reportProgress({ value: frac, message });
        }
      };

      const tempDocIds = [];
      let origDocId = getEntityId(app.activeDocument) ?? getEntityId(origDoc);
      if (!Number.isFinite(origDocId)) {
        origDocId = await queryActiveDocId(action);
      }
      if (!Number.isFinite(origDocId)) {
        throw new Error('Could not resolve finite integer documentID for active CMYK document');
      }

      logInfo(
        `Starting commitHalftoneLayer on doc ${origDocId} (${width}x${height} @ ${dpi} DPI, ${origIs16 ? 16 : 8}-bit)`,
        stateConfig
      );

      try {
        // Step 1: Duplicate -> Re-run Guard -> 8-bit -> Flatten -> splitChannels
        updateModalProgress(0.1, 'Splitting CMYK channels...');
        const splitDocIds = await createTempSplitChannels(
          app,
          action,
          origDocId,
          origIs16,
          tempDocIds
        );

        // Step 2: Reuse pre-read CMYK channels if valid, else read full-res grayscale channels & invert polarity
        const hasValidPreRead = Boolean(
          preReadChannels &&
            CHANNEL_ORDER.every(
              ({ key }) =>
                preReadChannels[key] instanceof Uint8Array &&
                preReadChannels[key].length === pixelCount
            )
        );

        let channels;
        if (hasValidPreRead) {
          logInfo(`Reusing pre-read full-res CMYK channels (${width}x${height} px)`);
          channels = {
            C: preReadChannels.C,
            M: preReadChannels.M,
            Y: preReadChannels.Y,
            K: preReadChannels.K,
          };
        } else {
          updateModalProgress(0.25, 'Reading CMYK continuous-tone channels...');
          channels = {};
          for (let c = 0; c < CHANNEL_ORDER.length; c++) {
            const chKey = CHANNEL_ORDER[c].key;
            const chId = splitDocIds[c];
            const pxRes = await imaging.getPixels({
              documentID: chId,
              componentSize: 8,
              colorSpace: 'Grayscale',
              sourceBounds: { left: 0, top: 0, right: width, bottom: height },
            });
            const gray = await extractPixelsBuffer(pxRes);
            if (gray.length !== pixelCount) {
              throw new Error(
                `Channel ${chKey} full-res read returned ${gray.length} bytes, expected ${pixelCount}`
              );
            }
            const ink = new Uint8Array(pixelCount);
            for (let i = 0; i < pixelCount; i++) {
              ink[i] = 255 - gray[i];
            }
            channels[chKey] = ink;
          }
        }

        // Step 3: Run zero-dependency mesh-aware halftone engine
        updateModalProgress(0.5, 'Computing mesh-aware CMYK halftone screens...');
        const tEngine = Date.now();
        const halftoneResult = halftoneCmyk(channels, width, height, {
          ...stateConfig,
          dpi,
        });
        const { plates, meshSpec, moireReport, angles } = halftoneResult;
        logInfo(
          `Computed 4 halftone screens in ${Date.now() - tEngine} ms (${meshSpec.lpiActive.toFixed(1)} LPI, D_min=${meshSpec.dMinPx} px)`
        );

        // Step 4: Invert back (grayOut = 255 - plate) & write back into split Grayscale docs
        updateModalProgress(0.75, 'Writing discrete halftone channels...');
        for (let c = 0; c < CHANNEL_ORDER.length; c++) {
          const chKey = CHANNEL_ORDER[c].key;
          const chId = splitDocIds[c];
          const plate = plates[chKey];

          await selectDocumentById(action, chId);

          // Promote locked Background layer to unlocked pixel layer before putPixels
          const preDoc = findDocById(app, chId) || (app && app.activeDocument);
          const initialChLayer = preDoc && preDoc.layers && preDoc.layers[0];
          if (!initialChLayer || initialChLayer.isBackgroundLayer !== false) {
            try {
              await action.batchPlay(
                [
                  {
                    _obj: 'set',
                    _target: [{ _ref: 'layer', _property: 'background' }],
                    to: { _obj: 'layer', name: 'Layer 0' },
                  },
                ],
                {}
              );
            } catch (bgErr) {
              // If already unlocked despite missing isBackgroundLayer flag, allow continuation
              if (initialChLayer && initialChLayer.isBackgroundLayer === true) {
                throw bgErr;
              }
              logWarn(`Background promotion skipped on doc ${chId}:`, bgErr);
            }
          }

          let imageBuffer;
          let componentSize = 8;
          if (origIs16) {
            await action.batchPlay(
              [
                {
                  _obj: 'convertMode',
                  depth: 16,
                  _options: { dialogOptions: 'dontDisplay' },
                },
              ],
              {}
            );
            componentSize = 16;
            const buf16 = new Uint16Array(pixelCount);
            for (let i = 0; i < pixelCount; i++) {
              // plate === 255 (100% ink) -> gray 0; plate === 0 (0% paper) -> gray 32768 (16-bit PS white)
              buf16[i] = plate[i] === 255 ? 0 : 32768;
            }
            imageBuffer = buf16;
          } else {
            const buf8 = new Uint8Array(pixelCount);
            for (let i = 0; i < pixelCount; i++) {
              buf8[i] = 255 - plate[i];
            }
            imageBuffer = buf8;
          }

          const freshDoc = findDocById(app, chId) || (app && app.activeDocument);
          let targetLayerId =
            (freshDoc &&
              freshDoc.activeLayers &&
              freshDoc.activeLayers[0] &&
              getEntityId(freshDoc.activeLayers[0])) ??
            (freshDoc &&
              freshDoc.layers &&
              freshDoc.layers[0] &&
              getEntityId(freshDoc.layers[0]));
          if (!Number.isFinite(targetLayerId)) {
            targetLayerId = await queryActiveLayerId(action);
          }
          if (!Number.isFinite(chId) || !Number.isFinite(targetLayerId)) {
            throw new Error(
              `Missing finite IDs for putPixels on channel ${chKey} (doc=${chId}, layer=${targetLayerId})`
            );
          }

          const imgData = await imaging.createImageDataFromBuffer(imageBuffer, {
            width,
            height,
            components: 1,
            componentSize,
            chunky: true,
            colorSpace: 'Grayscale',
          });

          try {
            await imaging.putPixels({
              documentID: chId,
              layerID: targetLayerId,
              imageData: imgData,
              replace: true,
            });
          } finally {
            if (imgData && typeof imgData.dispose === 'function') {
              imgData.dispose();
            }
          }
        }

        // Step 5: Single-undo commit onto origDoc via suspendHistory + applyImage per channel
        updateModalProgress(0.9, 'Applying CMYK halftone layer...');
        await selectDocumentById(action, origDocId);
        const liveOrigDoc = findDocById(app, origDocId) || (app && app.activeDocument) || origDoc;

        const layerName = formatBendayLayerName({
          meshTpi: meshSpec.meshTpi,
          lpiActive: meshSpec.lpiActive,
          ruleOfN: meshSpec.ruleOfN,
        });

        let suspensionID = null;
        if (
          executionContext &&
          executionContext.hostControl &&
          typeof executionContext.hostControl.suspendHistory === 'function'
        ) {
          suspensionID = await executionContext.hostControl.suspendHistory({
            documentID: origDocId,
            name: LAYER_PREFIX,
          });
        }

        try {
          // Delete any prior Benday Halftone* layers on origDoc (Re-run replacement)
          const priorLayerRefs = collectPriorBendayLayerRefs(liveOrigDoc && liveOrigDoc.layers);
          for (let i = 0; i < priorLayerRefs.length; i++) {
            await action.batchPlay(
              [{ _obj: 'delete', _target: [priorLayerRefs[i]] }],
              {}
            );
          }

          // Create CMYK pixel layer, move to root front (best-effort: Photoshop returns an ActionManager
          // error when the newly created layer is ALREADY at root front!), and fill with 100% white.
          const makeRes = await action.batchPlay(
            [
              {
                _obj: 'make',
                _target: [{ _ref: 'layer' }],
                using: { _obj: 'layer', name: layerName },
              },
            ],
            {}
          );
          assertBatchPlayOk(makeRes, 'layer make');

          try {
            await action.batchPlay(
              [
                {
                  _obj: 'move',
                  _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                  to: { _ref: 'layer', _enum: 'ordinal', _value: 'front' },
                  adjustment: false,
                },
              ],
              {}
            );
          } catch (_) {
            /* best-effort: already at root front */
          }

          const fillRes = await action.batchPlay(
            [
              {
                _obj: 'fill',
                using: { _enum: 'fillContents', _value: 'white' },
                opacity: { _unit: 'percentUnit', _value: 100 },
                mode: { _enum: 'blendMode', _value: 'normal' },
              },
            ],
            {}
          );
          assertBatchPlayOk(fillRes, 'layer fill');

          // Apply each split Grayscale doc onto its corresponding CMYK channel
          for (let c = 0; c < CHANNEL_ORDER.length; c++) {
            const { psChannel } = CHANNEL_ORDER[c];
            const chId = splitDocIds[c];
            const selChRes = await action.batchPlay(
              [
                {
                  _obj: 'select',
                  _target: [{ _ref: 'channel', _enum: 'channel', _value: psChannel }],
                },
              ],
              {}
            );
            assertBatchPlayOk(selChRes, `select channel (${psChannel})`);

            const applyRes = await action.batchPlay(
              [
                {
                  _obj: 'applyImageEvent',
                  with: {
                    _obj: 'calculation',
                    to: {
                      _ref: [
                        { _ref: 'channel', _enum: 'channel', _value: 'gray' },
                        { _ref: 'document', _id: chId },
                      ],
                    },
                  },
                },
              ],
              {}
            );
            assertBatchPlayOk(applyRes, `applyImageEvent (${psChannel})`);
          }

          // Reselect composite CMYK channels via UXP DOM componentChannels (with batchPlay fallback)
          let compositeSelected = false;
          if (liveOrigDoc && liveOrigDoc.componentChannels) {
            try {
              liveOrigDoc.activeChannels = liveOrigDoc.componentChannels;
              compositeSelected = true;
            } catch (_) {
              compositeSelected = false;
            }
          }
          if (!compositeSelected) {
            try {
              await action.batchPlay(
                [
                  {
                    _obj: 'select',
                    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'CMYKEnum' }],
                  },
                ],
                {}
              );
            } catch (_) {
              await action.batchPlay(
                [
                  {
                    _obj: 'select',
                    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'CMYK' }],
                  },
                ],
                {}
              );
            }
          }

          // Mark original underlying layer(s) not visible (matching Reveal's ProductionWorker.js)
          if (liveOrigDoc && liveOrigDoc.layers) {
            const { refs: origUnderlyingRefs, domLayers: origUnderlyingLayers } =
              collectNonBendayRootLayerRefs(liveOrigDoc.layers);
            for (let i = 0; i < origUnderlyingLayers.length; i++) {
              try {
                origUnderlyingLayers[i].visible = false;
              } catch (_) {
                /* fallback handled via batchPlay hide */
              }
            }
            if (origUnderlyingRefs.length > 0) {
              try {
                await action.batchPlay(
                  [
                    {
                      _obj: 'hide',
                      null: origUnderlyingRefs,
                    },
                  ],
                  {}
                );
              } catch (_) {
                /* DOM layer.visible already applied where supported */
              }
            }
          }

          if (suspensionID !== null) {
            await executionContext.hostControl.resumeHistory(suspensionID);
          }
        } catch (commitErr) {
          if (suspensionID !== null) {
            await executionContext.hostControl.resumeHistory(suspensionID, false);
          }
          throw commitErr;
        }

        updateModalProgress(1.0, 'Done');
        logInfo(`Committed "${layerName}" on doc ${origDocId} in ${Date.now() - tStart} ms`);

        return {
          layerName,
          meshSpec,
          moireReport,
          angles,
          width,
          height,
        };
      } finally {
        await cleanupTempDocs(app, action, tempDocIds, origDocId);
      }
    },
    { commandName: LAYER_PREFIX }
  );
}

module.exports = {
  LAYER_PREFIX,
  CHANNEL_ORDER,
  assertBatchPlayOk,
  getEntityId,
  getOpenDocsArray,
  queryActiveDocId,
  queryActiveLayerId,
  queryDocumentTitle,
  classifySplitChannelTitle,
  listOpenDocIds,
  formatBendayLayerName,
  validateDocument,
  computeCropBounds,
  hidePriorBendayLayers,
  readPreviewCrop,
  readFullCmykChannels,
  sliceCmykCrop,
  commitHalftoneLayer,
};

import { describe, it, expect } from 'vitest';
import PhotoshopCmykBridge from '../src/bridge/PhotoshopCmykBridge.js';
import { createMockPhotoshopEnv } from './mocks/photoshop.js';

describe('PhotoshopCmykBridge Mock UXP Suite', () => {
  it('rejects missing documents and non-CMYK documents with profile conversion guidance', () => {
    const emptyEnv = createMockPhotoshopEnv({ noDocument: true });
    const resNoDoc = PhotoshopCmykBridge.validateDocument(emptyEnv.app);
    expect(resNoDoc.ok).toBe(false);
    expect(resNoDoc.code).toBe('ERR_NO_DOCUMENT');

    const rgbEnv = createMockPhotoshopEnv({ mode: 'RGBColorMode' });
    const resRgb = PhotoshopCmykBridge.validateDocument(rgbEnv.app);
    expect(resRgb.ok).toBe(false);
    expect(resRgb.code).toBe('ERR_NOT_CMYK');
    expect(resRgb.message).toContain('Convert to Profile');

    const cmykEnv = createMockPhotoshopEnv({ mode: 'CMYKColorMode' });
    const resOk = PhotoshopCmykBridge.validateDocument(cmykEnv.app);
    expect(resOk.ok).toBe(true);
  });

  it('enforces Re-run Guard, 255 - gray polarity contract, single suspendHistory, and tempDoc cleanup on 8-bit commit', async () => {
    const W = 48;
    const H = 48;
    const N = W * H;
    // C = 0% paper (ink=0 -> PS gray=255), K = 100% solid (ink=255 -> PS gray=0)
    const env = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      bitsPerChannel: 8,
      priorHalftoneLayer: true,
      cmykInkChannels: {
        C: new Uint8Array(N).fill(0),
        M: new Uint8Array(N).fill(128),
        Y: new Uint8Array(N).fill(0),
        K: new Uint8Array(N).fill(255),
      },
    });

    const result = await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 230, ruleOfN: 4.0, meshAngleDeg: 18, tailMode: 'hybrid' }
    );

    expect(result.layerName).toMatch(/^Benday Halftone \(230 TPI · 57\.5 LPI · N=4\)$/);

    // Prior Benday Halftone* layer on origDoc was replaced (only 1 Benday layer + 1 Artwork layer)
    expect(env.origDoc.layers.length).toBe(2);
    expect(env.origDoc.layers[0].name).toBe(result.layerName);
    expect(env.origDoc.layers[1].name).toBe('Artwork');

    // Verify all 4 channels were applied and composite CMYK reselected
    expect(Object.keys(env.appliedChannels).sort()).toEqual(['black', 'cyan', 'magenta', 'yellow']);

    // Verify polarity contract on written grayscale buffers:
    // Cyan (0% ink) -> plate=0 -> grayOut = 255 (white in PS channel = 0% ink)
    const cyanDocId = env.appliedChannels.cyan;
    const cyanWritten = env.putPixelsBuffers[cyanDocId].buffer;
    expect(cyanWritten.every((v) => v === 255)).toBe(true);

    // Black (100% solid ink) -> plate=255 -> grayOut = 0 (black in PS channel = 100% ink)
    const blackDocId = env.appliedChannels.black;
    const blackWritten = env.putPixelsBuffers[blackDocId].buffer;
    expect(blackWritten.every((v) => v === 0)).toBe(true);

    // Single undo step (1 suspend + 1 committed resume)
    expect(env.historyCalls).toEqual([
      { type: 'suspend', id: 'susp_1', documentID: env.origDoc.id, name: 'Benday Halftone' },
      { type: 'resume', id: 'susp_1', commit: true },
    ]);

    // Zero leaked temporary documents
    expect(env.app.documents.length).toBe(1);
    expect(env.app.documents[0].id).toBe(env.origDoc.id);
    expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);
  });

  it('upconverts output split channels to 16-bit (0 / 32768) when origDoc is 16-bit CMYK', async () => {
    const W = 32;
    const H = 32;
    const N = W * H;
    const env = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      bitsPerChannel: 16,
      cmykInkChannels: {
        C: new Uint8Array(N).fill(0),
        M: new Uint8Array(N).fill(0),
        Y: new Uint8Array(N).fill(0),
        K: new Uint8Array(N).fill(255),
      },
    });

    await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 305, ruleOfN: 4.0 }
    );

    const cyanBuf = env.putPixelsBuffers[env.appliedChannels.cyan];
    const magentaBuf = env.putPixelsBuffers[env.appliedChannels.magenta];
    const yellowBuf = env.putPixelsBuffers[env.appliedChannels.yellow];
    const blackBuf = env.putPixelsBuffers[env.appliedChannels.black];
    expect(cyanBuf.meta.componentSize).toBe(16);
    expect(magentaBuf.meta.componentSize).toBe(16);
    expect(yellowBuf.meta.componentSize).toBe(16);
    expect(blackBuf.meta.componentSize).toBe(16);
    expect(cyanBuf.buffer instanceof Uint16Array).toBe(true);
    expect(cyanBuf.buffer[0]).toBe(32768); // 0% ink
    expect(blackBuf.buffer[0]).toBe(0);    // 100% ink

    // Verify getter-only app.activeDocument throws on direct assignment
    expect(() => {
      env.app.activeDocument = env.origDoc;
    }).toThrow(TypeError);
  });

  it('escapes top Layer Groups to root front, fills cleanly with white, and closes extra alpha split docs', async () => {
    const W = 32;
    const H = 32;
    const N = W * H;
    const env = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      bitsPerChannel: 8,
      topLayerIsGroup: true,
      extraChannels: 2, // 4 CMYK + 2 Alpha = 6 split docs + 1 dupDoc = 7 temp docs
      cmykInkChannels: {
        C: new Uint8Array(N).fill(0),
        M: new Uint8Array(N).fill(128),
        Y: new Uint8Array(N).fill(255),
        K: new Uint8Array(N).fill(0),
      },
    });

    const result = await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 230, ruleOfN: 4.0, meshAngleDeg: 18, tailMode: 'hybrid' }
    );

    // Must sit at root index 0 ABOVE 'Top Ink Group', NOT trapped inside Top Ink Group!
    expect(env.origDoc.layers.length).toBe(2);
    expect(env.origDoc.layers[0].name).toBe(result.layerName);
    expect(env.origDoc.layers[1].name).toBe('Top Ink Group');
    expect(env.origDoc.layers[1].layers.length).toBe(1);
    expect(env.origDoc.layers[1].layers[0].name).toBe('Artwork');

    // Fill descriptor uses clean `fillContents: 'white'`
    expect(env.getLastFillDescriptor().using).toEqual({
      _enum: 'fillContents',
      _value: 'white',
    });

    // Composite CMYK channels reselected on origDoc
    expect(env.origDoc.activeChannels).toBe(env.origDoc.componentChannels);

    // All 7 temp docs (1 dupDoc + 4 CMYK splitDocs + 2 Alpha splitDocs) closed without leaks
    expect(env.createdTempDocs.length).toBe(7);
    expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);
    expect(env.app.documents.length).toBe(1);
  });

  it('cleans up all tempDocs without leaking and rolls back suspendHistory when mid-pipeline errors occur', async () => {
    for (const failStep of ['getPixels', 'putPixels', 'applyImage']) {
      const env = createMockPhotoshopEnv({
        width: 32,
        height: 32,
        priorHalftoneLayer: true,
        throwOnStep: failStep,
      });

      await expect(
        PhotoshopCmykBridge.commitHalftoneLayer(
          env.app,
          env.core,
          env.action,
          env.imaging,
          { meshTpi: 230 }
        )
      ).rejects.toThrow(`Simulated ${failStep} failure`);

      // Only origDoc remains open — every temp duplicate & split channel doc was closed in finally!
      expect(env.app.documents.length).toBe(1);
      expect(env.app.documents[0].id).toBe(env.origDoc.id);
      expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);

      if (failStep === 'applyImage') {
        expect(env.historyCalls[1]).toEqual({ type: 'resume', id: 'susp_1', commit: false });
      }
    }
  });

  it('reads 1:1 preview crops with Re-run Guard and 255 - gray polarity and closes tempDocs', async () => {
    const env = createMockPhotoshopEnv({
      width: 100,
      height: 100,
      priorHalftoneLayer: true,
      cmykInkChannels: {
        C: new Uint8Array(10000).fill(50),
        M: new Uint8Array(10000).fill(100),
        Y: new Uint8Array(10000).fill(150),
        K: new Uint8Array(10000).fill(200),
      },
    });

    const crop = await PhotoshopCmykBridge.readPreviewCrop(
      env.app,
      { left: 10, top: 20, right: 42, bottom: 52 },
      { core: env.core, action: env.action, imaging: env.imaging }
    );

    expect(crop.width).toBe(32);
    expect(crop.height).toBe(32);
    expect(crop.channels.C[0]).toBe(50);
    expect(crop.channels.M[0]).toBe(100);
    expect(crop.channels.Y[0]).toBe(150);
    expect(crop.channels.K[0]).toBe(200);
    expect(env.app.documents.length).toBe(1);
  });

  it('survives Photoshop v27.5+ UXP DOM doc.duplicate() regression ("id of undefined") and dead closed Document proxies via pure batchPlay', async () => {
    const env = createMockPhotoshopEnv({
      width: 40,
      height: 40,
      resolution: 600,
      priorHalftoneLayer: true,
    });

    // Confirm UXP DOM convenience mutators throw the exact Photoshop v27.5+ regression if ever called
    await expect(env.origDoc.duplicate('__Benday_Temp__')).rejects.toThrow(
      'The document with an id of undefined does not exist.'
    );
    await expect(env.origDoc.flatten()).rejects.toThrow('UXP DOM doc.flatten() is forbidden');
    await expect(env.origDoc.closeWithoutSaving()).rejects.toThrow(
      'UXP DOM doc.closeWithoutSaving() is forbidden'
    );

    const crop = await PhotoshopCmykBridge.readPreviewCrop(
      env.app,
      { left: 0, top: 0, right: 32, bottom: 32 },
      { core: env.core, action: env.action, imaging: env.imaging }
    );
    expect(crop.width).toBe(32);

    const commitRes = await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 230, ruleOfN: 4.0 }
    );
    expect(commitRes.layerName).toContain('Benday Halftone');
    expect(env.app.documents.length).toBe(1);
    expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);
    // Reading `.id` on any closed temp document proxy throws in our strict mock — proving cleanup never touched dead proxies
    expect(() => env.createdTempDocs[0].id).toThrow('Cannot read .id on a closed UXP Document proxy');
  });

  it('falls back cleanly to _id and ActionManager batchPlay get (documentID, numberOfDocuments, layerID) when UXP DOM omits .id', async () => {
    for (const modeOpts of [{ useUnderscoreId: true }, { omitDomId: true }]) {
      const W = 32;
      const H = 32;
      const N = W * H;
      const env = createMockPhotoshopEnv({
        ...modeOpts,
        width: W,
        height: H,
        resolution: 600,
        priorHalftoneLayer: true,
        cmykInkChannels: {
          C: new Uint8Array(N).fill(0),
          M: new Uint8Array(N).fill(128),
          Y: new Uint8Array(N).fill(0),
          K: new Uint8Array(N).fill(255),
        },
      });

      expect(env.origDoc.id).toBeUndefined();

      const crop = await PhotoshopCmykBridge.readPreviewCrop(
        env.app,
        { left: 0, top: 0, right: 24, bottom: 24 },
        { core: env.core, action: env.action, imaging: env.imaging }
      );
      expect(crop.channels.K[0]).toBe(255);
      expect(crop.channels.C[0]).toBe(0);

      const res = await PhotoshopCmykBridge.commitHalftoneLayer(
        env.app,
        env.core,
        env.action,
        env.imaging,
        { meshTpi: 230, ruleOfN: 4.0 }
      );
      expect(res.layerName).toMatch(/^Benday Halftone/);
      expect(env.origDoc.layers.length).toBe(2);
      expect(env.origDoc.layers[0].name).toBe(res.layerName);
      expect(env.app.documents.length).toBe(1);
      expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);
    }
  });

  it('surfaces ActionManager {_obj: "error"} descriptors via assertBatchPlayOk when an open UXP modal blocks new document tabs', async () => {
    const env = createMockPhotoshopEnv({
      width: 32,
      height: 32,
      blockNewDocumentTabs: true,
    });

    await expect(
      PhotoshopCmykBridge.commitHalftoneLayer(
        env.app,
        env.core,
        env.action,
        env.imaging,
        { meshTpi: 230 }
      )
    ).rejects.toThrow("Photoshop duplicate failed: The command 'Duplicate' is not currently available.");
  });

  it('reads full CMYK channels pre-modal, slices arbitrary 1:1 crops in pure JS with zero extra Photoshop calls, and reuses preReadChannels on post-modal commit', async () => {
    const W = 48;
    const H = 48;
    const N = W * H;
    const rampC = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        rampC[y * W + x] = (x * 3 + y * 2) & 0xff;
      }
    }

    const envBaseline = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      cmykInkChannels: {
        C: rampC,
        M: new Uint8Array(N).fill(96),
        Y: new Uint8Array(N).fill(0),
        K: new Uint8Array(N).fill(255),
      },
    });
    await PhotoshopCmykBridge.commitHalftoneLayer(
      envBaseline.app,
      envBaseline.core,
      envBaseline.action,
      envBaseline.imaging,
      { meshTpi: 230, ruleOfN: 4.0 }
    );

    const env = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      cmykInkChannels: {
        C: rampC,
        M: new Uint8Array(N).fill(96),
        Y: new Uint8Array(N).fill(0),
        K: new Uint8Array(N).fill(255),
      },
    });

    // 1. Pre-modal full CMYK channel read (4 getPixels calls, 0 leaked temp docs)
    const fullData = await PhotoshopCmykBridge.readFullCmykChannels(env.app, {
      core: env.core,
      action: env.action,
      imaging: env.imaging,
    });
    expect(env.getGetPixelsCallCount()).toBe(4);
    expect(env.app.documents.length).toBe(1);

    // 2. Simulate open uxpShowModal blocking new document tabs; pure-JS sliceCmykCrop still works with 0 batchPlay calls!
    env.setModalTabBlockActive(true);
    const bpCountBeforeSlices = env.batchPlayLog.length;
    const cropA = PhotoshopCmykBridge.sliceCmykCrop(fullData, {
      left: 8,
      top: 12,
      right: 28,
      bottom: 36,
    });
    const cropB = PhotoshopCmykBridge.sliceCmykCrop(fullData, {
      left: 20,
      top: 4,
      right: 44,
      bottom: 28,
    });
    expect(env.batchPlayLog.length).toBe(bpCountBeforeSlices);
    expect(env.getGetPixelsCallCount()).toBe(4);
    expect(cropA.width).toBe(20);
    expect(cropA.height).toBe(24);
    expect(cropA.channels.C[0]).toBe(rampC[12 * W + 8]);
    expect(cropB.channels.C[0]).toBe(rampC[4 * W + 20]);

    // 3. Modal closes -> commitHalftoneLayer runs with preReadChannels (skips Step 2 getPixels completely!)
    env.setModalTabBlockActive(false);
    await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 230, ruleOfN: 4.0 },
      null,
      fullData.channels
    );

    // Zero additional getPixels calls were made during commitHalftoneLayer!
    expect(env.getGetPixelsCallCount()).toBe(4);
    expect(env.app.documents.length).toBe(1);
    expect(env.createdTempDocs.every((td) => td.closed)).toBe(true);

    // Output grayscale screens match non-cached commit bit-for-bit across all 4 channels
    for (const ch of ['cyan', 'magenta', 'yellow', 'black']) {
      const bufCached = env.putPixelsBuffers[env.appliedChannels[ch]].buffer;
      const bufBase = envBaseline.putPixelsBuffers[envBaseline.appliedChannels[ch]].buffer;
      expect(Array.from(bufCached)).toEqual(Array.from(bufBase));
    }
  });

  it('tolerates Photoshop "The command Move is not currently available" when new layer is already at front AND never closes origDoc under Step 5 failures', async () => {
    // 1. Normal document (topLayerIsGroup = false): mock returns {_obj: 'error', message: 'The command "Move" is not currently available.'}
    const okEnv = createMockPhotoshopEnv({
      width: 32,
      height: 32,
      topLayerIsGroup: false,
    });
    const okRes = await PhotoshopCmykBridge.commitHalftoneLayer(
      okEnv.app,
      okEnv.core,
      okEnv.action,
      okEnv.imaging,
      { meshTpi: 230 }
    );
    expect(okRes.layerName).toContain('Benday Halftone');
    expect(okEnv.origDoc.layers[0].name).toBe(okRes.layerName);
    expect(okEnv.app.documents.length).toBe(1);
    expect(okEnv.app.documents[0]).toBe(okEnv.origDoc);

    // 2. Mid-Step-5 failure ('fill') while origDoc is active and close targets activeDocument:
    //    cleanupTempDocs selects each temp doc first, closes all 4 split docs, and NEVER closes origDoc!
    const failFillEnv = createMockPhotoshopEnv({
      width: 32,
      height: 32,
      throwOnStep: 'fill',
    });
    await expect(
      PhotoshopCmykBridge.commitHalftoneLayer(
        failFillEnv.app,
        failFillEnv.core,
        failFillEnv.action,
        failFillEnv.imaging,
        { meshTpi: 230 }
      )
    ).rejects.toThrow('Simulated fill failure');
    expect(failFillEnv.app.documents.length).toBe(1);
    expect(failFillEnv.app.documents[0]).toBe(failFillEnv.origDoc);
    expect(failFillEnv.origDoc.closed).not.toBe(true);
    expect(failFillEnv.createdTempDocs.every((td) => td.closed)).toBe(true);

    // 3. Adversarial 3-Gate Lock test: if Photoshop refuses `select` on temp docs leaving `origDoc` active,
    //    cleanupTempDocs MUST skip `close` rather than closing `origDoc`!
    const lockedSelectEnv = createMockPhotoshopEnv({
      width: 32,
      height: 32,
      throwOnStep: 'fill',
      ignoreCleanupSelect: true,
    });
    await expect(
      PhotoshopCmykBridge.commitHalftoneLayer(
        lockedSelectEnv.app,
        lockedSelectEnv.core,
        lockedSelectEnv.action,
        lockedSelectEnv.imaging,
        { meshTpi: 230 }
      )
    ).rejects.toThrow('Simulated fill failure');
    expect(lockedSelectEnv.app.documents.includes(lockedSelectEnv.origDoc)).toBe(true);
    expect(lockedSelectEnv.origDoc.closed).not.toBe(true);
  });

  it('reorders out-of-order splitChannels documents accurately by ActionManager title and falls back cleanly when titles are absent', async () => {
    // Filename ambush check: "Black_Cat.psd_Cyan" must classify as C, never K
    expect(PhotoshopCmykBridge.classifySplitChannelTitle('Black_Cat.psd_Cyan')).toBe('C');
    expect(PhotoshopCmykBridge.classifySplitChannelTitle('Black_Cat.psd_C')).toBe('C');
    expect(PhotoshopCmykBridge.classifySplitChannelTitle('Cyan_Poster.psd_Black')).toBe('K');
    expect(PhotoshopCmykBridge.classifySplitChannelTitle('Poster_Spot_1')).toBeNull();

    const W = 32;
    const H = 32;
    const N = W * H;

    // 1. Out-of-order split channels with leading Spot alpha + reversed K, Y, M, C titles
    const reversedEnv = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      splitOrder: [
        { key: 'Alpha_1', suffix: 'Spot_1' },
        { key: 'K', suffix: 'Black' },
        { key: 'Y', suffix: 'Yellow' },
        { key: 'M', suffix: 'Magenta' },
        { key: 'C', suffix: 'Cyan' },
      ],
      cmykInkChannels: {
        C: new Uint8Array(N).fill(15),
        M: new Uint8Array(N).fill(95),
        Y: new Uint8Array(N).fill(175),
        K: new Uint8Array(N).fill(255),
      },
    });

    const fullRead = await PhotoshopCmykBridge.readFullCmykChannels(reversedEnv.app, {
      core: reversedEnv.core,
      action: reversedEnv.action,
      imaging: reversedEnv.imaging,
    });
    expect(fullRead.channels.C[0]).toBe(15);
    expect(fullRead.channels.M[0]).toBe(95);
    expect(fullRead.channels.Y[0]).toBe(175);
    expect(fullRead.channels.K[0]).toBe(255);
    expect(reversedEnv.app.documents.length).toBe(1);

    // Commit on out-of-order split docs writes each halftone plate to its true channel doc
    const zeroCyanEnv = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      splitOrder: [
        { key: 'K', suffix: 'Black' },
        { key: 'Y', suffix: 'Yellow' },
        { key: 'M', suffix: 'Magenta' },
        { key: 'C', suffix: 'Cyan' },
      ],
      cmykInkChannels: {
        C: new Uint8Array(N).fill(0),
        M: new Uint8Array(N).fill(0),
        Y: new Uint8Array(N).fill(0),
        K: new Uint8Array(N).fill(255),
      },
    });
    await PhotoshopCmykBridge.commitHalftoneLayer(
      zeroCyanEnv.app,
      zeroCyanEnv.core,
      zeroCyanEnv.action,
      zeroCyanEnv.imaging,
      { meshTpi: 230, ruleOfN: 5.0 }
    );
    expect(
      zeroCyanEnv.putPixelsBuffers[zeroCyanEnv.appliedChannels.cyan].buffer.every((v) => v === 255)
    ).toBe(true);
    expect(
      zeroCyanEnv.putPixelsBuffers[zeroCyanEnv.appliedChannels.black].buffer.every((v) => v === 0)
    ).toBe(true);

    // 2. Fallback when ActionManager `title` is omitted
    const untitledEnv = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      exposeSplitTitles: false,
      cmykInkChannels: {
        C: new Uint8Array(N).fill(20),
        M: new Uint8Array(N).fill(60),
        Y: new Uint8Array(N).fill(140),
        K: new Uint8Array(N).fill(220),
      },
    });
    const fallbackRead = await PhotoshopCmykBridge.readFullCmykChannels(untitledEnv.app, {
      core: untitledEnv.core,
      action: untitledEnv.action,
      imaging: untitledEnv.imaging,
    });
    expect(fallbackRead.channels.C[0]).toBe(20);
    expect(fallbackRead.channels.K[0]).toBe(220);
  });

  it('marks original underlying layer(s) not visible on commit and re-enables them on temp duplicate during subsequent rereads', async () => {
    const W = 24;
    const H = 24;
    const N = W * H;
    const env = createMockPhotoshopEnv({
      width: W,
      height: H,
      resolution: 600,
      cmykInkChannels: {
        C: new Uint8Array(N).fill(45),
        M: new Uint8Array(N).fill(120),
        Y: new Uint8Array(N).fill(200),
        K: new Uint8Array(N).fill(255),
      },
    });

    expect(env.origDoc.layers[0].visible).toBe(true);

    // Run 1: commits Benday Halftone layer and hides underlying Artwork layer on origDoc
    await PhotoshopCmykBridge.commitHalftoneLayer(
      env.app,
      env.core,
      env.action,
      env.imaging,
      { meshTpi: 230, ruleOfN: 5.0 }
    );
    expect(env.origDoc.layers.length).toBe(2);
    expect(env.origDoc.layers[0].name).toMatch(/^Benday Halftone/);
    expect(env.origDoc.layers[0].visible).toBe(true);
    expect(env.origDoc.layers[1].name).toBe('Artwork');
    expect(env.origDoc.layers[1].visible).toBe(false);

    // Run 2 reread: hides Benday Halftone on temp duplicate AND re-enables hidden Artwork on temp duplicate
    // before flattenImage (while leaving origDoc.layers[1].visible === false untouched!)
    const reread = await PhotoshopCmykBridge.readFullCmykChannels(env.app, {
      core: env.core,
      action: env.action,
      imaging: env.imaging,
    });
    expect(reread.channels.C[0]).toBe(45);
    expect(reread.channels.M[0]).toBe(120);
    expect(reread.channels.Y[0]).toBe(200);
    expect(reread.channels.K[0]).toBe(255);
    expect(env.origDoc.layers[1].visible).toBe(false);
  });

  it('enforces single-layer mandate (ERR_MULTI_LAYER), Already-Halftoned layer guard (ERR_ALREADY_HALFTONED), and flattened Benday XMP/binary guard', async () => {
    // 1. Document already containing a Benday Halftone* layer -> ERR_ALREADY_HALFTONED
    const alreadyHalftonedEnv = createMockPhotoshopEnv({
      width: 32,
      height: 32,
      priorHalftoneLayer: true,
    });
    const resPrior = PhotoshopCmykBridge.validateDocument(alreadyHalftonedEnv.app);
    expect(resPrior.ok).toBe(false);
    expect(resPrior.code).toBe('ERR_ALREADY_HALFTONED');
    expect(resPrior.title).toBe('Already Halftoned');

    // 2. Multi-layer CMYK document without Benday layer -> ERR_MULTI_LAYER ("Flatten First")
    const multiLayerEnv = createMockPhotoshopEnv({ width: 32, height: 32 });
    multiLayerEnv.origDoc.layers.push({ id: 999, name: 'Background Copy', visible: true });
    const resMulti = PhotoshopCmykBridge.validateDocument(multiLayerEnv.app);
    expect(resMulti.ok).toBe(false);
    expect(resMulti.code).toBe('ERR_MULTI_LAYER');
    expect(resMulti.title).toBe('Flatten First');
    expect(resMulti.message).toContain('Current layers: 2');
    expect(resMulti.message).toContain('Layer → Flatten Image');

    // 3. Flattened Benday document detection (`queryDocumentXmp` + `isFlattenedBendayDocument`)
    const flatEnv = createMockPhotoshopEnv({ width: 32, height: 32, resolution: 600 });
    await PhotoshopCmykBridge.commitHalftoneLayer(
      flatEnv.app,
      flatEnv.core,
      flatEnv.action,
      flatEnv.imaging,
      { meshTpi: 230, ruleOfN: 5.0 }
    );
    const rawXmp = await PhotoshopCmykBridge.queryDocumentXmp(flatEnv.action);
    expect(rawXmp).toContain('<!-- BENDAY:BEGIN -->');

    const binaryChannels = {
      C: new Uint8Array(1024).fill(0),
      M: new Uint8Array(1024).map((_, i) => (i % 3 === 0 ? 255 : 0)),
      Y: new Uint8Array(1024).fill(0),
      K: new Uint8Array(1024).map((_, i) => (i % 2 === 0 ? 255 : 0)),
    };
    const contToneChannels = {
      C: new Uint8Array(1024).fill(128),
      M: new Uint8Array(1024).fill(90),
      Y: new Uint8Array(1024).fill(45),
      K: new Uint8Array(1024).fill(20),
    };
    const blankWhiteChannels = {
      C: new Uint8Array(1024).fill(0),
      M: new Uint8Array(1024).fill(0),
      Y: new Uint8Array(1024).fill(0),
      K: new Uint8Array(1024).fill(0),
    };

    expect(PhotoshopCmykBridge.isFlattenedBendayDocument(rawXmp, binaryChannels)).toBe(true);
    expect(PhotoshopCmykBridge.isFlattenedBendayDocument(rawXmp, contToneChannels)).toBe(false);
    expect(PhotoshopCmykBridge.isFlattenedBendayDocument(rawXmp, blankWhiteChannels)).toBe(false);
    expect(PhotoshopCmykBridge.isFlattenedBendayDocument('<x:xmpmeta/>', binaryChannels)).toBe(
      false
    );
  });
});

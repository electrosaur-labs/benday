import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { runCli } from '../src/cli.js';
import { encodeTiff, decodeTiff, encodePgm, decodePgm } from '../src/tiffCodec.js';

const tempDirs = [];
function makeTempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'benday-cli-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('benday-cli & Baseline TIFF / PGM Codec', () => {
  it('round-trips 4-channel CMYK TIFF and 1-channel PGM losslessly with DPI preserved', () => {
    const W = 24;
    const H = 16;
    const N = W * H;
    const C = new Uint8Array(N).map((_, i) => i % 256);
    const M = new Uint8Array(N).map((_, i) => (i * 3) % 256);
    const Y = new Uint8Array(N).map((_, i) => (i * 7) % 256);
    const K = new Uint8Array(N).map((_, i) => (i * 11) % 256);

    const tiffBuf = encodeTiff({ width: W, height: H, dpi: 600, channels: { C, M, Y, K } });
    const decoded = decodeTiff(tiffBuf);
    expect(decoded.width).toBe(W);
    expect(decoded.height).toBe(H);
    expect(decoded.dpi).toBeCloseTo(600, 3);
    expect(Array.from(decoded.channels.C)).toEqual(Array.from(C));
    expect(Array.from(decoded.channels.K)).toEqual(Array.from(K));

    const pgmBuf = encodePgm(C, W, H);
    const decPgm = decodePgm(pgmBuf);
    expect(decPgm.width).toBe(W);
    expect(decPgm.height).toBe(H);
    expect(Array.from(decPgm.gray)).toEqual(Array.from(C));
  });

  it('encodes 1-channel Grayscale TIFF with standard BlackIsZero (0=black ink, 255=white paper) and decodes WhiteIsZero & Deflate+ExtraSamples', () => {
    const W = 8;
    const H = 4;
    const N = W * H;
    const ink = new Uint8Array(N);
    ink[0] = 255; // 100% black ink -> must write raw TIFF byte 0 under BlackIsZero
    ink[1] = 0;   // 0% white paper -> must write raw TIFF byte 255 under BlackIsZero
    ink[2] = 100; // 100/255 ink -> must write raw TIFF byte 155

    const grayTiff = encodeTiff({ width: W, height: H, dpi: 600, gray: ink });
    // Pixel strip is the final N bytes of the encoded Baseline TIFF
    const rawStripOff = grayTiff.length - N;
    expect(grayTiff[rawStripOff + 0]).toBe(0);
    expect(grayTiff[rawStripOff + 1]).toBe(255);
    expect(grayTiff[rawStripOff + 2]).toBe(155);

    const decBlackIsZero = decodeTiff(grayTiff);
    expect(decBlackIsZero.photometric).toBe(1);
    expect(Array.from(decBlackIsZero.gray)).toEqual(Array.from(ink));

    // Patch PhotometricInterpretation tag (262) in IFD to 0 (WhiteIsZero) and verify raw[i] = ink[i] polarity
    const whiteIsZeroTiff = Buffer.from(grayTiff);
    const numEntries = whiteIsZeroTiff.readUInt16LE(8);
    for (let i = 0; i < numEntries; i++) {
      const pos = 10 + i * 12;
      if (whiteIsZeroTiff.readUInt16LE(pos) === 262) {
        whiteIsZeroTiff.writeUInt16LE(0, pos + 8);
      }
    }
    ink.forEach((v, idx) => {
      whiteIsZeroTiff[rawStripOff + idx] = v;
    });
    const decWhiteIsZero = decodeTiff(whiteIsZeroTiff);
    expect(decWhiteIsZero.photometric).toBe(0);
    expect(Array.from(decWhiteIsZero.gray)).toEqual(Array.from(ink));

    // Build a synthetic 6-channel (CMYK + 2 ExtraSamples) Deflate-compressed TIFF
    const spp = 6;
    const raw6 = Buffer.alloc(N * spp);
    for (let i = 0; i < N; i++) {
      raw6[i * spp + 0] = 0;   // C = 0
      raw6[i * spp + 1] = 200; // M = 200
      raw6[i * spp + 2] = 100; // Y = 100
      raw6[i * spp + 3] = 0;   // K = 0
      raw6[i * spp + 4] = 128; // Extra alpha 1
      raw6[i * spp + 5] = 255; // Extra alpha 2
    }
    const deflated = zlib.deflateSync(raw6);
    const entryCount = 9;
    const ifdSize = 2 + entryCount * 12 + 4;
    const bpsOff = 8 + ifdSize;
    const stripOff = bpsOff + 12;
    const defTiff = Buffer.alloc(stripOff + deflated.length);
    defTiff.write('II', 0, 'ascii');
    defTiff.writeUInt16LE(42, 2);
    defTiff.writeUInt32LE(8, 4);
    defTiff.writeUInt16LE(entryCount, 8);
    const tags = [
      [256, 4, 1, W],
      [257, 4, 1, H],
      [258, 3, spp, bpsOff],
      [259, 3, 1, 8], // Compression = 8 (Deflate)
      [262, 3, 1, 5], // Photometric = 5 (Separated CMYK)
      [273, 4, 1, stripOff],
      [277, 3, 1, spp],
      [279, 4, 1, deflated.length],
      [284, 3, 1, 1],
    ];
    tags.forEach(([tag, type, count, val], idx) => {
      const p = 10 + idx * 12;
      defTiff.writeUInt16LE(tag, p);
      defTiff.writeUInt16LE(type, p + 2);
      defTiff.writeUInt32LE(count, p + 4);
      if (type === 3 && count === 1) defTiff.writeUInt16LE(val, p + 8);
      else defTiff.writeUInt32LE(val, p + 8);
    });
    for (let s = 0; s < spp; s++) defTiff.writeUInt16LE(8, bpsOff + s * 2);
    deflated.copy(defTiff, stripOff);

    const dec6 = decodeTiff(defTiff);
    expect(dec6.samplesPerPixel).toBe(6);
    expect(dec6.extraSamples).toBe(2);
    expect(dec6.channels.C.every((v) => v === 0)).toBe(true);
    expect(dec6.channels.M.every((v) => v === 200)).toBe(true);
    expect(dec6.channels.Y.every((v) => v === 100)).toBe(true);
    expect(dec6.channels.K.every((v) => v === 0)).toBe(true);
  });

  it('decodes 16-bit Big-Endian Planar TIFFs, Tiled odd-dimension TIFFs, and Anisotropic CM DPI TIFFs', () => {
    // 1. 16-bit Big-Endian ('MM'), PlanarConfiguration = 2, Deflate
    const W = 7;
    const H = 5;
    const N = W * H;
    const planeVals16 = [0, 32896, 65535, 12850]; // -> [0, 128, 255, 50] in 8-bit
    const compPlanes = planeVals16.map((val16) => {
      const b = Buffer.alloc(N * 2);
      for (let i = 0; i < N; i++) b.writeUInt16BE(val16, i * 2);
      return zlib.deflateSync(b);
    });

    const entryCount = 12;
    const ifdSize = 2 + entryCount * 12 + 4;
    const bpsOff = 8 + ifdSize;
    const stripOffsPos = bpsOff + 8;
    const stripCountsPos = stripOffsPos + 16;
    const xResPos = stripCountsPos + 16;
    const yResPos = xResPos + 8;
    let dataCursor = yResPos + 8;

    const totalLen = dataCursor + compPlanes.reduce((a, b) => a + b.length, 0);
    const beTiff = Buffer.alloc(totalLen);
    beTiff.write('MM', 0, 'ascii');
    beTiff.writeUInt16BE(42, 2);
    beTiff.writeUInt32BE(8, 4);
    beTiff.writeUInt16BE(entryCount, 8);

    const writeBeEntry = (idx, tag, type, count, valOrOff) => {
      const p = 10 + idx * 12;
      beTiff.writeUInt16BE(tag, p);
      beTiff.writeUInt16BE(type, p + 2);
      beTiff.writeUInt32BE(count, p + 4);
      if (type === 3 && count === 1) {
        beTiff.writeUInt16BE(valOrOff, p + 8);
      } else {
        beTiff.writeUInt32BE(valOrOff, p + 8);
      }
    };

    for (let c = 0; c < 4; c++) {
      beTiff.writeUInt16BE(16, bpsOff + c * 2);
      beTiff.writeUInt32BE(dataCursor, stripOffsPos + c * 4);
      beTiff.writeUInt32BE(compPlanes[c].length, stripCountsPos + c * 4);
      compPlanes[c].copy(beTiff, dataCursor);
      dataCursor += compPlanes[c].length;
    }
    // 600x1200 DPI stored as pixels-per-centimeter (ResolutionUnit = 3)
    beTiff.writeUInt32BE(60000, xResPos);
    beTiff.writeUInt32BE(254, xResPos + 4);
    beTiff.writeUInt32BE(120000, yResPos);
    beTiff.writeUInt32BE(254, yResPos + 4);

    const beTags = [
      [256, 4, 1, W],
      [257, 4, 1, H],
      [258, 3, 4, bpsOff],
      [259, 3, 1, 8],
      [262, 3, 1, 5],
      [273, 4, 4, stripOffsPos],
      [277, 3, 1, 4],
      [278, 4, 1, H],
      [279, 4, 4, stripCountsPos],
      [282, 5, 1, xResPos],
      [283, 5, 1, yResPos],
      [284, 3, 1, 2], // PlanarConfiguration = 2
    ];
    // Replace entryCount with 13 to include ResolutionUnit = 3
    const beTiffWithUnit = Buffer.alloc(totalLen + 12);
    beTiff.copy(beTiffWithUnit, 0, 0, 10);
    beTiffWithUnit.writeUInt16BE(13, 8);
    // Shift offsets by +12 bytes for the 13th IFD entry
    const shift = 12;
    beTiff.copy(beTiffWithUnit, 10 + 13 * 12 + 4, 10 + 12 * 12 + 4);
    for (let c = 0; c < 4; c++) {
      const oldOff = beTiff.readUInt32BE(stripOffsPos + c * 4);
      beTiffWithUnit.writeUInt32BE(oldOff + shift, stripOffsPos + shift + c * 4);
    }
    const entries13 = [
      ...beTags.map(([t, ty, cnt, v]) => [
        t,
        ty,
        cnt,
        [258, 273, 279, 282, 283].includes(t) ? v + shift : v,
      ]),
      [296, 3, 1, 3], // ResolutionUnit = 3 (CM)
    ];
    entries13.forEach(([t, ty, cnt, v], idx) => {
      const p = 10 + idx * 12;
      beTiffWithUnit.writeUInt16BE(t, p);
      beTiffWithUnit.writeUInt16BE(ty, p + 2);
      beTiffWithUnit.writeUInt32BE(cnt, p + 4);
      if (ty === 3 && cnt === 1) beTiffWithUnit.writeUInt16BE(v, p + 8);
      else beTiffWithUnit.writeUInt32BE(v, p + 8);
    });

    const decBe = decodeTiff(beTiffWithUnit);
    expect(decBe.bitsPerSample).toBe(16);
    expect(decBe.planarConfig).toBe(2);
    expect(decBe.dpiX).toBe(600);
    expect(decBe.dpiY).toBe(1200);
    expect(decBe.channels.C.every((v) => v === 0)).toBe(true);
    expect(decBe.channels.M.every((v) => v === 128)).toBe(true);
    expect(decBe.channels.Y.every((v) => v === 255)).toBe(true);
    expect(decBe.channels.K.every((v) => v === 50)).toBe(true);

    // 2. Tiled TIFF (16x16 tiles on odd 25x19 canvas)
    const TW = 16;
    const TL = 16;
    const CW = 25;
    const CH = 19;
    const tiles = [];
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const tb = Buffer.alloc(TW * TL * 4, 222); // Pad overhang with 222 to catch clipping bugs
        for (let ry = 0; ry < TL; ry++) {
          const gy = ty * TL + ry;
          for (let rx = 0; rx < TW; rx++) {
            const gx = tx * TW + rx;
            if (gx < CW && gy < CH) {
              const o = (ry * TW + rx) * 4;
              tb[o + 0] = gx;
              tb[o + 1] = gy;
              tb[o + 2] = 0;
              tb[o + 3] = gx === CW - 1 && gy === CH - 1 ? 255 : 0;
            }
          }
        }
        tiles.push(zlib.deflateSync(tb));
      }
    }
    const tEntries = 11;
    const tIfdEnd = 8 + 2 + tEntries * 12 + 4;
    const tBps = tIfdEnd;
    const tOffs = tBps + 8;
    const tCnts = tOffs + 16;
    let tCur = tCnts + 16;
    const tTotal = tCur + tiles.reduce((a, b) => a + b.length, 0);
    const tileBuf = Buffer.alloc(tTotal);
    tileBuf.write('II', 0, 'ascii');
    tileBuf.writeUInt16LE(42, 2);
    tileBuf.writeUInt32LE(8, 4);
    tileBuf.writeUInt16LE(tEntries, 8);
    for (let c = 0; c < 4; c++) tileBuf.writeUInt16LE(8, tBps + c * 2);
    tiles.forEach((tb, idx) => {
      tileBuf.writeUInt32LE(tCur, tOffs + idx * 4);
      tileBuf.writeUInt32LE(tb.length, tCnts + idx * 4);
      tb.copy(tileBuf, tCur);
      tCur += tb.length;
    });
    const tileTagList = [
      [256, 4, 1, CW],
      [257, 4, 1, CH],
      [258, 3, 4, tBps],
      [259, 3, 1, 8],
      [262, 3, 1, 5],
      [277, 3, 1, 4],
      [284, 3, 1, 1],
      [322, 3, 1, TW],
      [323, 3, 1, TL],
      [324, 4, 4, tOffs],
      [325, 4, 4, tCnts],
    ];
    tileTagList.forEach(([t, ty, cnt, v], idx) => {
      const p = 10 + idx * 12;
      tileBuf.writeUInt16LE(t, p);
      tileBuf.writeUInt16LE(ty, p + 2);
      tileBuf.writeUInt32LE(cnt, p + 4);
      if (ty === 3 && cnt === 1) tileBuf.writeUInt16LE(v, p + 8);
      else tileBuf.writeUInt32LE(v, p + 8);
    });

    const decTiled = decodeTiff(tileBuf);
    expect(decTiled.isTiled).toBe(true);
    expect(decTiled.width).toBe(CW);
    expect(decTiled.height).toBe(CH);
    expect(decTiled.channels.C[CH * CW - 1]).toBe(CW - 1);
    expect(decTiled.channels.M[CH * CW - 1]).toBe(CH - 1);
    expect(decTiled.channels.K[CH * CW - 1]).toBe(255);
  });

  it('defaults to press-room Rule of N = 5.0 (46.0 LPI on 230-48) and outputs calibrated mesh & rosette report', () => {
    const defOut = [];
    const defRes = runCli(
      ['spec', '--mesh', '230', '--dpi', '600', '--json'],
      { stdout: (s) => defOut.push(s), stderr: () => {} }
    );
    expect(defRes.exitCode).toBe(0);
    const defParsed = JSON.parse(defOut.join('\n'));
    expect(defParsed.meshSpec.ruleOfN).toBe(5.0);
    expect(defParsed.meshSpec.lpiActive).toBeCloseTo(46.0, 2);

    const out = [];
    const res = runCli(
      ['spec', '--mesh', '355', '--thread', '40', '--n', '5.0', '--dpi', '600', '--mesh-angle', '18', '--json'],
      { stdout: (s) => out.push(s), stderr: () => {} }
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.meshSpec.openAreaScale).toBeCloseTo(1.282, 2);
    expect(parsed.angles).toEqual({ C: 33, M: 3, Y: 78, K: 63 });
    expect(parsed.moireReport.safe).toBe(true);
  });

  it('halftones synthetic CMYK ramp & split-screens via CLI and passes `benday verify` with exit code 0', () => {
    const dir = makeTempDir();
    const outTiff = path.join(dir, 'halftone_cmyk.tif');
    const splitDir = path.join(dir, 'screens');

    const logs = [];
    const htRes = runCli(
      [
        'halftone',
        'synthetic:ramp',
        '--width',
        '140',
        '--height',
        '100',
        '-o',
        outTiff,
        '--mesh',
        '230',
        '--n',
        '4.0',
        '--dpi',
        '600',
        '--mesh-angle',
        '18',
        '--split-screens',
        splitDir,
        '--json',
      ],
      { stdout: (s) => logs.push(s), stderr: () => {} }
    );
    expect(htRes.exitCode).toBe(0);
    expect(fs.existsSync(outTiff)).toBe(true);
    expect(fs.existsSync(path.join(splitDir, 'halftone_cmyk_C.tif'))).toBe(true);

    // Verify full 4-channel CMYK TIFF via `benday verify --src`
    const verLogs = [];
    const verRes = runCli(
      [
        'verify',
        outTiff,
        '--src',
        'synthetic:ramp',
        '--width',
        '140',
        '--height',
        '100',
        '--mesh',
        '230',
        '--n',
        '4.0',
        '--dpi',
        '600',
        '--json',
      ],
      { stdout: (s) => verLogs.push(s), stderr: () => {} }
    );
    expect(verRes.exitCode).toBe(0);
    const fullVerReport = JSON.parse(verLogs.join('\n'));
    expect(fullVerReport.ok).toBe(true);
    expect(fullVerReport.channels.C.ok).toBe(true);
    expect(fullVerReport.channels.M.ok).toBe(true);
    expect(fullVerReport.channels.Y.ok).toBe(true);
    expect(fullVerReport.channels.K.ok).toBe(true);

    // Also verify single-screen split TIFF round-trip via `benday verify`
    const verCLogs = [];
    const verC = runCli(
      [
        'verify',
        path.join(splitDir, 'halftone_cmyk_C.tif'),
        '--mesh',
        '230',
        '--n',
        '4.0',
        '--dpi',
        '600',
        '--json',
      ],
      { stdout: (s) => verCLogs.push(s), stderr: () => {} }
    );
    expect(verC.exitCode).toBe(0);
    expect(JSON.parse(verCLogs.join('\n')).ok).toBe(true);
  });

  it('exits non-zero (`exitCode === 1`) when `benday verify` audits a corrupted sub-mesh screen', () => {
    const dir = makeTempDir();
    const badPath = path.join(dir, 'corrupted_screen.pgm');
    const badBuf = new Uint8Array(64 * 64);
    badBuf[20 * 64 + 20] = 255; // illegal 1px dot
    fs.writeFileSync(badPath, encodePgm(badBuf, 64, 64));

    const logs = [];
    const res = runCli(
      ['verify', badPath, '--mesh', '230', '--n', '4.0', '--dpi', '600', '--json'],
      { stdout: (s) => logs.push(s), stderr: () => {} }
    );
    expect(res.exitCode).toBe(1);
    const report = JSON.parse(logs.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.minDotViolations).toBe(1);
  });
});

'use strict';

const zlib = require('zlib');

/**
 * Zero-external-dependency Baseline, Tiled, Planar, 8/16-bit & Deflate TIFF + PGM (P5) codec.
 *
 * Supports:
 *   - 1-channel Grayscale TIFF:
 *       * PhotometricInterpretation = 1 (BlackIsZero): 0 = black (100% ink), 255/65535 = white (0% paper)
 *       * PhotometricInterpretation = 0 (WhiteIsZero): 0 = white (0% paper), 255/65535 = black (100% ink)
 *   - >=4-channel Separated CMYK (+ optional ExtraSamples) TIFF:
 *       * PhotometricInterpretation = 5, SamplesPerPixel >= 4, InkSet = 1 (0 = 0% ink, max = 100% ink)
 *   - Byte order: Little-Endian ('II') and Big-Endian ('MM')
 *   - BitsPerSample: 8-bit and 16-bit unsigned (16-bit scaled via Math.round(u16 / 257))
 *   - PlanarConfiguration: 1 (chunky/interleaved) and 2 (separate planes)
 *   - Organization: Stripped (Tags 273/278/279) and Tiled (Tags 322/323/324/325, clipping padded edge tiles)
 *   - Compression: 1 (Uncompressed) on read/write; 8 / 32946 (Deflate) + Predictor 1 or 2 on read
 *   - Isotropic & Anisotropic DPI metadata via XResolution / YResolution / ResolutionUnit (Inch=2, CM=3)
 *   - Binary PGM (P5) 1-channel raw ink buffers
 */

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_X_RESOLUTION = 282;
const TAG_Y_RESOLUTION = 283;
const TAG_PLANAR_CONFIG = 284;
const TAG_RESOLUTION_UNIT = 296;
const TAG_PREDICTOR = 317;
const TAG_TILE_WIDTH = 322;
const TAG_TILE_LENGTH = 323;
const TAG_TILE_OFFSETS = 324;
const TAG_TILE_BYTE_COUNTS = 325;
const TAG_INK_SET = 332;

/**
 * Encode 1-channel Grayscale or 4-channel Separated CMYK into an uncompressed Baseline TIFF Buffer.
 *
 * @param {object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {number} [image.dpi=600]
 * @param {number} [image.dpiX]
 * @param {number} [image.dpiY]
 * @param {Uint8Array} [image.gray] - Single-channel ink buffer (0 = 0% paper, 255 = 100% ink)
 * @param {{ C: Uint8Array, M: Uint8Array, Y: Uint8Array, K: Uint8Array }} [image.channels] - 4-channel CMYK
 * @returns {Buffer}
 */
function encodeTiff(image) {
  const { width, height, dpi = 600, gray, channels } = image;
  const dpiX = image.dpiX == null ? dpi : image.dpiX;
  const dpiY = image.dpiY == null ? dpi : image.dpiY;
  const isCmyk = Boolean(channels);
  const samplesPerPixel = isCmyk ? 4 : 1;
  const pixelCount = width * height;
  const pixelBytesLen = pixelCount * samplesPerPixel;

  const entries = [];
  const extraPayloads = [];
  const entryCount = isCmyk ? 14 : 13;
  const ifdOffset = 8;
  const extraStart = ifdOffset + 2 + entryCount * 12 + 4;
  let currentExtraOffset = extraStart;

  const allocExtra = (buf) => {
    const off = currentExtraOffset;
    extraPayloads.push(buf);
    currentExtraOffset += buf.length;
    return off;
  };

  let bpsValueOrOffset;
  if (isCmyk) {
    const bpsBuf = Buffer.alloc(8);
    bpsBuf.writeUInt16LE(8, 0);
    bpsBuf.writeUInt16LE(8, 2);
    bpsBuf.writeUInt16LE(8, 4);
    bpsBuf.writeUInt16LE(8, 6);
    bpsValueOrOffset = allocExtra(bpsBuf);
  } else {
    bpsValueOrOffset = 8;
  }

  const xResBuf = Buffer.alloc(8);
  xResBuf.writeUInt32LE(Math.round(dpiX * 1000), 0);
  xResBuf.writeUInt32LE(1000, 4);
  const xResOffset = allocExtra(xResBuf);

  const yResBuf = Buffer.alloc(8);
  yResBuf.writeUInt32LE(Math.round(dpiY * 1000), 0);
  yResBuf.writeUInt32LE(1000, 4);
  const yResOffset = allocExtra(yResBuf);

  const pixelDataOffset = currentExtraOffset;

  entries.push({ tag: TAG_IMAGE_WIDTH, type: TYPE_LONG, count: 1, val: width });
  entries.push({ tag: TAG_IMAGE_LENGTH, type: TYPE_LONG, count: 1, val: height });
  entries.push({
    tag: TAG_BITS_PER_SAMPLE,
    type: TYPE_SHORT,
    count: samplesPerPixel,
    val: bpsValueOrOffset,
    inlineShort: !isCmyk,
  });
  entries.push({ tag: TAG_COMPRESSION, type: TYPE_SHORT, count: 1, val: 1, inlineShort: true });
  entries.push({
    tag: TAG_PHOTOMETRIC,
    type: TYPE_SHORT,
    count: 1,
    val: isCmyk ? 5 : 1,
    inlineShort: true,
  });
  entries.push({ tag: TAG_STRIP_OFFSETS, type: TYPE_LONG, count: 1, val: pixelDataOffset });
  entries.push({
    tag: TAG_SAMPLES_PER_PIXEL,
    type: TYPE_SHORT,
    count: 1,
    val: samplesPerPixel,
    inlineShort: true,
  });
  entries.push({ tag: TAG_ROWS_PER_STRIP, type: TYPE_LONG, count: 1, val: height });
  entries.push({ tag: TAG_STRIP_BYTE_COUNTS, type: TYPE_LONG, count: 1, val: pixelBytesLen });
  entries.push({ tag: TAG_X_RESOLUTION, type: TYPE_RATIONAL, count: 1, val: xResOffset });
  entries.push({ tag: TAG_Y_RESOLUTION, type: TYPE_RATIONAL, count: 1, val: yResOffset });
  entries.push({ tag: TAG_PLANAR_CONFIG, type: TYPE_SHORT, count: 1, val: 1, inlineShort: true });
  entries.push({
    tag: TAG_RESOLUTION_UNIT,
    type: TYPE_SHORT,
    count: 1,
    val: 2,
    inlineShort: true,
  });
  if (isCmyk) {
    entries.push({ tag: TAG_INK_SET, type: TYPE_SHORT, count: 1, val: 1, inlineShort: true });
  }

  entries.sort((a, b) => a.tag - b.tag);

  const actualIfdSize = 2 + entries.length * 12 + 4;
  const shift = 8 + actualIfdSize - extraStart;
  const finalPixelOffset = pixelDataOffset + shift;

  const totalSize = finalPixelOffset + pixelBytesLen;
  const out = Buffer.alloc(totalSize);

  out[0] = 0x49;
  out[1] = 0x49;
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);

  out.writeUInt16LE(entries.length, 8);
  let pos = 10;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    out.writeUInt16LE(e.tag, pos);
    out.writeUInt16LE(e.type, pos + 2);
    out.writeUInt32LE(e.count, pos + 4);
    let valToWrite = e.val;
    if (
      !e.inlineShort &&
      (e.tag === TAG_BITS_PER_SAMPLE ||
        e.tag === TAG_X_RESOLUTION ||
        e.tag === TAG_Y_RESOLUTION)
    ) {
      valToWrite += shift;
    } else if (e.tag === TAG_STRIP_OFFSETS) {
      valToWrite = finalPixelOffset;
    }
    if (e.inlineShort) {
      out.writeUInt16LE(valToWrite, pos + 8);
      out.writeUInt16LE(0, pos + 10);
    } else {
      out.writeUInt32LE(valToWrite, pos + 8);
    }
    pos += 12;
  }
  out.writeUInt32LE(0, pos);
  pos += 4;

  for (let i = 0; i < extraPayloads.length; i++) {
    extraPayloads[i].copy(out, pos);
    pos += extraPayloads[i].length;
  }

  if (isCmyk) {
    const { C, M, Y, K } = channels;
    let pOut = finalPixelOffset;
    for (let i = 0; i < pixelCount; i++) {
      out[pOut++] = C[i];
      out[pOut++] = M[i];
      out[pOut++] = Y[i];
      out[pOut++] = K[i];
    }
  } else {
    // BlackIsZero (PhotometricInterpretation = 1): 0 = black (100% ink), 255 = white (0% paper)
    for (let i = 0; i < pixelCount; i++) {
      out[finalPixelOffset + i] = 255 - gray[i];
    }
  }

  return out;
}

function inflateChunk(slice) {
  try {
    return zlib.inflateSync(slice);
  } catch (_) {
    return zlib.inflateRawSync(slice);
  }
}

/**
 * Decode an 8-bit or 16-bit TIFF (1-channel Grayscale or >=4-channel Separated CMYK; LE/BE;
 * Stripped/Tiled; Chunky/Planar; Uncompressed/Deflate; Predictor 1/2).
 */
function decodeTiff(buf) {
  if (!buf || buf.length < 16) {
    throw new Error('Invalid TIFF buffer (too short)');
  }
  const endian = buf.toString('ascii', 0, 2);
  const le = endian === 'II';
  if (!le && endian !== 'MM') {
    throw new Error(`Unsupported TIFF byte order "${endian}"`);
  }

  const u16 = (off) => (le ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const u32 = (off) => (le ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const i32 = (off) => (le ? buf.readInt32LE(off) : buf.readInt32BE(off));

  const magic = u16(2);
  if (magic !== 42) {
    throw new Error(`Invalid TIFF magic ${magic}`);
  }

  const ifdOff = u32(4);
  const numEntries = u16(ifdOff);

  const typeByteSize = (t) => {
    if (t === 1 || t === 2 || t === 6 || t === 7) return 1;
    if (t === 3 || t === 8) return 2;
    if (t === 4 || t === 9 || t === 11) return 4;
    if (t === 5 || t === 10 || t === 12) return 8;
    return 1;
  };

  const readValues = (type, count, valOffField) => {
    const elemSize = typeByteSize(type);
    const totalBytes = elemSize * count;
    const dataPos = totalBytes <= 4 ? valOffField : u32(valOffField);
    const out = [];
    for (let i = 0; i < count; i++) {
      const p = dataPos + i * elemSize;
      if (type === 1 || type === 2 || type === 7) out.push(buf[p]);
      else if (type === 3) out.push(u16(p));
      else if (type === 4) out.push(u32(p));
      else if (type === 9) out.push(i32(p));
      else if (type === 5) {
        const num = u32(p);
        const den = u32(p + 4);
        out.push(den === 0 ? 0 : num / den);
      } else if (type === 10) {
        const num = i32(p);
        const den = i32(p + 4);
        out.push(den === 0 ? 0 : num / den);
      }
    }
    return out;
  };

  let width = 0;
  let height = 0;
  let compression = 1;
  let photometric = 1;
  let samplesPerPixel = 1;
  let rowsPerStrip = 0;
  let stripOffsets = [];
  let stripByteCounts = [];
  let tileWidth = 0;
  let tileLength = 0;
  let tileOffsets = [];
  let tileByteCounts = [];
  let xRes = 0;
  let yRes = 0;
  let resUnit = 2;
  let bitsPerSample = [8];
  let planarConfig = 1;
  let predictor = 1;

  for (let i = 0; i < numEntries; i++) {
    const entryPos = ifdOff + 2 + i * 12;
    const tag = u16(entryPos);
    const type = u16(entryPos + 2);
    const count = u32(entryPos + 4);
    const vals = readValues(type, count, entryPos + 8);

    switch (tag) {
      case TAG_IMAGE_WIDTH:
        width = vals[0];
        break;
      case TAG_IMAGE_LENGTH:
        height = vals[0];
        break;
      case TAG_BITS_PER_SAMPLE:
        bitsPerSample = vals;
        break;
      case TAG_COMPRESSION:
        compression = vals[0];
        break;
      case TAG_PHOTOMETRIC:
        photometric = vals[0];
        break;
      case TAG_STRIP_OFFSETS:
        stripOffsets = vals;
        break;
      case TAG_SAMPLES_PER_PIXEL:
        samplesPerPixel = vals[0];
        break;
      case TAG_ROWS_PER_STRIP:
        rowsPerStrip = vals[0];
        break;
      case TAG_STRIP_BYTE_COUNTS:
        stripByteCounts = vals;
        break;
      case TAG_X_RESOLUTION:
        xRes = vals[0];
        break;
      case TAG_Y_RESOLUTION:
        yRes = vals[0];
        break;
      case TAG_PLANAR_CONFIG:
        planarConfig = vals[0];
        break;
      case TAG_RESOLUTION_UNIT:
        resUnit = vals[0];
        break;
      case TAG_PREDICTOR:
        predictor = vals[0];
        break;
      case TAG_TILE_WIDTH:
        tileWidth = vals[0];
        break;
      case TAG_TILE_LENGTH:
        tileLength = vals[0];
        break;
      case TAG_TILE_OFFSETS:
        tileOffsets = vals;
        break;
      case TAG_TILE_BYTE_COUNTS:
        tileByteCounts = vals;
        break;
      default:
        break;
    }
  }

  const isDeflate = compression === 8 || compression === 32946;
  if (compression !== 1 && !isDeflate) {
    throw new Error(
      `Unsupported TIFF Compression=${compression} (Uncompressed=1 or Deflate=8/32946 required)`
    );
  }
  const bps = bitsPerSample[0];
  if (bps !== 8 && bps !== 16) {
    throw new Error(`Unsupported BitsPerSample=${bps} (8-bit or 16-bit required)`);
  }
  if (planarConfig !== 1 && planarConfig !== 2) {
    throw new Error(`Unsupported PlanarConfiguration=${planarConfig} (1 or 2 required)`);
  }
  if (predictor !== 1 && predictor !== 2) {
    throw new Error(`Unsupported TIFF Predictor=${predictor} (1 or 2 required)`);
  }

  const isTiled = tileOffsets.length > 0 && tileWidth > 0 && tileLength > 0;
  if (!isTiled && stripOffsets.length === 0) {
    throw new Error('Invalid TIFF: neither StripOffsets nor TileOffsets found');
  }

  let dpiX = 600;
  let dpiY = 600;
  if (xRes > 0) {
    dpiX = resUnit === 3 ? xRes * 2.54 : xRes;
    dpiY = yRes > 0 ? (resUnit === 3 ? yRes * 2.54 : yRes) : dpiX;
  } else if (yRes > 0) {
    dpiY = resUnit === 3 ? yRes * 2.54 : yRes;
    dpiX = dpiY;
  }
  // Snap sub-millimeter rational rounding noise (e.g. 599.99999 -> 600) when within 1e-3
  if (Math.abs(dpiX - Math.round(dpiX)) < 1e-3) dpiX = Math.round(dpiX);
  if (Math.abs(dpiY - Math.round(dpiY)) < 1e-3) dpiY = Math.round(dpiY);
  const dpi = Math.min(dpiX, dpiY);

  const pixelCount = width * height;
  const isPlanar = planarConfig === 2 && samplesPerPixel > 1;
  const numPlanes = isPlanar ? samplesPerPixel : 1;
  const samplesInChunk = isPlanar ? 1 : samplesPerPixel;

  const decodeChunkTo8Bit = (rawBytes, chunkW, chunkH) => {
    const totalSamples = chunkW * chunkH * samplesInChunk;
    const rowStride = chunkW * samplesInChunk;

    if (bps === 8) {
      const out8 = new Uint8Array(totalSamples);
      out8.set(rawBytes.subarray(0, Math.min(rawBytes.length, totalSamples)));
      if (predictor === 2) {
        for (let r = 0; r < chunkH; r++) {
          const rOff = r * rowStride;
          for (let x = samplesInChunk; x < rowStride; x++) {
            out8[rOff + x] = (out8[rOff + x] + out8[rOff + x - samplesInChunk]) & 0xff;
          }
        }
      }
      return out8;
    }

    // 16-bit unsigned ('II' or 'MM')
    const u16Samples = new Uint16Array(totalSamples);
    const maxReadable = Math.min(totalSamples, rawBytes.length >> 1);
    if (le) {
      for (let k = 0; k < maxReadable; k++) {
        u16Samples[k] = rawBytes[2 * k] | (rawBytes[2 * k + 1] << 8);
      }
    } else {
      for (let k = 0; k < maxReadable; k++) {
        u16Samples[k] = (rawBytes[2 * k] << 8) | rawBytes[2 * k + 1];
      }
    }

    if (predictor === 2) {
      for (let r = 0; r < chunkH; r++) {
        const rOff = r * rowStride;
        for (let x = samplesInChunk; x < rowStride; x++) {
          u16Samples[rOff + x] = (u16Samples[rOff + x] + u16Samples[rOff + x - samplesInChunk]) & 0xffff;
        }
      }
    }

    const out8 = new Uint8Array(totalSamples);
    for (let k = 0; k < totalSamples; k++) {
      // Exact [0..65535] -> [0..255] scaling (u16 / 257)
      out8[k] = Math.round(u16Samples[k] / 257);
    }
    return out8;
  };

  const planes = Array.from({ length: samplesPerPixel }, () => new Uint8Array(pixelCount));

  if (isTiled) {
    const tilesAcross = Math.ceil(width / tileWidth);
    const tilesDown = Math.ceil(height / tileLength);
    const tilesPerPlane = tilesAcross * tilesDown;

    for (let plane = 0; plane < numPlanes; plane++) {
      for (let ty = 0; ty < tilesDown; ty++) {
        const y0 = ty * tileLength;
        const validH = Math.min(tileLength, height - y0);
        for (let tx = 0; tx < tilesAcross; tx++) {
          const x0 = tx * tileWidth;
          const validW = Math.min(tileWidth, width - x0);
          const tIdx = plane * tilesPerPlane + ty * tilesAcross + tx;
          const off = tileOffsets[tIdx];
          const byteCount =
            tileByteCounts[tIdx] != null ? tileByteCounts[tIdx] : buf.length - off;
          const compSlice = buf.subarray(off, off + byteCount);
          const rawBytes = isDeflate ? inflateChunk(compSlice) : compSlice;
          const tile8 = decodeChunkTo8Bit(rawBytes, tileWidth, tileLength);

          if (isPlanar) {
            const dstPlane = planes[plane];
            for (let ry = 0; ry < validH; ry++) {
              const srcOff = ry * tileWidth;
              const dstOff = (y0 + ry) * width + x0;
              dstPlane.set(tile8.subarray(srcOff, srcOff + validW), dstOff);
            }
          } else {
            for (let ry = 0; ry < validH; ry++) {
              const srcRow = ry * tileWidth;
              const dstRow = (y0 + ry) * width + x0;
              for (let rx = 0; rx < validW; rx++) {
                const sBase = (srcRow + rx) * samplesPerPixel;
                const dIdx = dstRow + rx;
                for (let c = 0; c < samplesPerPixel; c++) {
                  planes[c][dIdx] = tile8[sBase + c];
                }
              }
            }
          }
        }
      }
    }
  } else {
    const stripsPerPlane = Math.max(1, Math.floor(stripOffsets.length / numPlanes));
    const effRowsPerStrip = rowsPerStrip > 0 && rowsPerStrip < height ? rowsPerStrip : height;

    for (let plane = 0; plane < numPlanes; plane++) {
      for (let s = 0; s < stripsPerPlane; s++) {
        const y0 = s * effRowsPerStrip;
        const validH = Math.min(effRowsPerStrip, height - y0);
        if (validH <= 0) break;
        const sIdx = plane * stripsPerPlane + s;
        const off = stripOffsets[sIdx];
        const byteCount =
          stripByteCounts[sIdx] != null ? stripByteCounts[sIdx] : buf.length - off;
        const compSlice = buf.subarray(off, off + byteCount);
        const rawBytes = isDeflate ? inflateChunk(compSlice) : compSlice;
        const strip8 = decodeChunkTo8Bit(rawBytes, width, validH);

        if (isPlanar) {
          planes[plane].set(strip8.subarray(0, validH * width), y0 * width);
        } else {
          const basePix = y0 * width;
          const stripPix = validH * width;
          for (let p = 0; p < stripPix; p++) {
            const sBase = p * samplesPerPixel;
            const dIdx = basePix + p;
            for (let c = 0; c < samplesPerPixel; c++) {
              planes[c][dIdx] = strip8[sBase + c];
            }
          }
        }
      }
    }
  }

  if (samplesPerPixel === 1) {
    const gray = new Uint8Array(pixelCount);
    const rawPlane = planes[0];
    if (photometric === 0) {
      // WhiteIsZero: 0 = white (0% paper), 255 = black (100% ink)
      gray.set(rawPlane);
    } else {
      // BlackIsZero (PhotometricInterpretation = 1): 0 = black (100% ink), 255 = white (0% paper)
      for (let i = 0; i < pixelCount; i++) {
        gray[i] = 255 - rawPlane[i];
      }
    }
    return {
      width,
      height,
      samplesPerPixel: 1,
      extraSamples: 0,
      bitsPerSample: bps,
      planarConfig,
      isTiled,
      dpi,
      dpiX,
      dpiY,
      photometric,
      gray,
    };
  }

  if (samplesPerPixel >= 4 && photometric === 5) {
    return {
      width,
      height,
      samplesPerPixel,
      extraSamples: samplesPerPixel - 4,
      bitsPerSample: bps,
      planarConfig,
      isTiled,
      dpi,
      dpiX,
      dpiY,
      photometric,
      channels: {
        C: planes[0],
        M: planes[1],
        Y: planes[2],
        K: planes[3],
      },
    };
  }

  throw new Error(
    `Unsupported TIFF SamplesPerPixel=${samplesPerPixel} / Photometric=${photometric} (expected 1-ch Grayscale or >=4-ch Separated CMYK)`
  );
}

/**
 * Encode 1-channel buffer as binary PGM (P5).
 */
function encodePgm(gray, width, height) {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(gray.buffer, gray.byteOffset, width * height)]);
}

/**
 * Decode binary PGM (P5) into { width, height, samplesPerPixel: 1, gray }.
 */
function decodePgm(buf) {
  let idx = 0;
  const nextToken = () => {
    while (idx < buf.length) {
      const ch = buf[idx];
      if (ch === 35) {
        while (idx < buf.length && buf[idx] !== 10) idx++;
      } else if (ch <= 32) {
        idx++;
      } else {
        break;
      }
    }
    const start = idx;
    while (idx < buf.length && buf[idx] > 32 && buf[idx] !== 35) idx++;
    return buf.toString('ascii', start, idx);
  };

  const magic = nextToken();
  if (magic !== 'P5') throw new Error(`Expected P5 PGM magic, got "${magic}"`);
  const width = Number(nextToken());
  const height = Number(nextToken());
  const maxVal = Number(nextToken());
  if (maxVal !== 255) throw new Error(`Expected PGM maxval 255, got ${maxVal}`);
  idx++; // single whitespace after maxval
  const gray = new Uint8Array(buf.subarray(idx, idx + width * height));
  return {
    width,
    height,
    samplesPerPixel: 1,
    extraSamples: 0,
    dpi: 600,
    dpiX: 600,
    dpiY: 600,
    gray,
  };
}

module.exports = {
  encodeTiff,
  decodeTiff,
  encodePgm,
  decodePgm,
};

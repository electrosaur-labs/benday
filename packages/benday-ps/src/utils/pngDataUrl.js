'use strict';

/**
 * Zero-dependency lossless RGBA -> PNG Data URL encoder for Photoshop UXP.
 *
 * Photoshop UXP does NOT support `<canvas>` `ctx.putImageData()`. All preview and
 * 1:1 Loupe images must be rendered into `<img src="data:image/png;base64,...">`.
 *
 * Uses uncompressed Deflate stored blocks (`BTYPE = 00`, max 65,535 bytes/block) inside
 * a standard RFC 1950 `zlib` (`0x78, 0x01`) + RFC 2083 8-bit RGBA PNG stream (`colorType = 6`,
 * scanline `filter = 0`), with precomputed 256-entry `CRC32_TABLE` and chunked `adler32`
 * (`MOD_ADLER = 65521` modulo every `5552` bytes). Runs in < 5 ms for a 600x900 proxy and
 * < 0.5 ms for a 256x256 Loupe tile.
 */

const BASE64_CHUNK_SIZE = 0x8000; // 32 KB chunks to avoid call stack overflow in String.fromCharCode.apply
const MAX_STORED_BLOCK = 65535;
const MOD_ADLER = 65521;
const ADLER_NMAX = 5552;

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function writeUint32BE(buf, offset, val) {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function crc32Range(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let s1 = 1;
  let s2 = 0;
  let len = buf.length;
  let pos = 0;
  while (len > 0) {
    const k = len < ADLER_NMAX ? len : ADLER_NMAX;
    len -= k;
    const end = pos + k;
    while (pos < end) {
      s1 += buf[pos++];
      s2 += s1;
    }
    s1 %= MOD_ADLER;
    s2 %= MOD_ADLER;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/**
 * Convert a `Uint8Array` (or `ArrayBuffer`) to Base64 using chunked `btoa` (matching
 * `reveal-navigator/src/utils/base64.js`), with `Buffer` fallback in headless Node environments.
 *
 * @param {Uint8Array|Uint8ClampedArray|ArrayBuffer} input
 * @returns {string}
 */
function uint8ToBase64(input) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof Uint8ClampedArray
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);

  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(bytes.length, i + BASE64_CHUNK_SIZE))
      );
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }

  throw new Error('No base64 encoder available in current runtime');
}

/**
 * Encode an 8-bit RGBA buffer (`width * height * 4` bytes) into a raw PNG `Uint8Array`.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
function encodeRgbaToPngBytes(rgba, width, height) {
  const w = width | 0;
  const h = height | 0;
  if (!(w > 0) || !(h > 0)) {
    throw new Error(`Invalid PNG dimensions (${width}x${height})`);
  }
  const expectedBytes = w * h * 4;
  if (!rgba || rgba.length < expectedBytes) {
    throw new Error(
      `RGBA buffer too short (${rgba ? rgba.length : 0} bytes, expected ${expectedBytes})`
    );
  }

  const srcBytes =
    rgba instanceof Uint8Array
      ? rgba
      : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);

  // Build scanline-filtered payload: 1 filter byte (0 = None) + 4*w RGBA bytes per row
  const rowBytes = w * 4;
  const rowStride = 1 + rowBytes;
  const rawLen = h * rowStride;
  const raw = new Uint8Array(rawLen);
  for (let y = 0; y < h; y++) {
    const srcOff = y * rowBytes;
    const dstOff = y * rowStride;
    // raw[dstOff] is already 0 (Filter Type 0: None)
    raw.set(srcBytes.subarray(srcOff, srcOff + rowBytes), dstOff + 1);
  }

  const adler = adler32(raw);
  const numBlocks = Math.max(1, Math.ceil(rawLen / MAX_STORED_BLOCK));
  const idatLen = 2 + numBlocks * 5 + rawLen + 4;

  // Total PNG size: 8 (sig) + 25 (IHDR) + (12 + idatLen) (IDAT) + 12 (IEND)
  const totalPngLen = 57 + idatLen;
  const out = new Uint8Array(totalPngLen);
  let p = 0;

  // 1. PNG Signature (8 bytes)
  out.set(PNG_SIGNATURE, p);
  p += 8;

  // 2. IHDR Chunk (13 data bytes, 25 total bytes)
  writeUint32BE(out, p, 13);
  p += 4;
  const ihdrTypeStart = p;
  out[p++] = 0x49; // 'I'
  out[p++] = 0x48; // 'H'
  out[p++] = 0x44; // 'D'
  out[p++] = 0x52; // 'R'
  writeUint32BE(out, p, w);
  p += 4;
  writeUint32BE(out, p, h);
  p += 4;
  out[p++] = 8; // bit depth = 8
  out[p++] = 6; // color type = 6 (RGBA)
  out[p++] = 0; // compression = 0 (Deflate)
  out[p++] = 0; // filter = 0 (Adaptive)
  out[p++] = 0; // interlace = 0 (None)
  writeUint32BE(out, p, crc32Range(out, ihdrTypeStart, p));
  p += 4;

  // 3. IDAT Chunk (zlib stored Deflate stream)
  writeUint32BE(out, p, idatLen);
  p += 4;
  const idatTypeStart = p;
  out[p++] = 0x49; // 'I'
  out[p++] = 0x44; // 'D'
  out[p++] = 0x41; // 'A'
  out[p++] = 0x54; // 'T'

  // zlib header: CMF = 0x78 (Deflate, 32K window), FLG = 0x01 (FCHECK valid, no dict)
  out[p++] = 0x78;
  out[p++] = 0x01;

  for (let b = 0; b < numBlocks; b++) {
    const blockOff = b * MAX_STORED_BLOCK;
    const blockLen = Math.min(MAX_STORED_BLOCK, rawLen - blockOff);
    const nlen = (~blockLen) & 0xffff;
    out[p++] = b === numBlocks - 1 ? 0x01 : 0x00; // BFINAL | (BTYPE=00 << 1)
    out[p++] = blockLen & 0xff;
    out[p++] = (blockLen >>> 8) & 0xff;
    out[p++] = nlen & 0xff;
    out[p++] = (nlen >>> 8) & 0xff;
    if (blockLen > 0) {
      out.set(raw.subarray(blockOff, blockOff + blockLen), p);
      p += blockLen;
    }
  }

  writeUint32BE(out, p, adler);
  p += 4;
  writeUint32BE(out, p, crc32Range(out, idatTypeStart, p));
  p += 4;

  // 4. IEND Chunk (0 data bytes, 12 total bytes)
  writeUint32BE(out, p, 0);
  p += 4;
  const iendTypeStart = p;
  out[p++] = 0x49; // 'I'
  out[p++] = 0x45; // 'E'
  out[p++] = 0x4e; // 'N'
  out[p++] = 0x44; // 'D'
  writeUint32BE(out, p, crc32Range(out, iendTypeStart, p));

  return out;
}

/**
 * Encode an 8-bit RGBA buffer (`width * height * 4` bytes) into a `data:image/png;base64,...` string.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function encodeRgbaToPngDataUrl(rgba, width, height) {
  const pngBytes = encodeRgbaToPngBytes(rgba, width, height);
  return `data:image/png;base64,${uint8ToBase64(pngBytes)}`;
}

module.exports = {
  uint8ToBase64,
  encodeRgbaToPngBytes,
  encodeRgbaToPngDataUrl,
};

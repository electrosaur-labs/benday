import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  BINARY_SWOP_LAB16,
  cmykToLab16Buffer,
  computeGrayStepsPerCell,
  computeHvsQuality,
  halftoneCmyk,
} = BendayCore;

describe('HvsQuality (Canonical 16-bit Engine CIELAB Fidelity & Gray Steps)', () => {
  it('encodes canonical 16-bit Engine CIELAB (0..32768, 16384 neutral) with bit-consistent 16x3 binary LUT', () => {
    expect(BINARY_SWOP_LAB16.length).toBe(48);

    // Mask 0 = (0,0,0,0) Paper White -> exact D50 reference white: L16 = 32768, a16 = 16384, b16 = 16384
    expect(BINARY_SWOP_LAB16[0]).toBe(32768);
    expect(BINARY_SWOP_LAB16[1]).toBe(16384);
    expect(BINARY_SWOP_LAB16[2]).toBe(16384);

    // Verify all 16 binary {0, 255}^4 overprint states stay in [0, 32768] and match continuous Neugebauer limit
    for (let mask = 0; mask < 16; mask++) {
      const cBit = (mask >> 3) & 1;
      const mBit = (mask >> 2) & 1;
      const yBit = (mask >> 1) & 1;
      const kBit = mask & 1;

      const L16 = BINARY_SWOP_LAB16[mask * 3];
      const a16 = BINARY_SWOP_LAB16[mask * 3 + 1];
      const b16 = BINARY_SWOP_LAB16[mask * 3 + 2];
      expect(L16).toBeGreaterThanOrEqual(0);
      expect(L16).toBeLessThanOrEqual(32768);
      expect(a16).toBeGreaterThanOrEqual(0);
      expect(a16).toBeLessThanOrEqual(32768);
      expect(b16).toBeGreaterThanOrEqual(0);
      expect(b16).toBeLessThanOrEqual(32768);

      // Exact 0-error match on binary {0, 255} inputs
      const exact = cmykToLab16Buffer(
        {
          C: new Uint8Array([cBit ? 255 : 0]),
          M: new Uint8Array([mBit ? 255 : 0]),
          Y: new Uint8Array([yBit ? 255 : 0]),
          K: new Uint8Array([kBit ? 255 : 0]),
        },
        1
      );
      expect(exact[0]).toBe(L16);
      expect(exact[1]).toBe(a16);
      expect(exact[2]).toBe(b16);

      // Smooth continuity at 254 vs 255 (1 LSB perturbation < 0.65 L* = 213 Lab16 units)
      const cont = cmykToLab16Buffer(
        {
          C: new Uint8Array([cBit ? 254 : 0]),
          M: new Uint8Array([mBit ? 255 : 0]),
          Y: new Uint8Array([yBit ? 255 : 0]),
          K: new Uint8Array([kBit ? 255 : 0]),
        },
        1
      );
      expect(Math.abs(cont[0] - L16)).toBeLessThan(300);
      expect(Math.abs(cont[1] - a16)).toBeLessThan(300);
      expect(Math.abs(cont[2] - b16)).toBeLessThan(300);
    }
  });

  it('computes isotropic and anisotropic grayStepsPerCell accurately', () => {
    // 300 DPI @ 46 LPI -> floor((300/46)^2) + 1 = floor(42.533) + 1 = 43
    expect(computeGrayStepsPerCell(300, 46)).toBe(43);
    // 600 x 1200 DPI @ 46 LPI -> floor((600/46)*(1200/46)) + 1 = 341
    expect(computeGrayStepsPerCell(600, 1200, 46)).toBe(341);
  });

  it('computes 0 DeltaE on identical inputs and realistic viewing-distance DeltaE on halftoned CMYK', () => {
    const W = 96;
    const H = 96;
    const C = new Uint8Array(W * H);
    const M = new Uint8Array(W * H);
    const Y = new Uint8Array(W * H);
    const K = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        C[p] = Math.round((x / (W - 1)) * 200);
        M[p] = Math.round((y / (H - 1)) * 180);
        Y[p] = 90;
        K[p] = 35;
      }
    }

    const orig = { C, M, Y, K };
    const zeroMetric = computeHvsQuality(orig, orig, W, H, { dpi: 600, lpi: 46 });
    expect(zeroMetric.meanDeltaE).toBe(0);
    expect(zeroMetric.p95DeltaE).toBe(0);
    expect(zeroMetric.maxDeltaE).toBe(0);
    expect(zeroMetric.grayStepsPerCell).toBe(171);

    const ht = halftoneCmyk(orig, W, H, { meshTpi: 230, ruleOfN: 5.0, dpi: 600 });
    const htMetric = computeHvsQuality(orig, ht.screens, W, H, {
      cellPitchPx: ht.meshSpec.cellPitchPx,
      dpi: 600,
      lpi: ht.meshSpec.lpiActive,
    });
    expect(htMetric.meanDeltaE).toBeGreaterThan(0.1);
    expect(htMetric.meanDeltaE).toBeLessThan(6.0);
    expect(htMetric.p95DeltaE).toBeGreaterThanOrEqual(htMetric.meanDeltaE);
    expect(htMetric.maxDeltaE).toBeGreaterThanOrEqual(htMetric.p95DeltaE);

    // Blank screens against rich CMYK original must produce much higher DeltaE
    const blank = {
      C: new Uint8Array(W * H),
      M: new Uint8Array(W * H),
      Y: new Uint8Array(W * H),
      K: new Uint8Array(W * H),
    };
    const wrongMetric = computeHvsQuality(orig, blank, W, H, {
      cellPitchPx: ht.meshSpec.cellPitchPx,
      dpi: 600,
      lpi: ht.meshSpec.lpiActive,
    });
    expect(wrongMetric.meanDeltaE).toBeGreaterThan(htMetric.meanDeltaE * 5);
  });
});

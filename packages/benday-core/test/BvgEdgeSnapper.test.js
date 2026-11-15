import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  snapChannelEdges,
  snapCmykEdges,
  halftoneCmyk,
  verifyScreenInvariants,
} = BendayCore;

// Deterministic PRNG (Mulberry32) + Box-Muller Gaussian noise for INV-BVG-1
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('BvgEdgeSnapper (Crisp Type & Linework Conditioner)', () => {
  it('preserves strict fixed points 0 and 255 everywhere', () => {
    const W = 64;
    const H = 64;
    const src = new Uint8Array(W * H);
    for (let i = 0; i < src.length; i++) {
      src[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 255 : 128;
    }
    const out = snapChannelEdges(src, W, H);
    for (let i = 0; i < src.length; i++) {
      if (src[i] === 0) expect(out[i]).toBe(0);
      if (src[i] === 255) expect(out[i]).toBe(255);
    }
  });

  it('INV-BVG-1 (Photographic Immunity): modifies 0 pixels on continuous gradients and Gaussian film grain (sigma = 18)', () => {
    const W = 128;
    const H = 128;

    // 1. Continuous horizontal, vertical, and diagonal 0..255 gradients
    const hGrad = new Uint8Array(W * H);
    const dGrad = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        hGrad[y * W + x] = Math.round((x / (W - 1)) * 255);
        dGrad[y * W + x] = Math.round(((x + y) / (W + H - 2)) * 255);
      }
    }
    expect(Array.from(snapChannelEdges(hGrad, W, H))).toEqual(Array.from(hGrad));
    expect(Array.from(snapChannelEdges(dGrad, W, H))).toEqual(Array.from(dGrad));

    // Even a steep continuous ramp (e.g. 24 ink levels/px across 0..255) has 0 snapped pixels
    const steepGrad = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        steepGrad[y * W + x] = Math.max(0, Math.min(255, Math.round((x - 40) * 24)));
      }
    }
    expect(Array.from(snapChannelEdges(steepGrad, W, H))).toEqual(Array.from(steepGrad));

    // 2. Photographic midtone field (mean = 128) with Gaussian film grain (sigma = 18)
    const rng = mulberry32(0xdecafbad);
    const grain = new Uint8Array(W * H);
    for (let i = 0; i < grain.length; i++) {
      const u1 = Math.max(1e-9, rng());
      const u2 = rng();
      const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      const val = Math.round(128 + 18 * z);
      grain[i] = Math.max(20, Math.min(235, val));
    }
    const snappedGrain = snapChannelEdges(grain, W, H);
    let diffCount = 0;
    for (let i = 0; i < grain.length; i++) {
      if (snappedGrain[i] !== grain[i]) diffCount++;
    }
    expect(diffCount).toBe(0);
  });

  it('snaps anti-aliased graphic step edges cleanly to {0, 255}', () => {
    const W = 40;
    const H = 20;
    const src = new Uint8Array(W * H);
    // Crisp anti-aliased vertical graphic stem: 0 | 64 | 196 | 255 | 255 | 255 | 180 | 50 | 0
    for (let y = 0; y < H; y++) {
      src[y * W + 15] = 64;
      src[y * W + 16] = 196;
      src[y * W + 17] = 255;
      src[y * W + 18] = 255;
      src[y * W + 19] = 255;
      src[y * W + 20] = 180;
      src[y * W + 21] = 50;
    }
    const out = snapChannelEdges(src, W, H);
    for (let y = 2; y < H - 2; y++) {
      expect(out[y * W + 15]).toBe(0);
      expect(out[y * W + 16]).toBe(255);
      expect(out[y * W + 17]).toBe(255);
      expect(out[y * W + 20]).toBe(255);
      expect(out[y * W + 21]).toBe(0);
    }
  });

  it('INV-BVG-2 (Topology Guards): protects 1 px dark hairlines from erasing to 0 and 1 px open counters from plugging to 255', () => {
    const W = 48;
    const H = 48;

    // Case 1: 1 px anti-aliased dark hairline (v = 120) separated by 1 px paper (0) from a 255 block
    // Without the antipodal ridge guard, Otsu threshold t* (~187) would erase v=120 to 0!
    const hairline = new Uint8Array(W * H);
    for (let y = 8; y < 40; y++) {
      hairline[y * W + 20] = 255;
      hairline[y * W + 21] = 255;
      // x = 22 is 0 (1 px gap)
      hairline[y * W + 23] = 120; // 1 px anti-aliased dark hairline
      // x >= 24 is 0
    }
    const outHairline = snapChannelEdges(hairline, W, H);
    for (let y = 10; y < 38; y++) {
      expect(outHairline[y * W + 23]).toBe(255);
      expect(outHairline[y * W + 22]).toBe(0);
    }

    // Case 2: Small letter 'o' / 'e' with a 1 px anti-aliased open counter (v = 110) inside 255 stems on 0 paper
    // Without the antipodal valley guard, Otsu threshold t* (~55) would plug v=110 to 255!
    const counter = new Uint8Array(W * H);
    for (let y = 20; y <= 24; y++) {
      for (let x = 20; x <= 22; x++) {
        counter[y * W + x] = 255;
      }
    }
    counter[22 * W + 21] = 110; // 1 px anti-aliased open counter
    const outCounter = snapChannelEdges(counter, W, H);
    expect(outCounter[22 * W + 21]).toBe(0);
  });

  it('INV-BVG-3 (Stage A Narrow Rich-Black Type UCR vs Wide Fills): promotes narrow strokes to solo K=255 while keeping wide Rich-Black fills (including border-touching & corners) 100% untouched', () => {
    const W = 160;
    const H = 120;
    const C = new Uint8Array(W * H);
    const M = new Uint8Array(W * H);
    const Y = new Uint8Array(W * H);
    const K = new Uint8Array(W * H);

    // 1. Wide Rich-Black block touching top-left canvas border (0..44, 0..44) -> width 45 >= 2 * 6.5 = 13
    for (let y = 0; y < 45; y++) {
      for (let x = 0; x < 45; x++) {
        const p = y * W + x;
        C[p] = 160;
        M[p] = 145;
        Y[p] = 140;
        K[p] = 235;
      }
    }

    // 2. Interior Wide Rich-Black block (90..135, 15..60) -> width 46 >= 13 (tests all four 90° corners)
    for (let y = 15; y <= 60; y++) {
      for (let x = 90; x <= 135; x++) {
        const p = y * W + x;
        C[p] = 155;
        M[p] = 140;
        Y[p] = 135;
        K[p] = 240;
      }
    }

    // 3. Narrow Rich-Black headline stroke (6 px wide < 2 * 6.5 = 13 px) + 1 px anti-aliased fringe on white paper
    for (let y = 75; y <= 108; y++) {
      // Left 1px anti-aliased fringe at x = 29
      {
        const p = y * W + 29;
        C[p] = 75;
        M[p] = 70;
        Y[p] = 68;
        K[p] = 140;
      }
      // 6px Rich-Black stroke core at x = 30..35
      for (let x = 30; x <= 35; x++) {
        const p = y * W + x;
        C[p] = 160;
        M[p] = 145;
        Y[p] = 140;
        K[p] = 235;
      }
      // Right 1px anti-aliased fringe at x = 36
      {
        const p = y * W + 36;
        C[p] = 60;
        M[p] = 55;
        Y[p] = 52;
        K[p] = 90;
      }
    }

    const snapped = snapCmykEdges({ C, M, Y, K }, W, H, { cellPitchPx: 6.5 });

    // Wide block 1 (border-touching) must be 100% untouched
    for (let y = 0; y < 45; y++) {
      for (let x = 0; x < 45; x++) {
        const p = y * W + x;
        expect(snapped.C[p]).toBe(160);
        expect(snapped.M[p]).toBe(145);
        expect(snapped.Y[p]).toBe(140);
        expect(snapped.K[p]).toBe(235);
      }
    }

    // Wide block 2 (including all four 90° corners!) must be 100% untouched
    for (let y = 15; y <= 60; y++) {
      for (let x = 90; x <= 135; x++) {
        const p = y * W + x;
        expect(snapped.C[p]).toBe(155);
        expect(snapped.M[p]).toBe(140);
        expect(snapped.Y[p]).toBe(135);
        expect(snapped.K[p]).toBe(240);
      }
    }

    // Narrow Rich-Black stroke must promote to K=255, C=M=Y=0, and 1px fringe must have C=M=Y=0
    for (let y = 78; y <= 105; y++) {
      for (let x = 30; x <= 35; x++) {
        const p = y * W + x;
        expect(snapped.K[p]).toBe(255);
        expect(snapped.C[p]).toBe(0);
        expect(snapped.M[p]).toBe(0);
        expect(snapped.Y[p]).toBe(0);
      }
      expect(snapped.C[y * W + 29]).toBe(0);
      expect(snapped.M[y * W + 29]).toBe(0);
      expect(snapped.Y[y * W + 29]).toBe(0);
      expect(snapped.C[y * W + 36]).toBe(0);
      expect(snapped.M[y * W + 36]).toBe(0);
      expect(snapped.Y[y * W + 36]).toBe(0);
    }

    // End-to-end halftoneCmyk with bvg: true passes all screen invariants
    const res = halftoneCmyk(
      { C, M, Y, K },
      W,
      H,
      { meshTpi: 230, ruleOfN: 5.0, dpi: 300, bvg: true }
    );
    for (const ch of ['C', 'M', 'Y', 'K']) {
      const audit = verifyScreenInvariants(res.screens[ch], W, H, {
        dMinPx: res.meshSpec.dMinPx,
        aMinPx: res.meshSpec.aMinPx,
        cellPitchPx: res.meshSpec.cellPitchPx,
        srcUint8: res.conditionedChannels[ch],
      });
      expect(audit.ok, `Screen ${ch} failed invariants under BVG`).toBe(true);
    }
  });
});

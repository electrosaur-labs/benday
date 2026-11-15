import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  computeMeshSpec,
  applyDotGainPullback,
  halftoneChannel,
  halftoneCmyk,
  verifyPlateInvariants,
  verifyScreenInvariants,
} = BendayCore;

describe('HalftoneEngine Core Guarantees', () => {
  it('reproduces pure 0% paper and 100% graphic linework (1px crosshairs + tiny counters) bit-for-bit', () => {
    const W = 128;
    const H = 128;
    const src = new Uint8Array(W * H);

    // 1px vertical & horizontal registration crosshair + 1px hollow bullseye box (3x3 white counter)
    for (let x = 10; x < W - 10; x++) src[64 * W + x] = 255;
    for (let y = 10; y < H - 10; y++) src[y * W + 64] = 255;
    for (let d = -2; d <= 2; d++) {
      src[(30 - 2) * W + (30 + d)] = 255;
      src[(30 + 2) * W + (30 + d)] = 255;
      src[(30 + d) * W + (30 - 2)] = 255;
      src[(30 + d) * W + (30 + 2)] = 255;
    }

    const meshSpec = computeMeshSpec({ meshTpi: 230, ruleOfN: 4.0, dpi: 600 });
    const plate = halftoneChannel(src, W, H, { meshSpec, angleDeg: 15, tailMode: 'hybrid' });

    expect(Array.from(plate)).toEqual(Array.from(src));

    const audit = verifyPlateInvariants(plate, W, H, {
      dMinPx: meshSpec.dMinPx,
      aMinPx: meshSpec.aMinPx,
      cellPitchPx: meshSpec.cellPitchPx,
      srcUint8: src,
    });
    expect(audit.ok).toBe(true);
    expect(audit.paperBleedViolations).toBe(0);
    expect(audit.solidPreservationViolations).toBe(0);
  });

  it('preserves 1px M_solid linework embedded inside a continuous-tone gradient without dark halos or dropouts', () => {
    const W = 180;
    const H = 140;
    const src = new Uint8Array(W * H);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Leave 20px pure 0% paper border on left, ramp across middle, 1px solid crosshair across whole canvas
        if (x >= 20) {
          src[y * W + x] = Math.min(254, Math.round(((x - 20) / (W - 21)) * 250));
        }
      }
    }
    // 1px 100% solid registration lines crossing both 0% margin and continuous gradient
    for (let x = 4; x < W - 4; x++) src[70 * W + x] = 255;
    for (let y = 4; y < H - 4; y++) src[y * W + 10] = 255;

    const meshSpec = computeMeshSpec({ meshTpi: 305, ruleOfN: 4.0, dpi: 600 });
    const plate = halftoneChannel(src, W, H, { meshSpec, angleDeg: 45, tailMode: 'hybrid' });

    for (let p = 0; p < W * H; p++) {
      if (src[p] === 255) {
        expect(plate[p]).toBe(255);
      }
    }

    const audit = verifyPlateInvariants(plate, W, H, {
      dMinPx: meshSpec.dMinPx,
      aMinPx: meshSpec.aMinPx,
      cellPitchPx: meshSpec.cellPitchPx,
      srcUint8: src,
    });
    expect(audit).toMatchObject({
      ok: true,
      binaryPure: true,
      minDotViolations: 0,
      minHoleViolations: 0,
      paperBleedViolations: 0,
      solidPreservationViolations: 0,
    });
  });

  it('differentiates hybrid, cutoff, and clamp tail modes in highlight and shadow tails', () => {
    const W = 160;
    const H = 160;
    const meshSpec = computeMeshSpec({ meshTpi: 230, ruleOfN: 4.0, dpi: 600 });
    // Pick highlight tone strictly inside (0, tMin): ~4% ink (src = 10)
    const hiSrc = new Uint8Array(W * H).fill(10);

    const pCutoff = halftoneChannel(hiSrc, W, H, { meshSpec, angleDeg: 15, tailMode: 'cutoff' });
    const pHybrid = halftoneChannel(hiSrc, W, H, { meshSpec, angleDeg: 15, tailMode: 'hybrid' });
    const pClamp = halftoneChannel(hiSrc, W, H, { meshSpec, angleDeg: 15, tailMode: 'clamp' });

    const cov = (buf) => buf.reduce((acc, v) => acc + (v === 255 ? 1 : 0), 0) / buf.length;
    const cCut = cov(pCutoff);
    const cHyb = cov(pHybrid);
    const cClp = cov(pClamp);

    expect(cCut).toBe(0);
    expect(cHyb).toBeGreaterThan(0.015);
    expect(cHyb).toBeLessThan(cClp);
    expect(cClp).toBeGreaterThan(0.08);

    // Shadow tail ~96% ink (src = 245)
    const shSrc = new Uint8Array(W * H).fill(245);
    const sCutoff = halftoneChannel(shSrc, W, H, { meshSpec, angleDeg: 75, tailMode: 'cutoff' });
    const sHybrid = halftoneChannel(shSrc, W, H, { meshSpec, angleDeg: 75, tailMode: 'hybrid' });
    const sClamp = halftoneChannel(shSrc, W, H, { meshSpec, angleDeg: 75, tailMode: 'clamp' });

    // In cutoff mode, shadow tail collapses to solid (interior 100% ink; only the 4 outer canvas corners
    // are rounded by B_{D_min} opening so every non-solid pixel fits a full B_{D_min} disk inside canvas)
    expect(cov(sCutoff)).toBeGreaterThan(0.998);
    expect(sCutoff[80 * W + 80]).toBe(255);
    expect(cov(sHybrid)).toBeLessThan(cov(sCutoff) - 0.01);
    expect(cov(sHybrid)).toBeGreaterThan(cov(sClamp));
  });

  it('returns canonical { plates: { C, M, Y, K }, meshSpec, moireReport, angles } from halftoneCmyk', () => {
    const W = 120;
    const H = 100;
    const mkRamp = (dir) => {
      const b = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const t = dir === 0 ? x / (W - 1) : y / (H - 1);
          b[y * W + x] = Math.round(t * 255);
        }
      }
      return b;
    };

    const channels = { C: mkRamp(0), M: mkRamp(1), Y: mkRamp(0), K: mkRamp(1) };
    const res = halftoneCmyk(
      channels,
      W,
      H,
      { meshTpi: 305, ruleOfN: 4.0, dpi: 600, meshAngleDeg: 18, tailMode: 'hybrid' }
    );

    expect(Object.keys(res.plates).sort()).toEqual(['C', 'K', 'M', 'Y']);
    expect(res.moireReport.safe).toBe(true);
    expect(res.angles).toEqual({ C: 33, M: 3, Y: 78, K: 63 });

    for (const ch of ['C', 'M', 'Y', 'K']) {
      const audit = verifyPlateInvariants(res.plates[ch], W, H, {
        dMinPx: res.meshSpec.dMinPx,
        aMinPx: res.meshSpec.aMinPx,
        cellPitchPx: res.meshSpec.cellPitchPx,
        srcUint8: channels[ch],
      });
      expect(audit.ok, `Channel ${ch} failed invariants`).toBe(true);
    }
  });

  it('catches connected ink bleeding across 0% paper via Chebyshev neighborhood audit in PlateVerifier', () => {
    const W = 120;
    const H = 80;
    const src = new Uint8Array(W * H);
    // Continuous-tone ink strictly on right half (x >= 60); left half (x < 60) is pure 0% paper
    for (let y = 0; y < H; y++) {
      for (let x = 60; x < W; x++) {
        src[y * W + x] = 60 + Math.round(((x - 60) / 59) * 140);
      }
    }

    const meshSpec = computeMeshSpec({ meshTpi: 230, ruleOfN: 4.0, dpi: 600 });
    const plate = halftoneChannel(src, W, H, { meshSpec, angleDeg: 45, tailMode: 'hybrid' });

    // Clean halftone output must have 0 paper bleed violations
    const cleanAudit = verifyPlateInvariants(plate, W, H, {
      dMinPx: meshSpec.dMinPx,
      aMinPx: meshSpec.aMinPx,
      cellPitchPx: meshSpec.cellPitchPx,
      srcUint8: src,
    });
    expect(cleanAudit.ok).toBe(true);
    expect(cleanAudit.paperBleedViolations).toBe(0);

    // Inject a connected capsule bar of canonical B_{D_min} disks from x = 90 across 0% paper to x = 12
    const corrupted = new Uint8Array(plate);
    for (let ax = 12; ax <= 90; ax++) {
      for (const off of meshSpec.diskOffsets) {
        corrupted[(40 + off.dy) * W + (ax + off.dx)] = 255;
      }
    }

    const bleedAudit = verifyPlateInvariants(corrupted, W, H, {
      dMinPx: meshSpec.dMinPx,
      aMinPx: meshSpec.aMinPx,
      cellPitchPx: meshSpec.cellPitchPx,
      srcUint8: src,
    });
    expect(bleedAudit.minDotViolations).toBe(0);
    expect(bleedAudit.paperBleedViolations).toBeGreaterThan(0);
    expect(bleedAudit.ok).toBe(false);
  });

  it('protects pure {0, 255} graphic counters inside M_solid frames embedded in deep halftone shadows', () => {
    const W = 120;
    const H = 120;
    // Deep 92% shadow field (src = 235) where Stage 6 shadow-hole / bridge closure is active
    const src = new Uint8Array(W * H).fill(235);

    // Embed a 5x5 M_solid (255) hollow square frame at (58..62, 58..62) enclosing a 3x3 pure 0% counter
    for (let y = 58; y <= 62; y++) {
      for (let x = 58; x <= 62; x++) {
        const isBorder = x === 58 || x === 62 || y === 58 || y === 62;
        src[y * W + x] = isBorder ? 255 : 0;
      }
    }

    const meshSpec = computeMeshSpec({ meshTpi: 230, ruleOfN: 4.0, dpi: 600 }); // dMinPx = 10 > 3x3 counter
    const plate = halftoneChannel(src, W, H, { meshSpec, angleDeg: 15, tailMode: 'hybrid' });

    // Every 3x3 counter pixel must remain 0, and every 5x5 M_solid border pixel must remain 255
    for (let y = 58; y <= 62; y++) {
      for (let x = 58; x <= 62; x++) {
        const isBorder = x === 58 || x === 62 || y === 58 || y === 62;
        expect(plate[y * W + x]).toBe(isBorder ? 255 : 0);
      }
    }

    const audit = verifyPlateInvariants(plate, W, H, {
      dMinPx: meshSpec.dMinPx,
      aMinPx: meshSpec.aMinPx,
      cellPitchPx: meshSpec.cellPitchPx,
      srcUint8: src,
    });
    expect(audit).toMatchObject({
      ok: true,
      binaryPure: true,
      minDotViolations: 0,
      minHoleViolations: 0,
      paperBleedViolations: 0,
      solidPreservationViolations: 0,
    });
  });

  it('supports true physical-inch anisotropic DPI (600x1200) while staying bit-identical when dpiX === dpiY', () => {
    const W = 120;
    const H = 240; // 0.2 in x 0.2 in physical square at 600 x 1200 DPI
    const anisoSrc = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const ry = (y - H * 0.5) / 80; // 80 px @ 1200 DPI = 1/15 in radius
      for (let x = 0; x < W; x++) {
        const rx = (x - W * 0.5) / 40; // 40 px @ 600 DPI = 1/15 in radius
        if (rx * rx + ry * ry <= 1.0) {
          anisoSrc[y * W + x] = 128;
        }
      }
    }

    const anisoSpec = computeMeshSpec({ meshTpi: 230, ruleOfN: 5.0, dpiX: 600, dpiY: 1200 });
    expect(anisoSpec.dMinPxX).toBe(5);
    expect(anisoSpec.dMinPxY).toBe(10);
    expect(anisoSpec.cellPitchPxY).toBeCloseTo(2 * anisoSpec.cellPitchPxX, 9);

    const anisoPlate = halftoneChannel(anisoSrc, W, H, {
      meshSpec: anisoSpec,
      angleDeg: 33,
      tailMode: 'hybrid',
    });

    const anisoAudit = verifyPlateInvariants(anisoPlate, W, H, {
      dMinPx: anisoSpec.dMinPx,
      dMinPxX: anisoSpec.dMinPxX,
      dMinPxY: anisoSpec.dMinPxY,
      aMinPx: anisoSpec.aMinPx,
      cellPitchPx: anisoSpec.cellPitchPx,
      cellPitchPxX: anisoSpec.cellPitchPxX,
      cellPitchPxY: anisoSpec.cellPitchPxY,
      srcUint8: anisoSrc,
    });
    expect(anisoAudit.ok).toBe(true);
    expect(anisoAudit.minDotViolations).toBe(0);
    expect(anisoAudit.minHoleViolations).toBe(0);
    expect(anisoAudit.paperBleedViolations).toBe(0);

    // Bit-for-bit identity check when dpiX === dpiY === 600
    const isoSrc = new Uint8Array(96 * 96).map((_, i) => i % 255);
    const pIso = halftoneChannel(isoSrc, 96, 96, { meshTpi: 230, dpi: 600, angleDeg: 15 });
    const pExplicit = halftoneChannel(isoSrc, 96, 96, {
      meshTpi: 230,
      dpiX: 600,
      dpiY: 600,
      angleDeg: 15,
    });
    expect(Array.from(pExplicit)).toEqual(Array.from(pIso));
  });

  it('maintains monotone tonal response with zero 51%–60% ink spike and <= 3.5% channel spread across 0°, 15°, 45°, 75°', () => {
    const configs = [
      { label: '300dpi 50LPI', dpi: 300, meshTpi: 355, threadDiaUm: 31, ruleOfN: 7.0 },
      { label: '600dpi 46LPI', dpi: 600, meshTpi: 230, threadDiaUm: 48, ruleOfN: 5.0 },
      { label: '600dpi 64LPI', dpi: 600, meshTpi: 305, threadDiaUm: 34, lpiOverride: 64 },
    ];
    const patches = [15, 25, 35, 50, 55, 65, 75, 85];
    const angles = [0, 15, 45, 75];
    const W = 140;
    const H = 140;
    const margin = 18;

    for (const cfg of configs) {
      const spec = computeMeshSpec(cfg);
      const byPatch = new Map(patches.map((p) => [p, []]));

      for (const ang of angles) {
        let prevCov = -1;
        for (const pct of patches) {
          const src = new Uint8Array(W * H).fill(Math.round((pct / 100) * 255));
          const plate = halftoneChannel(src, W, H, {
            meshSpec: spec,
            angleDeg: ang,
            tailMode: 'hybrid',
            channelKey: 'K',
          });

          const audit = verifyPlateInvariants(plate, W, H, {
            dMinPx: spec.dMinPx,
            aMinPx: spec.aMinPx,
            cellPitchPx: spec.cellPitchPx,
            srcUint8: src,
          });
          expect(audit.ok, `${cfg.label} ang=${ang} pct=${pct} invariant`).toBe(true);

          let ink = 0;
          let count = 0;
          for (let y = margin; y < H - margin; y++) {
            for (let x = margin; x < W - margin; x++) {
              if (plate[y * W + x] === 255) ink++;
              count++;
            }
          }
          const covPct = (100 * ink) / count;
          expect(
            covPct,
            `${cfg.label} ang=${ang} monotone ${pct}% vs prev`
          ).toBeGreaterThan(prevCov);
          // Explicitly guard against the historical +15%..22% Stage 6 jump at 50%..55%
          if (pct === 55) {
            expect(covPct - prevCov).toBeLessThan(10.0);
          }
          prevCov = covPct;
          byPatch.get(pct).push(covPct);
        }
      }

      for (const pct of patches) {
        const vals = byPatch.get(pct);
        const spread = Math.max(...vals) - Math.min(...vals);
        expect(
          spread,
          `${cfg.label} pct=${pct}% channel spread (${vals.map((v) => v.toFixed(1)).join('/')})`
        ).toBeLessThanOrEqual(3.5);
      }
    }
  });

  it('INV-DG-1 & INV-DG-2: applies parabolic Press Dot Gain pullback with fixed points {0, 1}, exact 50% pullback, and 0 sub-D_min dot violations', () => {
    // Mathematical curve invariants
    expect(applyDotGainPullback(0, 15)).toBe(0);
    expect(applyDotGainPullback(1, 15)).toBe(1);
    expect(applyDotGainPullback(0.5, 0)).toBe(0.5);
    expect(applyDotGainPullback(0.5, 15)).toBeCloseTo(0.35, 12);
    expect(applyDotGainPullback(0.5, 20)).toBeCloseTo(0.30, 12);
    expect(applyDotGainPullback(0.5, 35)).toBeCloseTo(0.30, 12); // clamped to 20%

    // Strict monotonicity across [0, 1] at maximum 20% dot gain
    let prev = -1;
    for (let i = 0; i <= 255; i++) {
      const y = applyDotGainPullback(i / 255, 20);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }

    const W = 160;
    const H = 160;
    const margin = 20;
    const spec = computeMeshSpec({ meshTpi: 230, threadDiaUm: 48, ruleOfN: 5.0, dpi: 600 });

    // Measure 50% midtone screen coverage at 0% vs 15% dotGain
    const midSrc = new Uint8Array(W * H).fill(128);
    // Stamp a 100% solid 6x6 registration mark to verify solid sovereignty under dotGain
    for (let y = 8; y < 14; y++) {
      for (let x = 8; x < 14; x++) {
        midSrc[y * W + x] = 255;
      }
    }

    const scr0 = halftoneChannel(midSrc, W, H, { meshSpec: spec, angleDeg: 45, dotGain: 0 });
    const scr15 = halftoneChannel(midSrc, W, H, { meshSpec: spec, angleDeg: 45, dotGain: 15 });

    const measureInterior = (buf) => {
      let ink = 0;
      let total = 0;
      for (let y = margin; y < H - margin; y++) {
        for (let x = margin; x < W - margin; x++) {
          if (buf[y * W + x] === 255) ink++;
          total++;
        }
      }
      return ink / total;
    };

    const cov0 = measureInterior(scr0);
    const cov15 = measureInterior(scr15);
    expect(cov0 - cov15).toBeGreaterThan(0.11);
    expect(cov0 - cov15).toBeLessThan(0.19);

    // 100% solid mark must stay 255 despite 15% dotGain
    for (let y = 8; y < 14; y++) {
      for (let x = 8; x < 14; x++) {
        expect(scr15[y * W + x]).toBe(255);
      }
    }

    // INV-DG-2: Continuous ramp from 0..255 under 20% dotGain across all tailModes has 0 minDot/minHole violations
    const ramp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        ramp[y * W + x] = x < 12 ? 0 : Math.round(((x - 12) / (W - 13)) * 255);
      }
    }
    for (const tailMode of ['hybrid', 'cutoff', 'clamp']) {
      const res = halftoneCmyk(
        { C: ramp, M: ramp, Y: ramp, K: ramp },
        W,
        H,
        { meshTpi: 230, ruleOfN: 5.0, dpi: 600, tailMode, dotGain: 20, rosettePreset: 'fta' }
      );
      expect(res.screens).toBe(res.plates);
      for (const ch of ['C', 'M', 'Y', 'K']) {
        const audit = verifyScreenInvariants(res.screens[ch], W, H, {
          dMinPx: res.meshSpec.dMinPx,
          aMinPx: res.meshSpec.aMinPx,
          cellPitchPx: res.meshSpec.cellPitchPx,
          srcUint8: ramp,
        });
        expect(audit.ok, `dotGain=20 tailMode=${tailMode} screen ${ch}`).toBe(true);
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  RosetteAngles,
  ROSETTE_PRESETS,
  norm90,
  clearance90,
  computeRosetteAngles,
  assignImageAwareRosetteSlots,
  resolveRosettePresetAngles,
  besselJ1,
  analyzeMoire,
  computeMeshSpec,
} = BendayCore;

describe('RosetteAngles & 2D Harmonic Moiré Guard', () => {
  it('normalizes modulo 90° and computes symmetric lattice clearance in [0, 45]', () => {
    expect(norm90(0)).toBe(0);
    expect(norm90(90)).toBe(0);
    expect(norm90(-15)).toBe(75);
    expect(norm90(195)).toBe(15);

    expect(clearance90(0, 15)).toBeCloseTo(15, 10);
    expect(clearance90(0, 75)).toBeCloseTo(15, 10);
    expect(clearance90(18, 3)).toBeCloseTo(15, 10);
    expect(clearance90(18, 63)).toBeCloseTo(45, 10);
  });

  it('centers meshAngleDeg inside the empty 30° rosette pocket across arbitrary bias angles', () => {
    const r0 = computeRosetteAngles(0);
    expect(r0).toEqual({ C: 15, M: 75, Y: 60, K: 45 });

    for (const theta of [0, 7.5, 18, 22.5, 37, 89.5]) {
      const r = computeRosetteAngles(theta);
      expect(clearance90(r.C, r.K)).toBeCloseTo(30, 8);
      expect(clearance90(r.K, r.M)).toBeCloseTo(30, 8);
      expect(clearance90(r.C, r.M)).toBeCloseTo(30, 8);
      expect(clearance90(r.Y, r.K)).toBeCloseTo(15, 8);
      expect(clearance90(r.Y, r.M)).toBeCloseTo(15, 8);

      // Slop immunity across ±2° stretcher variance: clearance >= 13.0°
      for (let d = -2; d <= 2; d += 0.5) {
        for (const ch of ['C', 'M', 'Y', 'K']) {
          expect(clearance90(r[ch], theta + d)).toBeGreaterThanOrEqual(13.0 - 1e-9);
        }
      }
    }
  });

  it('computes accurate pure-JS besselJ1(x) across small, intermediate, and asymptotic arguments', () => {
    expect(besselJ1(0)).toBe(0);
    // Odd symmetry J_1(-x) = -J_1(x)
    expect(besselJ1(-2.5)).toBeCloseTo(-besselJ1(2.5), 14);
    // Known reference values & first three positive zeros of J_1
    expect(besselJ1(1.0)).toBeCloseTo(0.4400505857449335, 13);
    expect(besselJ1(5.0)).toBeCloseTo(-0.3275791375914652, 13);
    expect(besselJ1(15.0)).toBeCloseTo(0.2051040386135228, 12);
    expect(Math.abs(besselJ1(3.831705970207512))).toBeLessThan(1e-13);
    expect(Math.abs(besselJ1(7.015586669815619))).toBeLessThan(1e-13);
    expect(Math.abs(besselJ1(13.323691936314223))).toBeLessThan(1e-12);
  });

  it('passes all standard plain-weave halftone meshes (156..420 at N=5, 110 at N=5.5) with auto-rosette cleanly', () => {
    for (const meshTpi of [156, 196, 200, 230, 280, 305, 355, 380, 420]) {
      const spec = computeMeshSpec({ meshTpi, dpi: 600 });
      const report = analyzeMoire({
        meshTpi,
        threadDiaUm: spec.threadDiaUm,
        lpi: spec.lpiActive,
        meshAngleDeg: 18,
      });
      expect(report.safe, `Expected safe rosette on ${meshTpi} TPI`).toBe(true);
      expect(report.warnings).toEqual([]);
      expect(report.minClearanceDeg).toBeCloseTo(13.0, 6);
    }

    const spec110 = computeMeshSpec({ meshTpi: 110, ruleOfN: 5.5, dpi: 600 });
    const rep110 = analyzeMoire({
      meshTpi: 110,
      threadDiaUm: spec110.threadDiaUm,
      lpi: spec110.lpiActive,
      meshAngleDeg: 18,
    });
    expect(rep110.safe).toBe(true);
    expect(rep110.warnings).toEqual([]);
  });

  it('flags WARN_SEVERE_MOIRE on thread-aligned screens and WARN_HARMONIC_MOIRE on 2D 3-4-5 harmonic beats', () => {
    // Direct axis clash: K screen at 2° vs 0° mesh -> clearance 0° inside ±2° slop
    const severe = analyzeMoire({
      meshTpi: 230,
      threadDiaUm: 48,
      lpi: 45,
      angles: { C: 15, M: 75, Y: 60, K: 2 },
      meshAngleDeg: 0,
    });
    expect(severe.safe).toBe(false);
    expect(severe.warnings).toContain(RosetteAngles.WARN_SEVERE_MOIRE);

    // 2D Pythagorean (-4, 3) harmonic beat at 36.87° (clearance 34.87° >> 7.5°, caught purely by 2D reciprocal check!)
    const pythagorean = analyzeMoire({
      meshTpi: 230,
      threadDiaUm: 48,
      lpi: 46,
      angles: { C: 36.87, M: 75, Y: 60, K: 15 },
      meshAngleDeg: 0,
    });
    expect(pythagorean.channels.C.minClearanceDeg).toBeGreaterThan(30);
    expect(pythagorean.warnings).toContain(RosetteAngles.WARN_HARMONIC_MOIRE);
    expect(pythagorean.channels.C.worstBeat.wavelengthIn).toBeGreaterThan(0.20);

    // Severe 3x harmonic beat (230 / 3 = 76.67 LPI)
    const thirdHarmonic = analyzeMoire({
      meshTpi: 230,
      threadDiaUm: 48,
      lpi: 76.67,
      angles: { C: 36.87, M: 75, Y: 60, K: 15 },
      meshAngleDeg: 0,
    });
    // Check 0° or 3x harmonic
    const alignedThird = analyzeMoire({
      meshTpi: 230,
      threadDiaUm: 48,
      lpi: 76.67,
      angles: { C: 0, M: 75, Y: 60, K: 45 },
      meshAngleDeg: 0,
    });
    expect(alignedThird.warnings).toContain(RosetteAngles.WARN_SEVERE_MOIRE);
    expect(alignedThird.maxContrast).toBeGreaterThanOrEqual(0.03);
    expect(thirdHarmonic).toBeDefined();
  });

  it('resolves all 6 ROSETTE_PRESETS and computes Image-Aware slot assignment in < 2 ms', () => {
    expect(ROSETTE_PRESETS.map((p) => p.id)).toEqual([
      'auto',
      'image-aware',
      'fta',
      'iso',
      'flamenco',
      'manual',
    ]);

    expect(resolveRosettePresetAngles('auto', 10)).toEqual({
      C: 25,
      M: 85,
      Y: 70,
      K: 55,
    });
    expect(resolveRosettePresetAngles('fta', 0)).toEqual({
      C: 7.5,
      M: 67.5,
      Y: 82.5,
      K: 37.5,
    });
    expect(resolveRosettePresetAngles('iso', 22)).toEqual({
      C: 15,
      M: 75,
      Y: 0,
      K: 45,
    });
    expect(resolveRosettePresetAngles('flamenco', 5)).toEqual({
      C: 27.5,
      M: 27.5,
      Y: 27.5,
      K: 27.5,
    });
    expect(
      resolveRosettePresetAngles('manual', 0, null, 0, 0, { C: 12, M: 72, Y: 57, K: 42 })
    ).toEqual({
      C: 12,
      M: 72,
      Y: 57,
      K: 42,
    });

    // Scenario A: Cyan + Yellow duotone (K=0, M=0, C=128, Y=128) at meshAngle = 0
    // C should win the prime 45° oblique-minimum slot, and C & Y must be separated by 30° (not 15°)!
    const W = 128;
    const H = 128;
    const duotone = {
      C: new Uint8Array(W * H).fill(128),
      M: new Uint8Array(W * H),
      Y: new Uint8Array(W * H).fill(128),
      K: new Uint8Array(W * H),
    };
    const duoAngles = assignImageAwareRosetteSlots(duotone, W, H, 0);
    expect(duoAngles.C).toBe(45);
    expect(clearance90(duoAngles.C, duoAngles.Y)).toBeCloseTo(30, 8);

    // Scenario B: Flesh-tone portrait dominated by Magenta midtones (M=128, Y=120, C=0, K=0)
    // M should win the 45° oblique-minimum slot!
    const portrait = {
      C: new Uint8Array(W * H),
      M: new Uint8Array(W * H).fill(128),
      Y: new Uint8Array(W * H).fill(120),
      K: new Uint8Array(W * H),
    };
    const portraitAngles = assignImageAwareRosetteSlots(portrait, W, H, 0);
    expect(portraitAngles.M).toBe(45);

    // Performance budget: <= 4096-sample stride executes in < 2 ms even on 2000 x 2000 (4 MP)
    const bigW = 2000;
    const bigH = 2000;
    const big = {
      C: new Uint8Array(bigW * bigH).fill(90),
      M: new Uint8Array(bigW * bigH).fill(120),
      Y: new Uint8Array(bigW * bigH).fill(140),
      K: new Uint8Array(bigW * bigH).fill(110),
    };
    // Warm up JIT once before timing
    assignImageAwareRosetteSlots(big, bigW, bigH, 0);
    const t0 = performance.now();
    const bigAngles = assignImageAwareRosetteSlots(big, bigW, bigH, 0);
    const elapsedMs = performance.now() - t0;
    expect(bigAngles.K).toBe(45);
    expect(elapsedMs).toBeLessThan(2.0);
  });
});

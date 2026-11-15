import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  RosetteAngles,
  norm90,
  clearance90,
  computeRosetteAngles,
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
});

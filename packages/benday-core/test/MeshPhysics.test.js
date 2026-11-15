import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import BendayCore from '../index.js';

const {
  MeshPhysics,
  EuclideanLut,
  STANDARD_THREAD_UM,
  SAATI_MESH_PRESETS,
  F_OPEN_REF,
  getCanonicalDiskOffsets,
  computeMeshSpec,
} = BendayCore;

describe('Zero-Dependency Mandate (benday-core)', () => {
  it('has zero runtime dependencies in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
    );
    expect(pkg.dependencies || {}).toEqual({});
  });

  it('uses zero Node.js built-in modules in index.js and lib/*.js', () => {
    const coreDir = path.resolve(__dirname, '..');
    const files = [
      path.join(coreDir, 'index.js'),
      ...fs.readdirSync(path.join(coreDir, 'lib')).map((f) => path.join(coreDir, 'lib', f)),
    ];
    const forbidden = /\brequire\s*\(\s*['"](?:node:)?(?:fs|path|crypto|buffer|os|child_process|util|stream|http|https|zlib|net)['"]\s*\)/;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      expect(forbidden.test(src), `Forbidden Node built-in in ${path.basename(file)}`).toBe(false);
    }
  });
});

describe('MeshPhysics', () => {
  it('exposes standard plain-weave roll catalog (with 355-31 studio default) and 20 official SAATI presets', () => {
    expect(MeshPhysics.DEFAULT_MESH_TPI).toBe(355);
    expect(MeshPhysics.DEFAULT_THREAD_UM).toBe(31);
    expect(STANDARD_THREAD_UM).toEqual({
      110: 80,
      156: 64,
      196: 55,
      200: 55,
      230: 48,
      280: 40,
      305: 34,
      355: 31,
      380: 31,
      420: 27,
    });

    expect(MeshPhysics.RULE_OF_N_DEFAULT).toBe(5.0);
    expect(Object.isFrozen(SAATI_MESH_PRESETS)).toBe(true);
    expect(SAATI_MESH_PRESETS.map((p) => p.id)).toEqual([
      '110-80',
      '110-70',
      '156-64',
      '156-48',
      '196-55',
      '196-48',
      '230-48',
      '230-40',
      '280-40',
      '280-34',
      '280-31',
      '305-40',
      '305-34',
      '305-31',
      '355-34',
      '355-31',
      '380-34',
      '380-31',
      '420-31',
      '420-27',
    ]);
    const byId = Object.fromEntries(SAATI_MESH_PRESETS.map((p) => [p.id, p]));
    expect(byId['230-48'].label).toBe('230-48 (32% open)');
    expect(byId['355-31'].label).toBe('355-31 (32% open · Hi-R)');
    expect(byId['355-34'].label).toBe('355-34 (28% open)');
  });

  it('computes true press-room Rule of N (threads per halftone cell) and exact SAATI checkpoints', () => {
    expect(F_OPEN_REF).toBeCloseTo(0.319628, 5);

    // 230-48, N=5 (default) @ 600 DPI -> 46.0 LPI, dMinPx = 5
    const spec230_600 = computeMeshSpec({ meshTpi: 230, threadDiaUm: 48, dpi: 600 });
    expect(spec230_600.ruleOfN).toBe(5.0);
    expect(spec230_600.openArea).toBeCloseTo(F_OPEN_REF, 10);
    expect(spec230_600.openAreaScale).toBeCloseTo(1.0, 10);
    expect(spec230_600.lpiNatural).toBeCloseTo(46.0, 6);
    expect(spec230_600.dMinPx).toBe(5);

    // 230-48, N=5 @ 300 DPI -> 46.0 LPI, dMinPx = 3, aMinPx = 9, tMin = 21.2%
    const spec230_300 = computeMeshSpec({ meshTpi: 230, threadDiaUm: 48, ruleOfN: 5.0, dpi: 300 });
    expect(spec230_300.lpiNatural).toBeCloseTo(46.0, 6);
    expect(spec230_300.dMinPx).toBe(3);
    expect(spec230_300.aMinPx).toBe(9);
    expect(spec230_300.tMin).toBeCloseTo(0.2116, 3);

    // 355-31, N=7 @ 300 DPI -> 50.8 LPI, dMinPx = 2, aMinPx = 4, tMin = 11.5%, 0 warnings
    const spec355_31 = computeMeshSpec({ meshTpi: 355, threadDiaUm: 31, ruleOfN: 7.0, dpi: 300 });
    expect(spec355_31.lpiNatural).toBeCloseTo(50.84, 1);
    expect(spec355_31.dMinPx).toBe(2);
    expect(spec355_31.aMinPx).toBe(4);
    expect(spec355_31.tMin).toBeCloseTo(0.1149, 3);
    expect(spec355_31.warnings).toEqual([]);
    expect(spec230_300.warnings).toEqual([]);

    // 355-34, N=7 @ 600 DPI -> 47.0 LPI
    const spec355_34 = computeMeshSpec({ meshTpi: 355, threadDiaUm: 34, ruleOfN: 7.0, dpi: 600 });
    expect(spec355_34.lpiNatural).toBeCloseTo(47.04, 1);

    // 355-40 heavy mesh scaling check (~1.282x openAreaScale)
    const spec355Heavy = computeMeshSpec({ meshTpi: 355, threadDiaUm: 40, ruleOfN: 5.0, dpi: 600 });
    expect(spec355Heavy.openAreaPct).toBeCloseTo(19.44, 1);
    expect(spec355Heavy.openAreaScale).toBeCloseTo(1.282, 2);
    expect(spec355Heavy.lpiNatural).toBeCloseTo(355 / (5.0 * spec355Heavy.openAreaScale), 6);
  });

  it('supports ruleOfN across [2.0, 10.0] in 0.5 increments with monotone LPI and knuckle floor', () => {
    let prevDMin = 0;
    let prevLpi = Infinity;
    for (let n = 2.0; n <= 10.001; n += 0.5) {
      const spec = computeMeshSpec({ meshTpi: 230, ruleOfN: n, dpi: 600 });
      expect(spec.dMinIn).toBeGreaterThanOrEqual(spec.knuckleFloorIn);
      expect(spec.dMinIn).toBeGreaterThanOrEqual(prevDMin - 1e-12);
      if (n >= 4.0) {
        expect(spec.dMinIn).toBeGreaterThan(prevDMin);
      }
      expect(spec.lpiNatural).toBeLessThan(prevLpi);
      prevLpi = spec.lpiNatural;
      prevDMin = spec.dMinIn;
    }
  });

  it('produces exact canonical discrete snapped disk areas D=1..5 -> 1, 4, 9, 12, 21 px', () => {
    expect(getCanonicalDiskOffsets(1).length).toBe(1);
    expect(getCanonicalDiskOffsets(2).length).toBe(4);
    expect(getCanonicalDiskOffsets(3).length).toBe(9);
    expect(getCanonicalDiskOffsets(4).length).toBe(12);
    expect(getCanonicalDiskOffsets(5).length).toBe(21);
  });

  it('enforces ERR_INVALID_MESH_GEOMETRY, ERR_DPI_TOO_LOW, ERR_LPI_EXCEEDS_MESH_LIMIT, WARN_LOW_DPI, WARN_NARROW_AM_RANGE', () => {
    expect(() => computeMeshSpec({ meshTpi: 305, threadDiaUm: 90, dpi: 600 })).toThrowError(
      expect.objectContaining({ code: MeshPhysics.ERR_INVALID_MESH_GEOMETRY })
    );
    expect(() => computeMeshSpec({ meshTpi: -10, dpi: 600 })).toThrowError(
      expect.objectContaining({ code: MeshPhysics.ERR_INVALID_MESH_GEOMETRY })
    );
    expect(() => computeMeshSpec({ meshTpi: 230, ruleOfN: 1.5, dpi: 600 })).toThrowError(
      expect.objectContaining({ code: MeshPhysics.ERR_INVALID_MESH_GEOMETRY })
    );

    expect(() => computeMeshSpec({ meshTpi: 230, dpi: 50 })).toThrowError(
      expect.objectContaining({ code: MeshPhysics.ERR_DPI_TOO_LOW })
    );
    let caughtErr = null;
    try {
      computeMeshSpec({ meshTpi: 355, ruleOfN: 2.0, dpi: 100 });
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).not.toBeNull();
    expect(caughtErr.code).toBe(MeshPhysics.ERR_DPI_TOO_LOW);
    const dpiMatch = caughtErr.message.match(/need >= (\d+) DPI/);
    expect(dpiMatch).not.toBeNull();
    const minNeededDpi = Number(dpiMatch[1]);
    expect(computeMeshSpec({ meshTpi: 355, ruleOfN: 2.0, dpi: minNeededDpi }).dpi).toBe(minNeededDpi);
    expect(() => computeMeshSpec({ meshTpi: 355, ruleOfN: 2.0, dpi: minNeededDpi - 1 })).toThrowError(
      expect.objectContaining({ code: MeshPhysics.ERR_DPI_TOO_LOW })
    );

    const base = computeMeshSpec({ meshTpi: 230, dpi: 600 });
    expect(() =>
      computeMeshSpec({ meshTpi: 230, dpi: 600, lpiOverride: base.lpiMax + 1.0 })
    ).toThrowError(expect.objectContaining({ code: MeshPhysics.ERR_LPI_EXCEEDS_MESH_LIMIT }));

    const lowDpiSpec = computeMeshSpec({ meshTpi: 230, dpi: 200 });
    expect(lowDpiSpec.warnings).toContain(MeshPhysics.WARN_LOW_DPI);

    const narrowAmSpec = computeMeshSpec({
      meshTpi: 230,
      dpi: 600,
      lpiOverride: base.lpiMax * 0.92,
    });
    expect(narrowAmSpec.warnings).toContain(MeshPhysics.WARN_NARROW_AM_RANGE);
  });
});

describe('EuclideanLut', () => {
  it('solves all 256 LUT entries and continuous tones in [pi/8, 0.5] to < 1e-7 area precision', () => {
    expect(EuclideanLut.EUCLIDEAN_LUT.length).toBe(256);
    expect(EuclideanLut.EUCLIDEAN_LUT[0]).toBeCloseTo(1 / (2 * Math.SQRT2), 12);
    expect(EuclideanLut.EUCLIDEAN_LUT[255]).toBeCloseTo(0.5, 12);

    for (let k = 0; k < 256; k++) {
      const target = Math.PI / 8 + (k / 255) * (0.5 - Math.PI / 8);
      const area = EuclideanLut.clippedDiamondArea(EuclideanLut.EUCLIDEAN_LUT[k]);
      expect(Math.abs(area - target)).toBeLessThan(1e-7);
    }

    let prevR = 0;
    for (let s = 0; s <= 2000; s++) {
      const t = (s / 2000) * 0.5;
      const r = EuclideanLut.radiusForDiamondTone(t);
      expect(r).toBeGreaterThanOrEqual(prevR);
      prevR = r;
      const area = EuclideanLut.clippedDiamondArea(r);
      expect(Math.abs(area - t)).toBeLessThan(1e-7);
    }
  });
});

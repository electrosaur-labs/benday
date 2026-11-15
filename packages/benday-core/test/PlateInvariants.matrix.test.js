import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  computeMeshSpec,
  computeRosetteAngles,
  halftoneChannel,
  verifyPlateInvariants,
} = BendayCore;

/**
 * Adversarial synthetic test plate combining:
 *   - Pure 0% paper margin on left
 *   - Full 0..254 continuous horizontal tonal ramp (crossing highlight tail, pi/8 tangency, 50% saddle, shadow tail)
 *   - Sharp step-edge 52% midtone box next to 0% paper pocket (triggers diamond corner tips if unguarded)
 *   - Diagonal 88% shadow bar (triggers clipped dual holes if unguarded)
 *   - 1px 100% M_solid registration crosshairs & hollow bullseye
 */
function buildAdversarialSource(W, H) {
  const src = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < 14) {
        src[y * W + x] = 0;
        continue;
      }
      const ramp = Math.min(254, Math.round(((x - 14) / (W - 15)) * 252));
      src[y * W + x] = ramp;

      // Sharp tonal step box: 52% ink directly abutting 0% paper cutout
      if (y >= 20 && y < 56 && x >= 40 && x < 100) {
        src[y * W + x] = x < 70 ? 133 : 0;
      }

      // Diagonal shadow bar (88% ink)
      if (Math.abs((x - 30) - (y - 10) * 1.3) < 12 && x >= 20) {
        src[y * W + x] = 225;
      }
    }
  }

  // 1px 100% solid registration crosshairs
  for (let x = 3; x < W - 3; x++) src[(H - 10) * W + x] = 255;
  for (let y = 3; y < H - 3; y++) src[y * W + 7] = 255;

  return src;
}

describe('PlateInvariants Matrix Sweep (Zero Sub-Mesh Dots / Zero Shadow Pinholes)', () => {
  const W = 160;
  const H = 110;
  const advSrc = buildAdversarialSource(W, H);

  const meshConfigs = [
    { meshTpi: 110, threadDiaUm: 80 },
    { meshTpi: 230, threadDiaUm: 48 },
    { meshTpi: 305, threadDiaUm: 34 },
    { meshTpi: 355, threadDiaUm: 31 },
    { meshTpi: 420, threadDiaUm: 27 },
  ];
  const rulesOfN = [5.7, 7.0, 8.5];
  const dpis = [300, 600];
  const meshAngles = [0, 18];
  const tailModes = ['hybrid', 'cutoff', 'clamp'];

  it('passes 100% of TPI × N × DPI × Mesh° × RosetteChannel × TailMode combinations with 0 violations', () => {
    let totalPlatesVerified = 0;

    for (const mc of meshConfigs) {
      for (const ruleOfN of rulesOfN) {
        for (const dpi of dpis) {
          const meshSpec = computeMeshSpec({
            meshTpi: mc.meshTpi,
            threadDiaUm: mc.threadDiaUm,
            ruleOfN,
            dpi,
          });

          for (const meshAngleDeg of meshAngles) {
            const angles = computeRosetteAngles(meshAngleDeg);
            for (const tailMode of tailModes) {
              for (const ch of ['C', 'M', 'Y', 'K']) {
                const plate = halftoneChannel(advSrc, W, H, {
                  meshSpec,
                  angleDeg: angles[ch],
                  tailMode,
                  channelKey: ch,
                });

                const report = verifyPlateInvariants(plate, W, H, {
                  dMinPx: meshSpec.dMinPx,
                  aMinPx: meshSpec.aMinPx,
                  cellPitchPx: meshSpec.cellPitchPx,
                  srcUint8: advSrc,
                });

                if (!report.ok) {
                  throw new Error(
                    `Invariant failure [${mc.meshTpi}TPI/${mc.threadDiaUm}um N=${ruleOfN} ${dpi}DPI mesh=${meshAngleDeg}deg ${ch}=${angles[ch]}deg ${tailMode}]: ` +
                      JSON.stringify(report)
                  );
                }
                totalPlatesVerified++;
              }
            }
          }
        }
      }
    }

    expect(totalPlatesVerified).toBe(5 * 3 * 2 * 2 * 3 * 4); // 720 full adversarial plates!
  });

  it('detects synthetic sub-mesh 1px positive dot and 1px enclosed pinhole violations accurately', () => {
    const W2 = 64;
    const H2 = 64;
    const badPlate = new Uint8Array(W2 * H2);
    // Isolated 1px fleck at (10, 10)
    badPlate[10 * W2 + 10] = 255;
    // Large round solid disk centered at (37, 37) of radius 14.3 (spike-free) with a 1px pinhole at (37, 37)
    for (let y = 20; y <= 54; y++) {
      for (let x = 20; x <= 54; x++) {
        if ((x - 37) * (x - 37) + (y - 37) * (y - 37) <= 14.3 * 14.3) {
          badPlate[y * W2 + x] = 255;
        }
      }
    }
    badPlate[37 * W2 + 37] = 0;

    const audit = verifyPlateInvariants(badPlate, W2, H2, { dMinPx: 5 });
    expect(audit.ok).toBe(false);
    expect(audit.minDotViolations).toBe(1);
    expect(audit.minHoleViolations).toBe(1);
  });
});

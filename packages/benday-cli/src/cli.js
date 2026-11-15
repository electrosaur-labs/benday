'use strict';

const fs = require('fs');
const path = require('path');
const {
  computeMeshSpec,
  computeRosetteAngles,
  analyzeMoire,
  halftoneChannel,
  halftoneCmyk,
  verifyPlateInvariants,
} = require('@electrosaur-labs/benday-core');
const { encodeTiff, decodeTiff, encodePgm, decodePgm } = require('./tiffCodec');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (arg === '-o' && argv[i + 1] !== undefined) {
      flags.output = argv[++i];
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function generateSyntheticInput(kind, width, height) {
  const N = width * height;
  const C = new Uint8Array(N);
  const M = new Uint8Array(N);
  const Y = new Uint8Array(N);
  const K = new Uint8Array(N);

  if (kind === 'synthetic:crosshair') {
    for (let x = 8; x < width - 8; x++) K[(height >> 1) * width + x] = 255;
    for (let y = 8; y < height - 8; y++) K[y * width + (width >> 1)] = 255;
    return { width, height, samplesPerPixel: 4, dpi: 600, channels: { C, M, Y, K } };
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (x < 12) continue; // 0% paper margin
      const u = (x - 12) / Math.max(1, width - 13);
      const v = y / Math.max(1, height - 1);
      if (kind === 'synthetic:step') {
        C[p] = x < width >> 1 ? 133 : 0;
        M[p] = y < height >> 1 ? 225 : 40;
        Y[p] = Math.round(u * 200);
        K[p] = x === width - 6 || y === height - 6 ? 255 : 0;
      } else {
        // synthetic:ramp
        C[p] = Math.min(254, Math.round(u * 254));
        M[p] = Math.min(254, Math.round(v * 254));
        Y[p] = Math.min(254, Math.round(0.5 * (u + v) * 254));
        K[p] = y === (height >> 1) ? 255 : Math.min(254, Math.round((1 - u) * 240));
      }
    }
  }

  return { width, height, samplesPerPixel: 4, dpi: 600, channels: { C, M, Y, K } };
}

function readImageFile(inputSpec, flags) {
  if (inputSpec.startsWith('synthetic:')) {
    const w = flags.width ? Number(flags.width) : 200;
    const h = flags.height ? Number(flags.height) : 160;
    return generateSyntheticInput(inputSpec, w, h);
  }
  const buf = fs.readFileSync(inputSpec);
  const ext = path.extname(inputSpec).toLowerCase();
  if (ext === '.pgm') {
    return decodePgm(buf);
  }
  return decodeTiff(buf);
}

function writeImageFile(filePath, data) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pgm') {
    if (!data.gray) {
      throw new Error('PGM output only supports single-channel screens');
    }
    fs.writeFileSync(filePath, encodePgm(data.gray, data.width, data.height));
    return;
  }
  fs.writeFileSync(filePath, encodeTiff(data));
}

function printHelp(log) {
  log(
    [
      'Electrosaur: Benday CLI v0.1.0',
      '',
      'Usage:',
      '  benday halftone <input.tif|input.pgm|synthetic:ramp> -o <output.tif> [options]',
      '  benday verify   <screen.tif|screen.pgm> [options]',
      '  benday spec     [options]',
      '',
      'Options:',
      '  --mesh <tpi>         Mesh threads per inch (default: 230)',
      '  --thread <um>        Thread diameter in µm (default: catalog auto)',
      '  --n <num>            Rule of N threads per cell in [2.0, 10.0] (default: 5.0)',
      '  --dpi <ppi>          Resolution in DPI (default: from TIFF or 600)',
      '  --lpi <lpi>          Optional manual LPI override',
      '  --mesh-angle <deg>   Mesh stretch bias angle in degrees (default: 0)',
      '  --angle <deg>        Single-channel screen angle override (default: 45)',
      '  --tail <mode>        Tail mode: hybrid | cutoff | clamp (default: hybrid)',
      '  --split-screens <d>  Also write individual _C/_M/_Y/_K single-screen TIFFs to directory',
      '  --src <file>         Original continuous-tone input for solid/paper sovereignty audit',
      '  --json               Emit structured JSON output',
    ].join('\n')
  );
}

/**
 * Execute Benday CLI programmatically (returns exitCode and structured result).
 */
function runCli(argv, io = {}) {
  const log = io.stdout || ((msg) => console.log(msg));
  const errLog = io.stderr || ((msg) => console.error(msg));

  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  if (!cmd || flags.help || cmd === 'help') {
    printHelp(log);
    return { exitCode: 0 };
  }

  const meshTpi = flags.mesh != null ? Number(flags.mesh) : 230;
  const threadDiaUm = flags.thread != null ? Number(flags.thread) : undefined;
  const ruleOfN = flags.n != null ? Number(flags.n) : 5.0;
  const lpiOverride = flags.lpi != null ? Number(flags.lpi) : null;
  const meshAngleDeg = flags['mesh-angle'] != null ? Number(flags['mesh-angle']) : 0;
  const tailMode = flags.tail || 'hybrid';

  try {
    if (cmd === 'spec') {
      const dpi = flags.dpi != null ? Number(flags.dpi) : 600;
      const meshSpec = computeMeshSpec({
        meshTpi,
        threadDiaUm,
        ruleOfN,
        dpi,
        lpiOverride,
      });
      const angles = computeRosetteAngles(meshAngleDeg);
      const moireReport = analyzeMoire({
        meshTpi: meshSpec.meshTpi,
        threadDiaUm: meshSpec.threadDiaUm,
        lpi: meshSpec.lpiActive,
        angles,
        meshAngleDeg,
      });

      const payload = { meshSpec, angles, moireReport };
      if (flags.json) {
        log(JSON.stringify(payload, null, 2));
      } else {
        log(
          `Mesh: ${meshSpec.meshTpi} TPI / ${meshSpec.threadDiaUm} µm (open area ${meshSpec.openAreaPct.toFixed(1)}%, scale ${meshSpec.openAreaScale.toFixed(2)}x)`
        );
        log(
          `Min Dot: ${meshSpec.dMinPx} px (${meshSpec.dMinUm.toFixed(1)} µm, area ${meshSpec.aMinPx} px²) @ ${dpi} DPI`
        );
        log(
          `LPI: ${meshSpec.lpiActive.toFixed(2)} active (natural ${meshSpec.lpiNatural.toFixed(2)}, max ${meshSpec.lpiMax.toFixed(2)})`
        );
        log(
          `Rosette: C=${angles.C}° M=${angles.M}° Y=${angles.Y}° K=${angles.K}° (min clearance ${moireReport.minClearanceDeg.toFixed(1)}°, safe=${moireReport.safe})`
        );
      }
      return { exitCode: 0, result: payload };
    }

    if (cmd === 'halftone') {
      const inputPath = positional[1];
      const outputPath = flags.output || positional[2];
      if (!inputPath || !outputPath) {
        errLog('Usage: benday halftone <input> -o <output>');
        return { exitCode: 1 };
      }

      const img = readImageFile(inputPath, flags);
      const dpiOverride = flags.dpi != null ? Number(flags.dpi) : null;
      const dpiX = dpiOverride != null ? dpiOverride : img.dpiX || img.dpi || 600;
      const dpiY = dpiOverride != null ? dpiOverride : img.dpiY || img.dpi || 600;
      const dpi = Math.min(dpiX, dpiY);

      if (img.samplesPerPixel >= 4 && img.channels) {
        const res = halftoneCmyk(img.channels, img.width, img.height, {
          meshTpi,
          threadDiaUm,
          ruleOfN,
          dpi,
          dpiX,
          dpiY,
          lpiOverride,
          meshAngleDeg,
          tailMode,
        });

        writeImageFile(outputPath, {
          width: img.width,
          height: img.height,
          dpi,
          dpiX,
          dpiY,
          channels: res.plates,
        });

        if (flags['split-screens']) {
          const splitDir = flags['split-screens'];
          fs.mkdirSync(splitDir, { recursive: true });
          const stem = path.basename(outputPath, path.extname(outputPath));
          for (const ch of ['C', 'M', 'Y', 'K']) {
            writeImageFile(path.join(splitDir, `${stem}_${ch}.tif`), {
              width: img.width,
              height: img.height,
              dpi,
              dpiX,
              dpiY,
              gray: res.plates[ch],
            });
          }
        }

        const audits = {};
        for (const ch of ['C', 'M', 'Y', 'K']) {
          audits[ch] = verifyPlateInvariants(res.plates[ch], img.width, img.height, {
            dMinPx: res.meshSpec.dMinPx,
            dMinPxX: res.meshSpec.dMinPxX,
            dMinPxY: res.meshSpec.dMinPxY,
            aMinPx: res.meshSpec.aMinPx,
            cellPitchPx: res.meshSpec.cellPitchPx,
            cellPitchPxX: res.meshSpec.cellPitchPxX,
            cellPitchPxY: res.meshSpec.cellPitchPxY,
            srcUint8: img.channels[ch],
          });
        }

        const summary = {
          output: outputPath,
          width: img.width,
          height: img.height,
          dpi,
          dpiX,
          dpiY,
          lpiActive: res.meshSpec.lpiActive,
          dMinPx: res.meshSpec.dMinPx,
          dMinPxX: res.meshSpec.dMinPxX,
          dMinPxY: res.meshSpec.dMinPxY,
          angles: res.angles,
          moireWarnings: res.moireReport.warnings,
          audits,
        };
        if (flags.json) {
          log(JSON.stringify(summary, null, 2));
        } else {
          log(
            `Wrote CMYK halftone ${outputPath} (${img.width}x${img.height} @ ${dpiX === dpiY ? dpi : `${dpiX}x${dpiY}`} DPI, ${res.meshSpec.lpiActive.toFixed(1)} LPI, D_min=${res.meshSpec.dMinPxX === res.meshSpec.dMinPxY ? `${res.meshSpec.dMinPx}px` : `${res.meshSpec.dMinPxX}x${res.meshSpec.dMinPxY}px`})`
          );
        }
        return { exitCode: 0, result: summary };
      }

      // 1-channel grayscale input
      const meshSpec = computeMeshSpec({ meshTpi, threadDiaUm, ruleOfN, dpi, dpiX, dpiY, lpiOverride });
      const angleDeg = flags.angle != null ? Number(flags.angle) : 45;
      const plate = halftoneChannel(img.gray, img.width, img.height, {
        meshSpec,
        angleDeg,
        tailMode,
        channelKey: 'K',
      });
      writeImageFile(outputPath, {
        width: img.width,
        height: img.height,
        dpi,
        dpiX,
        dpiY,
        gray: plate,
      });
      const audit = verifyPlateInvariants(plate, img.width, img.height, {
        dMinPx: meshSpec.dMinPx,
        dMinPxX: meshSpec.dMinPxX,
        dMinPxY: meshSpec.dMinPxY,
        aMinPx: meshSpec.aMinPx,
        cellPitchPx: meshSpec.cellPitchPx,
        cellPitchPxX: meshSpec.cellPitchPxX,
        cellPitchPxY: meshSpec.cellPitchPxY,
        srcUint8: img.gray,
      });
      const summary = { output: outputPath, width: img.width, height: img.height, dpi, dpiX, dpiY, audit };
      if (flags.json) log(JSON.stringify(summary, null, 2));
      else log(`Wrote single-screen halftone ${outputPath} (ok=${audit.ok})`);
      return { exitCode: 0, result: summary };
    }

    if (cmd === 'verify') {
      const platePath = positional[1];
      if (!platePath) {
        errLog('Usage: benday verify <screen.tif|screen.pgm> [options]');
        return { exitCode: 1 };
      }
      const img = readImageFile(platePath, flags);
      const srcImg = flags.src ? readImageFile(flags.src, flags) : null;
      const dpiOverride = flags.dpi != null ? Number(flags.dpi) : null;
      const dpiX = dpiOverride != null ? dpiOverride : img.dpiX || img.dpi || 600;
      const dpiY = dpiOverride != null ? dpiOverride : img.dpiY || img.dpi || 600;
      const dpi = Math.min(dpiX, dpiY);
      const meshSpec = computeMeshSpec({ meshTpi, threadDiaUm, ruleOfN, dpi, dpiX, dpiY, lpiOverride });

      if (img.samplesPerPixel >= 4 && img.channels) {
        const channels = {};
        let allOk = true;
        for (const ch of ['C', 'M', 'Y', 'K']) {
          const rep = verifyPlateInvariants(img.channels[ch], img.width, img.height, {
            dMinPx: meshSpec.dMinPx,
            dMinPxX: meshSpec.dMinPxX,
            dMinPxY: meshSpec.dMinPxY,
            aMinPx: meshSpec.aMinPx,
            cellPitchPx: meshSpec.cellPitchPx,
            cellPitchPxX: meshSpec.cellPitchPxX,
            cellPitchPxY: meshSpec.cellPitchPxY,
            srcUint8: srcImg && srcImg.channels ? srcImg.channels[ch] : undefined,
          });
          channels[ch] = rep;
          if (!rep.ok) allOk = false;
        }
        const report = {
          ok: allOk,
          width: img.width,
          height: img.height,
          dpi,
          dpiX,
          dpiY,
          dMinPx: meshSpec.dMinPx,
          dMinPxX: meshSpec.dMinPxX,
          dMinPxY: meshSpec.dMinPxY,
          channels,
        };
        if (flags.json) log(JSON.stringify(report, null, 2));
        else log(`Verify ${platePath}: ${allOk ? 'PASS' : 'FAIL'} (D_min=${meshSpec.dMinPx}px)`);
        return { exitCode: allOk ? 0 : 1, result: report };
      }

      const rep = verifyPlateInvariants(img.gray, img.width, img.height, {
        dMinPx: meshSpec.dMinPx,
        dMinPxX: meshSpec.dMinPxX,
        dMinPxY: meshSpec.dMinPxY,
        aMinPx: meshSpec.aMinPx,
        cellPitchPx: meshSpec.cellPitchPx,
        cellPitchPxX: meshSpec.cellPitchPxX,
        cellPitchPxY: meshSpec.cellPitchPxY,
        srcUint8: srcImg ? srcImg.gray : undefined,
      });
      if (flags.json) log(JSON.stringify(rep, null, 2));
      else log(`Verify ${platePath}: ${rep.ok ? 'PASS' : 'FAIL'} (D_min=${meshSpec.dMinPx}px)`);
      return { exitCode: rep.ok ? 0 : 1, result: rep };
    }

    errLog(`Unknown subcommand "${cmd}"`);
    return { exitCode: 1 };
  } catch (err) {
    errLog(`Error: ${err.message || err}`);
    return { exitCode: 1, error: err };
  }
}

module.exports = {
  runCli,
};

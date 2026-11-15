'use strict';

const {
  DEFAULT_MESH_TPI,
  RULE_OF_N_DEFAULT,
  RULE_OF_N_MIN,
  RULE_OF_N_MAX,
  getDefaultThreadDiaUm,
} = require('./MeshPhysics');
const { norm90 } = require('./RosetteAngles');

const PRESS_CONFIG_SCHEMA_VERSION = '0.2.0';
const BENDAY_XMP_NS = 'http://electrosaur.org/benday/1.0/';
const BENDAY_XMP_BEGIN = '<!-- BENDAY:BEGIN -->';
const BENDAY_XMP_END = '<!-- BENDAY:END -->';

const VALID_TAIL_MODES = Object.freeze(['hybrid', 'cutoff', 'clamp']);
const VALID_ROSETTE_PRESETS = Object.freeze([
  'auto',
  'image-aware',
  'fta',
  'iso',
  'flamenco',
  'manual',
]);

function clampFinite(val, min, max, fallback) {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function escapeXmlText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXmlText(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Normalize and validate a Benday press configuration object (upgrading v0.1 payloads
 * seamlessly to schemaVersion "0.2.0").
 *
 * @param {string|object} input - JSON string or plain object
 * @returns {object} Normalized press configuration object with schemaVersion "0.2.0"
 */
function parsePressConfig(input) {
  let raw = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('parsePressConfig: empty JSON input');
    }
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`parsePressConfig: malformed JSON (${err.message})`);
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parsePressConfig: expected a JSON object');
  }

  if (raw.schemaVersion != null) {
    if (typeof raw.schemaVersion !== 'string') {
      throw new Error('parsePressConfig: schemaVersion must be a string');
    }
    const major = parseInt(raw.schemaVersion.split('.')[0], 10);
    if (!Number.isFinite(major) || major > 0) {
      throw new Error(`parsePressConfig: unsupported schemaVersion "${raw.schemaVersion}"`);
    }
  }

  // Support either flat root fields or nested { config: { ... } }
  const src =
    raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
      ? raw.config
      : raw;

  if (src.meshTpi != null && !Number.isFinite(Number(src.meshTpi))) {
    throw new Error(`parsePressConfig: invalid meshTpi "${src.meshTpi}"`);
  }
  const meshTpi =
    src.meshTpi == null
      ? DEFAULT_MESH_TPI
      : Math.round(clampFinite(src.meshTpi, 60, 500, DEFAULT_MESH_TPI));

  let threadDiaUm;
  if (src.threadDiaUm == null) {
    threadDiaUm = getDefaultThreadDiaUm(meshTpi);
  } else {
    if (!Number.isFinite(Number(src.threadDiaUm))) {
      throw new Error(`parsePressConfig: invalid threadDiaUm "${src.threadDiaUm}"`);
    }
    threadDiaUm = Math.round(clampFinite(src.threadDiaUm, 20, 150, getDefaultThreadDiaUm(meshTpi)));
  }

  const meshPresetId =
    typeof src.meshPresetId === 'string' && src.meshPresetId.trim()
      ? src.meshPresetId.trim()
      : `${meshTpi}-${threadDiaUm}`;

  if (src.ruleOfN != null && !Number.isFinite(Number(src.ruleOfN))) {
    throw new Error(`parsePressConfig: invalid ruleOfN "${src.ruleOfN}"`);
  }
  const ruleOfN =
    src.ruleOfN == null
      ? RULE_OF_N_DEFAULT
      : clampFinite(src.ruleOfN, RULE_OF_N_MIN, RULE_OF_N_MAX, RULE_OF_N_DEFAULT);

  if (src.meshAngleDeg != null && !Number.isFinite(Number(src.meshAngleDeg))) {
    throw new Error(`parsePressConfig: invalid meshAngleDeg "${src.meshAngleDeg}"`);
  }
  const meshAngleDeg = src.meshAngleDeg == null ? 0 : norm90(Number(src.meshAngleDeg));

  if (src.slopDeg != null && !Number.isFinite(Number(src.slopDeg))) {
    throw new Error(`parsePressConfig: invalid slopDeg "${src.slopDeg}"`);
  }
  const slopDeg = src.slopDeg == null ? 2.0 : clampFinite(src.slopDeg, 0, 10, 2.0);

  let lpiOverride = null;
  if (src.lpiOverride != null) {
    const lo = Number(src.lpiOverride);
    if (!Number.isFinite(lo) || lo <= 0) {
      throw new Error(`parsePressConfig: invalid lpiOverride "${src.lpiOverride}"`);
    }
    lpiOverride = clampFinite(lo, 5, 300, lo);
  }

  const tailMode = src.tailMode == null ? 'hybrid' : String(src.tailMode);
  if (!VALID_TAIL_MODES.includes(tailMode)) {
    throw new Error(
      `parsePressConfig: invalid tailMode "${tailMode}". Expected one of: ${VALID_TAIL_MODES.join(', ')}`
    );
  }

  let anglesOverride = null;
  if (src.anglesOverride != null) {
    if (typeof src.anglesOverride !== 'object' || Array.isArray(src.anglesOverride)) {
      throw new Error('parsePressConfig: anglesOverride must be an object { C, M, Y, K } or null');
    }
    for (const ch of ['C', 'M', 'Y', 'K']) {
      if (!Number.isFinite(Number(src.anglesOverride[ch]))) {
        throw new Error(`parsePressConfig: invalid anglesOverride.${ch}`);
      }
    }
    anglesOverride = {
      C: norm90(Number(src.anglesOverride.C)),
      M: norm90(Number(src.anglesOverride.M)),
      Y: norm90(Number(src.anglesOverride.Y)),
      K: norm90(Number(src.anglesOverride.K)),
    };
  }

  const defaultPreset = anglesOverride ? 'manual' : 'auto';
  const rosettePreset =
    src.rosettePreset == null ? defaultPreset : String(src.rosettePreset);
  if (!VALID_ROSETTE_PRESETS.includes(rosettePreset)) {
    throw new Error(
      `parsePressConfig: invalid rosettePreset "${rosettePreset}". Expected one of: ${VALID_ROSETTE_PRESETS.join(', ')}`
    );
  }

  if (src.dotGain != null && !Number.isFinite(Number(src.dotGain))) {
    throw new Error(`parsePressConfig: invalid dotGain "${src.dotGain}"`);
  }
  const dotGain = src.dotGain == null ? 0 : clampFinite(src.dotGain, 0, 20, 0);

  const isLegacyV01 =
    typeof raw.schemaVersion === 'string' && raw.schemaVersion.trim().startsWith('0.1');
  let bvg = !isLegacyV01;
  if (src.bvg != null) {
    if (typeof src.bvg === 'boolean') {
      bvg = src.bvg;
    } else if (src.bvg === 0 || src.bvg === 1) {
      bvg = Boolean(src.bvg);
    } else {
      throw new Error(`parsePressConfig: invalid bvg "${src.bvg}" (expected boolean)`);
    }
  }

  const meta =
    raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)
      ? { ...raw.meta }
      : {};

  return {
    tool: 'electrosaur-benday',
    schemaVersion: PRESS_CONFIG_SCHEMA_VERSION,
    meshTpi,
    threadDiaUm,
    meshPresetId,
    ruleOfN,
    meshAngleDeg,
    slopDeg,
    lpiOverride,
    tailMode,
    rosettePreset,
    anglesOverride: rosettePreset === 'manual' ? anglesOverride : anglesOverride,
    dotGain,
    bvg,
    meta,
  };
}

/**
 * Serialize a press configuration into a deterministic, human-readable JSON string
 * conforming to PRESS_CONFIG_SCHEMA_VERSION ("0.2.0").
 *
 * @param {object} config
 * @param {object} [meta]
 * @returns {string}
 */
function serializePressConfig(config = {}, meta = undefined) {
  const merged = meta !== undefined ? { ...config, meta: { ...(config.meta || {}), ...meta } } : config;
  const normalized = parsePressConfig(merged);
  const payload = {
    tool: 'electrosaur-benday',
    schemaVersion: PRESS_CONFIG_SCHEMA_VERSION,
    meshTpi: normalized.meshTpi,
    threadDiaUm: normalized.threadDiaUm,
    meshPresetId: normalized.meshPresetId,
    ruleOfN: normalized.ruleOfN,
    meshAngleDeg: normalized.meshAngleDeg,
    slopDeg: normalized.slopDeg,
    lpiOverride: normalized.lpiOverride,
    tailMode: normalized.tailMode,
    rosettePreset: normalized.rosettePreset,
    anglesOverride: normalized.anglesOverride,
    dotGain: normalized.dotGain,
    bvg: normalized.bvg,
  };
  if (normalized.meta && Object.keys(normalized.meta).length > 0) {
    payload.meta = normalized.meta;
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * Inject a serialized Benday press configuration JSON manifest idempotently into
 * a Photoshop XMP metadata packet (`<!-- BENDAY:BEGIN -->...<!-- BENDAY:END -->`).
 *
 * @param {string} existingXmp
 * @param {string|object} configOrJson
 * @returns {string}
 */
function embedPressConfigInXmp(existingXmp, configOrJson) {
  const jsonStr =
    typeof configOrJson === 'string'
      ? serializePressConfig(parsePressConfig(configOrJson))
      : serializePressConfig(configOrJson);

  const compactJson = JSON.stringify(JSON.parse(jsonStr));
  const block =
    `         ${BENDAY_XMP_BEGIN}\n` +
    `         <benday:pressConfig>${escapeXmlText(compactJson)}</benday:pressConfig>\n` +
    `         ${BENDAY_XMP_END}`;

  let base = typeof existingXmp === 'string' ? existingXmp : '';
  if (!base.includes('<rdf:Description')) {
    base =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
      '   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
      `      <rdf:Description rdf:about="" xmlns:benday="${BENDAY_XMP_NS}">\n` +
      '      </rdf:Description>\n' +
      '   </rdf:RDF>\n' +
      '</x:xmpmeta>';
  }

  // Strip any prior BENDAY block idempotently
  let modified = base.replace(/\n? *<!-- BENDAY:BEGIN -->[\s\S]*?<!-- BENDAY:END -->\n?/g, '');

  if (!modified.includes('xmlns:benday=')) {
    modified = modified.replace(
      /(<rdf:Description\b[^>]*?)(\/?>)/,
      `$1\n            xmlns:benday="${BENDAY_XMP_NS}"$2`
    );
  }

  if (modified.includes('</rdf:Description>')) {
    modified = modified.replace('</rdf:Description>', `${block}\n      </rdf:Description>`);
  } else {
    modified = modified.replace(
      /(<rdf:Description\b[^>]*?)\s*\/>/,
      `$1>\n${block}\n      </rdf:Description>`
    );
  }

  return modified;
}

/**
 * Extract and parse a Benday press configuration from a Photoshop XMP metadata packet,
 * or return null if no Benday manifest is present.
 *
 * @param {string} xmpString
 * @returns {object|null}
 */
function extractPressConfigFromXmp(xmpString) {
  if (typeof xmpString !== 'string' || !xmpString.includes(BENDAY_XMP_BEGIN)) {
    return null;
  }
  const match = xmpString.match(
    /<!-- BENDAY:BEGIN -->[\s\S]*?<benday:pressConfig>([\s\S]*?)<\/benday:pressConfig>[\s\S]*?<!-- BENDAY:END -->/
  );
  if (!match || !match[1]) return null;
  try {
    const jsonText = unescapeXmlText(match[1].trim());
    return parsePressConfig(jsonText);
  } catch (_) {
    return null;
  }
}

module.exports = {
  PRESS_CONFIG_SCHEMA_VERSION,
  BENDAY_XMP_NS,
  BENDAY_XMP_BEGIN,
  BENDAY_XMP_END,
  VALID_TAIL_MODES,
  VALID_ROSETTE_PRESETS,
  parsePressConfig,
  serializePressConfig,
  embedPressConfigInXmp,
  extractPressConfigFromXmp,
};

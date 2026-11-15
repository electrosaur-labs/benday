import { describe, it, expect } from 'vitest';
import BendayCore from '../index.js';

const {
  PRESS_CONFIG_SCHEMA_VERSION,
  BENDAY_XMP_BEGIN,
  BENDAY_XMP_END,
  serializePressConfig,
  parsePressConfig,
  embedPressConfigInXmp,
  extractPressConfigFromXmp,
} = BendayCore;

describe('PressConfig (.benday.json & XMP Manifest Round-Trip)', () => {
  it('round-trips complete v0.2 press configurations deterministically', () => {
    expect(PRESS_CONFIG_SCHEMA_VERSION).toBe('0.2.0');

    const input = {
      meshTpi: 305,
      threadDiaUm: 34,
      meshPresetId: '305-34',
      ruleOfN: 6.0,
      meshAngleDeg: 18,
      slopDeg: 2.0,
      lpiOverride: 55,
      tailMode: 'hybrid',
      rosettePreset: 'image-aware',
      anglesOverride: null,
      dotGain: 12,
      bvg: true,
    };

    const json = serializePressConfig(input, { savedBy: 'vitest' });
    const parsed = parsePressConfig(json);

    expect(parsed).toMatchObject({
      tool: 'electrosaur-benday',
      schemaVersion: '0.2.0',
      meshTpi: 305,
      threadDiaUm: 34,
      meshPresetId: '305-34',
      ruleOfN: 6.0,
      meshAngleDeg: 18,
      slopDeg: 2.0,
      lpiOverride: 55,
      tailMode: 'hybrid',
      rosettePreset: 'image-aware',
      anglesOverride: null,
      dotGain: 12,
      bvg: true,
      meta: { savedBy: 'vitest' },
    });
  });

  it('upgrades v0.1 payloads seamlessly, defaults omitted meshTpi to 355-31, and clamps out-of-bounds numeric fields', () => {
    const emptyDefaults = parsePressConfig({});
    expect(emptyDefaults.meshTpi).toBe(355);
    expect(emptyDefaults.threadDiaUm).toBe(31);
    expect(emptyDefaults.meshPresetId).toBe('355-31');

    const legacyV01 = {
      schemaVersion: '0.1.0',
      meshTpi: 230,
      ruleOfN: 5.0,
      tailMode: 'clamp',
      anglesOverride: { C: -15, M: 75, Y: 60, K: 45 },
    };

    const upgraded = parsePressConfig(legacyV01);
    expect(upgraded.schemaVersion).toBe('0.2.0');
    expect(upgraded.dotGain).toBe(0);
    expect(upgraded.bvg).toBe(false);
    expect(upgraded.rosettePreset).toBe('manual');
    expect(upgraded.anglesOverride).toEqual({ C: 75, M: 75, Y: 60, K: 45 });

    const clamped = parsePressConfig({
      meshTpi: 999,
      ruleOfN: 99,
      dotGain: 45,
      meshAngleDeg: -10,
    });
    expect(clamped.meshTpi).toBe(500);
    expect(clamped.ruleOfN).toBe(10.0);
    expect(clamped.dotGain).toBe(20);
    expect(clamped.meshAngleDeg).toBe(80);
  });

  it('rejects malformed JSON, unsupported future major versions, and invalid enum values', () => {
    expect(() => parsePressConfig('')).toThrow(/empty JSON/i);
    expect(() => parsePressConfig('{not-json')).toThrow(/malformed JSON/i);
    expect(() => parsePressConfig({ schemaVersion: '1.0.0' })).toThrow(/unsupported schemaVersion/i);
    expect(() => parsePressConfig({ tailMode: 'unknown' })).toThrow(/invalid tailMode/i);
    expect(() => parsePressConfig({ rosettePreset: 'bogus' })).toThrow(/invalid rosettePreset/i);
    expect(() => parsePressConfig({ bvg: 'yes' })).toThrow(/invalid bvg/i);
  });

  it('embeds and extracts XMP manifests idempotently on standard, self-closing, and empty packets', () => {
    const psXmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
            xmlns:dc="http://purl.org/dc/elements/1.1/">
         <dc:format>application/vnd.adobe.photoshop</dc:format>
      </rdf:Description>
   </rdf:RDF>
</x:xmpmeta>`;

    const xmp1 = embedPressConfigInXmp(psXmp, {
      meshTpi: 280,
      threadDiaUm: 34,
      dotGain: 8,
      bvg: true,
      rosettePreset: 'fta',
    });
    expect(xmp1).toContain(BENDAY_XMP_BEGIN);
    expect(xmp1).toContain(BENDAY_XMP_END);

    // Re-write idempotently with updated dotGain = 14
    const xmp2 = embedPressConfigInXmp(xmp1, {
      meshTpi: 355,
      threadDiaUm: 31,
      dotGain: 14,
      bvg: false,
      rosettePreset: 'image-aware',
    });
    expect(xmp2.match(/<!-- BENDAY:BEGIN -->/g).length).toBe(1);

    const extracted = extractPressConfigFromXmp(xmp2);
    expect(extracted).toMatchObject({
      meshTpi: 355,
      threadDiaUm: 31,
      dotGain: 14,
      bvg: false,
      rosettePreset: 'image-aware',
    });

    // Self-closing <rdf:Description ... /> packet
    const selfClosing = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>`;
    const xmpSelf = embedPressConfigInXmp(selfClosing, { dotGain: 11 });
    expect(extractPressConfigFromXmp(xmpSelf).dotGain).toBe(11);

    // Empty packet fallback
    const xmpEmpty = embedPressConfigInXmp('', { dotGain: 6 });
    expect(extractPressConfigFromXmp(xmpEmpty).dotGain).toBe(6);
    expect(extractPressConfigFromXmp('<x:xmpmeta></x:xmpmeta>')).toBeNull();
  });
});

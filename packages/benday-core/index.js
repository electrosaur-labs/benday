'use strict';

const MeshPhysics = require('./lib/MeshPhysics');
const RosetteAngles = require('./lib/RosetteAngles');
const EuclideanLut = require('./lib/EuclideanLut');
const HalftoneEngine = require('./lib/HalftoneEngine');
const PlateVerifier = require('./lib/PlateVerifier');
const BvgEdgeSnapper = require('./lib/BvgEdgeSnapper');
const PressConfig = require('./lib/PressConfig');
const HvsQuality = require('./lib/HvsQuality');

module.exports = {
  MeshPhysics,
  RosetteAngles,
  EuclideanLut,
  HalftoneEngine,
  PlateVerifier,
  HalftoneVerifier: PlateVerifier,
  BvgEdgeSnapper,
  PressConfig,
  HvsQuality,

  // Top-level convenience exports
  DEFAULT_MESH_TPI: MeshPhysics.DEFAULT_MESH_TPI,
  DEFAULT_THREAD_UM: MeshPhysics.DEFAULT_THREAD_UM,
  STANDARD_THREAD_UM: MeshPhysics.STANDARD_THREAD_UM,
  STANDARD_MESH_TPI: MeshPhysics.STANDARD_MESH_TPI,
  SAATI_MESH_PRESETS: MeshPhysics.SAATI_MESH_PRESETS,
  F_OPEN_REF: MeshPhysics.F_OPEN_REF,
  BendayError: MeshPhysics.BendayError,
  getDefaultThreadDiaUm: MeshPhysics.getDefaultThreadDiaUm,
  getCanonicalDiskOffsets: MeshPhysics.getCanonicalDiskOffsets,
  computeMeshSpec: MeshPhysics.computeMeshSpec,

  ROSETTE_PRESETS: RosetteAngles.ROSETTE_PRESETS,
  ROSETTE_PRESET_IDS: RosetteAngles.ROSETTE_PRESET_IDS,
  norm90: RosetteAngles.norm90,
  clearance90: RosetteAngles.clearance90,
  computeRosetteAngles: RosetteAngles.computeRosetteAngles,
  assignImageAwareRosetteSlots: RosetteAngles.assignImageAwareRosetteSlots,
  resolveRosettePresetAngles: RosetteAngles.resolveRosettePresetAngles,
  besselJ1: RosetteAngles.besselJ1,
  analyzeMoire: RosetteAngles.analyzeMoire,

  EUCLIDEAN_LUT: EuclideanLut.EUCLIDEAN_LUT,
  clippedDiamondArea: EuclideanLut.clippedDiamondArea,
  radiusForDiamondTone: EuclideanLut.radiusForDiamondTone,

  applyDotGainPullback: HalftoneEngine.applyDotGainPullback,
  halftoneChannel: HalftoneEngine.halftoneChannel,
  halftoneCmyk: HalftoneEngine.halftoneCmyk,

  snapChannelEdges: BvgEdgeSnapper.snapChannelEdges,
  snapCmykEdges: BvgEdgeSnapper.snapCmykEdges,

  PRESS_CONFIG_SCHEMA_VERSION: PressConfig.PRESS_CONFIG_SCHEMA_VERSION,
  BENDAY_XMP_BEGIN: PressConfig.BENDAY_XMP_BEGIN,
  BENDAY_XMP_END: PressConfig.BENDAY_XMP_END,
  serializePressConfig: PressConfig.serializePressConfig,
  parsePressConfig: PressConfig.parsePressConfig,
  embedPressConfigInXmp: PressConfig.embedPressConfigInXmp,
  extractPressConfigFromXmp: PressConfig.extractPressConfigFromXmp,

  BINARY_SWOP_LAB16: HvsQuality.BINARY_SWOP_LAB16,
  cmykToLab16Buffer: HvsQuality.cmykToLab16Buffer,
  computeGrayStepsPerCell: HvsQuality.computeGrayStepsPerCell,
  computeHvsQuality: HvsQuality.computeHvsQuality,

  verifyPlateInvariants: PlateVerifier.verifyPlateInvariants,
  verifyScreenInvariants: PlateVerifier.verifyScreenInvariants,
};

'use strict';

const MeshPhysics = require('./lib/MeshPhysics');
const RosetteAngles = require('./lib/RosetteAngles');
const EuclideanLut = require('./lib/EuclideanLut');
const HalftoneEngine = require('./lib/HalftoneEngine');
const PlateVerifier = require('./lib/PlateVerifier');

module.exports = {
  MeshPhysics,
  RosetteAngles,
  EuclideanLut,
  HalftoneEngine,
  PlateVerifier,
  HalftoneVerifier: PlateVerifier,

  // Top-level convenience exports
  STANDARD_THREAD_UM: MeshPhysics.STANDARD_THREAD_UM,
  STANDARD_MESH_TPI: MeshPhysics.STANDARD_MESH_TPI,
  SAATI_MESH_PRESETS: MeshPhysics.SAATI_MESH_PRESETS,
  F_OPEN_REF: MeshPhysics.F_OPEN_REF,
  BendayError: MeshPhysics.BendayError,
  getDefaultThreadDiaUm: MeshPhysics.getDefaultThreadDiaUm,
  getCanonicalDiskOffsets: MeshPhysics.getCanonicalDiskOffsets,
  computeMeshSpec: MeshPhysics.computeMeshSpec,

  norm90: RosetteAngles.norm90,
  clearance90: RosetteAngles.clearance90,
  computeRosetteAngles: RosetteAngles.computeRosetteAngles,
  besselJ1: RosetteAngles.besselJ1,
  analyzeMoire: RosetteAngles.analyzeMoire,

  EUCLIDEAN_LUT: EuclideanLut.EUCLIDEAN_LUT,
  clippedDiamondArea: EuclideanLut.clippedDiamondArea,
  radiusForDiamondTone: EuclideanLut.radiusForDiamondTone,

  halftoneChannel: HalftoneEngine.halftoneChannel,
  halftoneCmyk: HalftoneEngine.halftoneCmyk,

  verifyPlateInvariants: PlateVerifier.verifyPlateInvariants,
};

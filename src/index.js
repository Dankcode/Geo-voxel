// geo-voxels — real places (OpenStreetMap + USGS 3DEP via Blender/BlenderGIS) → straight-street voxel maps.
export { buildPlace, distBox } from './build.js';
export { rectifyNetwork, orthogonalizeRing, weightedGridAngle, simplify } from './rectify.js';
export { geoFrame, groundModel, heightfield, plateauAndRelax, rasterPolygon, polygonArea, distToPolyline, dominantAngle, pointInPolygon, METRES_PER_CELL } from './frame.js';
export { largestRectangle, decomposeFootprint, cleanMask, resolveParty, MIN_WING } from './footprint.js';
export { planGeoRoadPaint } from './roadPaint.js';
export { roadSpec, roadWidthMetres, storeysFromTags, programFor, isRetailArea, ROAD_CLASS } from './osm.js';
export { VoxelGrid, PALETTE, M } from './grid.js';
export { toVox, toSlatePNG } from './export.js';
// Town engine (engine/, synced from voxel-tactics): procedural operations, large districts and full real places
export { generate, toResult, GENERATORS, ENGINE_PALETTE } from './town.js';
export { tactics } from './plugins/tactics.js';
export { toVox as toVoxBytes } from './vox.js';
// Building prefabs: bake any building of an engine map, stamp it (rotated / mirrored) into another map or lot
export { bakePrefab, bakePlacePrefabs, stampPrefab, transformFor, PREFAB_FORMAT } from '../engine/mapgen/geo/BuildingPrefab.js';
export { registerPrefab, getPrefab, findPrefabs, placePrefabInLot } from '../engine/mapgen/geo/PrefabLibrary.js';

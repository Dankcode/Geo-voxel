// geo-voxels — real places (OpenStreetMap + USGS 3DEP via Blender/BlenderGIS) → straight-street voxel maps.
export { buildPlace, distBox } from './build.js';
export { rectifyNetwork, orthogonalizeRing, weightedGridAngle, simplify } from './rectify.js';
export { geoFrame, groundModel, heightfield, plateauAndRelax, rasterPolygon, polygonArea, distToPolyline, dominantAngle, pointInPolygon, METRES_PER_CELL } from './frame.js';
export { largestRectangle, decomposeFootprint, cleanMask, resolveParty, MIN_WING } from './footprint.js';
export { planGeoRoadPaint } from './roadPaint.js';
export { roadSpec, roadWidthMetres, storeysFromTags, programFor, isRetailArea, ROAD_CLASS } from './osm.js';
export { VoxelGrid, PALETTE, M } from './grid.js';
export { toVox, toSlatePNG } from './export.js';

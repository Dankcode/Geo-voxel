# Data in this repository

`examples/*/blender-export.json` were produced by `blender/blender_geo_import.py` (Baton Rouge, Louisiana and
Philadelphia, Pennsylvania) and contain:

- **OpenStreetMap** building outlines, ways and land-use areas — © OpenStreetMap contributors, available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Maps and voxel grids built from
  them are Produced Works: credit "© OpenStreetMap contributors"; changes to the data itself must be shared under ODbL.
- **Wikidata** facts in each export's `context.wikidata` (floors, height, style, inception, heritage, labels) —
  [CC0](https://creativecommons.org/publicdomain/zero/1.0/), no attribution required.
- **USGS 3D Elevation Program (3DEP)** 1/3 arc-second bare-earth samples, fetched through the OpenTopography API — U.S.
  Geological Survey data, public domain. Suggested credit: "USGS 3D Elevation Program, via OpenTopography".

The `docs/img` slates and screenshots are derived from the same data.

`examples/live-third-street/source.json` was fetched by the Place Builder (`src/live/fetchPlace.js`) in a browser on
2026-10-21 and contains:

- **OpenStreetMap** data from one Overpass API request — © OpenStreetMap contributors, ODbL 1.0 (as above).
- **Terrain** sampled from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium encoding);
  in the US the source is USGS 3DEP (public domain). Elsewhere the tiles combine SRTM, GMTED, ETOPO1 and national
  models — see the [tile sources and attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Wikimedia Commons** photo references (title, link, author, licence) — the photos themselves are not copied; each
  carries its own licence on Commons.

Live fetches you make also use **Wikipedia** summaries (CC BY-SA 4.0; credit the article) and Wikidata (CC0).

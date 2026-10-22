"""Geo import, Blender stage (experiment) — run inside Blender 5.x with BlenderGIS enabled (e.g. through the Blender MCP:
    exec(open('<repo>/tools/geo/blender_geo_import.py').read()); start(lat=30.4497, lon=-91.1874, ...)

Steps (each a timer so the UI and the MCP bridge stay responsive):
  1. a georeferenced scene (UTM zone from the longitude, origin at lat/lon) and an extent plane
  2. BlenderGIS "Get SRTM" against an OpenTopography source: dem='USGS10m' (3DEP bare earth, US) or 'SRTMGL1' (global
     surface model). The API key lives in the BlenderGIS preferences, never in the repo
  3. BlenderGIS "Get OSM" (buildings extruded by levels/height, dropped on the DEM; highways, landuse, amenity)
  4. context: one Overpass request (tenants/amenities, building:part, street furniture) + ≤ 2 Wikidata requests for
     named landmarks (floors, height, style, inception, architect, heritage) → <out>/context.json (skipped on failure)
  5. export <out>/blender-export.json (footprint rings, highway centrelines, parking/landuse rings, DEM samples, tags,
     and the context)
  6. a top-down Workbench render <out>/reference-topdown.png (the mapgen --image reference)
Progress is written to <out>/geo-status.json. Nothing in the repo or the add-on is modified.
"""
import bpy, bmesh, json, os, sys, math, importlib, traceback, urllib.request, urllib.parse

PKG = 'BlenderGIS-master' if 'BlenderGIS-master' in bpy.context.preferences.addons else 'BlenderGIS'
STATE = {}


def _status(**kw):
    STATE.update(kw)
    with open(os.path.join(STATE['out'], 'geo-status.json'), 'w') as f:
        json.dump({k: v for k, v in STATE.items() if k not in ('ctx',)}, f, indent=1)


def _patch_overpass_user_agent():
    # Overpass answers 406 to requests without a User-Agent; BlenderGIS's bundled overpy sends none by default.
    ov = sys.modules.get(f'{PKG}.operators.lib.osm.overpy')
    if not ov or getattr(ov.urlopen, '_geo_patched', False):
        return
    orig = urllib.request.urlopen

    def ua_urlopen(req, data=None, *a, **k):
        if isinstance(req, str):
            req = urllib.request.Request(req)
        req.add_header('User-Agent', 'BlenderGIS (voxel-tactics geo import)')
        return orig(req, data, *a, **k)
    ua_urlopen._geo_patched = True
    ov.urlopen = ua_urlopen


def _ctx(scn, ob):
    win = bpy.context.window_manager.windows[0]
    win.scene = scn
    area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
    region = next(r for r in area.regions if r.type == 'WINDOW')
    vl = scn.view_layers[0]
    for o in scn.objects:
        o.select_set(False, view_layer=vl)
    ob.select_set(True, view_layer=vl)
    vl.objects.active = ob
    return dict(window=win, area=area, region=region, scene=scn, view_layer=vl, active_object=ob, object=ob, selected_objects=[ob])


def _setup():
    gs = importlib.import_module(f'{PKG}.geoscene')
    scn = bpy.data.scenes.get(STATE['scene']) or bpy.data.scenes.new(STATE['scene'])
    for o in list(scn.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    geo = gs.GeoScene(scn)
    zone = int((STATE['lon'] + 180) // 6) + 1
    geo.crs = f"EPSG:{32600 + zone if STATE['lat'] >= 0 else 32700 + zone}"
    geo.setOriginGeo(STATE['lon'], STATE['lat'])
    X0, X1, Y0, Y1 = STATE['extent']
    me = bpy.data.meshes.new('GeoExtent')
    me.from_pydata([(X0, Y0, 0), (X1, Y0, 0), (X1, Y1, 0), (X0, Y1, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('GeoExtent', me)
    scn.collection.objects.link(ob)
    if STATE.get('save_blend'):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(STATE['out'], STATE['save_blend']))
    _status(stage='setup', crs=geo.crs, origin=[geo.lon, geo.lat, geo.crsx, geo.crsy], extent_obj=ob.name)
    return scn, ob


DEM_SERVERS = {
    # OpenTopography global SRTM (a surface model: towers and trees are in it) — BlenderGIS's default
    'SRTMGL1': 'https://portal.opentopography.org/API/globaldem?demtype=SRTMGL1&west={W}&east={E}&south={S}&north={N}&outputFormat=GTiff&API_Key={API_KEY}',
    # USGS 3DEP bare-earth DTM through OpenTopography (US only; 10 m and 30 m are open to every free API key)
    'USGS10m': 'https://portal.opentopography.org/API/usgsdem?datasetName=USGS10m&south={S}&north={N}&west={W}&east={E}&outputFormat=GTiff&API_Key={API_KEY}',
    'USGS30m': 'https://portal.opentopography.org/API/usgsdem?datasetName=USGS30m&south={S}&north={N}&west={W}&east={E}&outputFormat=GTiff&API_Key={API_KEY}',
}


def _use_dem_server(name):
    prefs = bpy.context.preferences.addons[PKG].preferences
    url = DEM_SERVERS[name]
    items = json.loads(prefs.demServerJson)
    if not any(i[0] == url for i in items):
        items.append([url, f'OpenTopography {name}', f'OpenTopography {name} ({"bare earth" if name.startswith("USGS") else "surface"})'])
        prefs.demServerJson = json.dumps(items)
    prefs.demServer = url


def _dem(scn, ob):
    _use_dem_server(STATE.get('dem', 'SRTMGL1'))
    with bpy.context.temp_override(**_ctx(scn, ob)):
        r = bpy.ops.importgis.dem_query()
    _status(stage='dem', dem_result=str(r))


def _osm(scn, ob):
    _patch_overpass_user_agent()
    mod = sys.modules[f'{PKG}.operators.io_import_osm']
    mod.OSMTAGS = sorted(set(list(getattr(mod, 'OSMTAGS', [])) + ['building', 'highway', 'landuse', 'leisure', 'amenity']))
    meshes = [o for o in scn.objects if o.type == 'MESH']
    elev = str(meshes.index(ob)) if ob in meshes else '0'
    prefs = bpy.context.preferences.addons[PKG].preferences
    mirrors = [i.identifier for i in prefs.bl_rna.properties['overpassServer'].enum_items] if hasattr(prefs.bl_rna.properties['overpassServer'], 'enum_items') else []
    mirrors = [m for m in [prefs.overpassServer] + mirrors if m] or [None]
    last = None
    for attempt, mirror in enumerate([m for i, m in enumerate(mirrors) if m not in mirrors[:i]] * 2):
        # Overpass mirrors answer 502/504 when busy: try the next one (each mirror twice at most)
        try:
            if mirror:
                prefs.overpassServer = mirror
            with bpy.context.temp_override(**_ctx(scn, ob)):
                r = bpy.ops.importgis.osm_query(filterTags={'building', 'highway', 'landuse', 'leisure', 'amenity'}, featureType={'way', 'relation'},
                                                separate=True, buildingsExtrusion=True, defaultHeight=6, levelHeight=3, useElevObj=True, objElevLst=elev)
            _status(stage='osm', osm=str(r), overpass=mirror, attempts=attempt + 1)
            return
        except RuntimeError as e:
            last = e
            _status(stage='osm-retry', overpass=mirror, attempt=attempt + 1, error=str(e)[-300:])
    raise last


# ---------------------------------------------------------------------------------------------- context (small, keyless)
# One Overpass request for what is inside and around the buildings (tenants, amenities, 3D building parts, street
# furniture) and at most two Wikidata requests for named landmarks. Everything is projected to the scene's metres.
CONTEXT_QUERY = """[out:json][timeout:90][bbox:{s},{w},{n},{e}];
(
  node[~"^(shop|amenity|office|tourism|craft|leisure|historic|healthcare|club|place_of_worship)$"~"."];
  way[~"^(shop|amenity|office|tourism|craft|healthcare|historic)$"~"."];
  way["building:part"]; relation["type"="building"];
  way["building"]["wikidata"]; way["building"]["name"]; way["building"]["roof:shape"]; way["building"]["building:colour"];
  node["highway"~"^(traffic_signals|bus_stop|street_lamp|crossing|stop)$"];
  node["natural"="tree"]; node["emergency"="fire_hydrant"]; node["power"="pole"];
  node["amenity"~"^(bench|waste_basket|bicycle_parking|post_box|vending_machine)$"];
  node["man_made"~"^(flagpole|street_cabinet|monitoring_station)$"];
);
out tags geom;"""
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
UA = 'geo-voxels (BlenderGIS; github.com/Dankcode/Geo-voxel)'


def _http(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf8'))


def _projector(scn):
    gs = importlib.import_module(f'{PKG}.geoscene')
    geo = gs.GeoScene(scn)
    try:
        proj = importlib.import_module(f'{PKG}.core.proj')
        epsg = int(str(geo.crs).split(':')[-1])
        def fwd(lon, lat):
            x, y = proj.reprojPt(4326, epsg, lon, lat)
            return [round(x - geo.crsx, 2), round(y - geo.crsy, 2)]
        def inv(x, y):
            lon, lat = proj.reprojPt(epsg, 4326, x + geo.crsx, y + geo.crsy)
            return lon, lat
        return fwd, inv
    except Exception:
        # equirectangular fallback around the origin (sub-metre over a few hundred metres)
        lat0, lon0 = STATE['lat'], STATE['lon']; k = 111320.0
        return (lambda lon, lat: [round((lon - lon0) * k * math.cos(math.radians(lat0)), 2), round((lat - lat0) * k, 2)],
                lambda x, y: (lon0 + x / (k * math.cos(math.radians(lat0))), lat0 + y / k))


def _wikidata(qids):
    """{ QID: { label, description, instanceOf, floors, floorsBelow, heightM, style, inception, architect, heritage, image } }"""
    qids = sorted(set(q for q in qids if q and q.startswith('Q')))[:50]
    if not qids:
        return {}
    api = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=labels|descriptions|claims&ids='
    ents = _http(api + '|'.join(qids)).get('entities', {})
    def vals(c, p):
        out = []
        for s in c.get(p, []):
            dv = s.get('mainsnak', {}).get('datavalue', {}).get('value')
            if dv is not None:
                out.append(dv)
        return out
    ref = set()
    facts = {}
    for q, e in ents.items():
        c = e.get('claims', {})
        f = {'label': e.get('labels', {}).get('en', {}).get('value'), 'description': e.get('descriptions', {}).get('en', {}).get('value')}
        for key, p in (('instanceOf', 'P31'), ('style', 'P149'), ('architect', 'P84'), ('heritage', 'P1435')):
            ids = [v['id'] for v in vals(c, p) if isinstance(v, dict) and 'id' in v]
            f[key] = ids; ref.update(ids)
        for key, p in (('floors', 'P1101'), ('floorsBelow', 'P1139'), ('heightM', 'P2048')):
            v = vals(c, p)
            if v and isinstance(v[0], dict) and 'amount' in v[0]:
                n = float(v[0]['amount'])
                if key == 'heightM' and 'Q3710' in v[0].get('unit', ''):   # feet
                    n *= 0.3048
                f[key] = round(n, 1)
        t = vals(c, 'P571')
        if t and isinstance(t[0], dict):
            f['inception'] = t[0].get('time', '')[1:5]
        img = vals(c, 'P18')
        if img:
            f['image'] = img[0]
        facts[q] = f
    if ref:
        lab = _http('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=labels&ids=' + '|'.join(sorted(ref)[:50])).get('entities', {})
        name = lambda i: lab.get(i, {}).get('labels', {}).get('en', {}).get('value', i)
        for f in facts.values():
            for key in ('instanceOf', 'style', 'architect', 'heritage'):
                f[key] = [name(i) for i in f.get(key, [])]
    return facts


def _context(scn, ob):
    fwd, inv = _projector(scn)
    X0, X1, Y0, Y1 = STATE['extent']
    w, s = inv(X0, Y0); e, n = inv(X1, Y1)
    q = CONTEXT_QUERY.format(s=round(s, 6), w=round(w, 6), n=round(n, 6), e=round(e, 6))
    data, last = None, None
    for url in OVERPASS:
        try:
            data = _http(url, data=urllib.parse.urlencode({'data': q}).encode())
            _status(stage='context', context_server=url)
            break
        except Exception as ex:
            last = ex
            _status(stage='context-retry', context_server=url, error=str(ex)[-300:])
    if data is None:
        raise last
    pois, parts, buildings, furniture = [], [], [], []
    FURN = {'traffic_signals', 'bus_stop', 'street_lamp', 'crossing', 'stop', 'tree', 'fire_hydrant', 'pole', 'bench', 'waste_basket', 'bicycle_parking', 'post_box', 'vending_machine', 'flagpole', 'street_cabinet', 'monitoring_station'}
    for el in data.get('elements', []):
        t = el.get('tags', {}) or {}
        ring = [fwd(p['lon'], p['lat']) for p in el.get('geometry', []) or []]
        at = fwd(el['lon'], el['lat']) if 'lat' in el else ([round(sum(p[0] for p in ring) / len(ring), 2), round(sum(p[1] for p in ring) / len(ring), 2)] if ring else None)
        rec = {'type': el['type'], 'id': str(el['id']), 'tags': t, 'at': at}
        kind = t.get('highway') or t.get('natural') or t.get('emergency') or t.get('power') or t.get('man_made') or t.get('amenity')
        if 'building:part' in t:
            parts.append({**rec, 'ring': ring})
        elif el['type'] == 'way' and 'building' in t:
            buildings.append({**rec, 'ring': ring})
        elif el['type'] == 'node' and kind in FURN and not t.get('name'):
            furniture.append({'kind': kind, 'id': rec['id'], 'at': at, 'tags': t})
        elif el['type'] != 'relation':
            pois.append({**rec, **({'ring': ring} if ring and el['type'] == 'way' else {})})
    qids = [x['tags'].get('wikidata') for x in buildings + pois + parts]
    try:
        facts = _wikidata(qids)
    except Exception as ex:
        facts = {}; _status(stage='context', wikidata_error=str(ex)[-300:])
    ctx = {'source': 'overpass + wikidata', 'bbox': [w, s, e, n], 'pois': pois, 'parts': parts, 'buildings': buildings, 'furniture': furniture, 'wikidata': facts}
    with open(os.path.join(STATE['out'], 'context.json'), 'w') as f:
        json.dump(ctx, f, indent=1)
    _status(stage='context', context_counts={'pois': len(pois), 'parts': len(parts), 'buildings': len(buildings), 'furniture': len(furniture), 'wikidata': len(facts)})


def _export(scn, ob):
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    gs = importlib.import_module(f'{PKG}.geoscene')
    geo = gs.GeoScene(scn)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    bm = bmesh.new(); bm.from_mesh(ev.to_mesh()); bm.transform(ev.matrix_world)
    bvh = BVHTree.FromBMesh(bm)

    def ground(x, y):
        hit = bvh.ray_cast(Vector((x, y, 2000)), Vector((0, 0, -1)))
        return round(hit[0].z, 2) if hit[0] else None

    def tags(o):
        return {k: str(o[k]) for k in o.keys() if not k.startswith('_') and isinstance(o[k], (str, int, float))}
    out = {'buildings': [], 'highways': [], 'areas': []}
    for o in scn.objects:
        if o.type != 'MESH' or o == ob:
            continue
        t, mw, me = tags(o), o.matrix_world, o.data
        pts = [mw @ v.co for v in me.vertices]
        if 'building' in t:
            # BlenderGIS extrudes the footprint: every base vertex has a twin straight above it
            base = [i for i, p in enumerate(pts) if any(j != i and abs(q.x - p.x) < 1e-3 and abs(q.y - p.y) < 1e-3 and q.z > p.z for j, q in enumerate(pts))]
            ring = [[round(pts[i].x, 2), round(pts[i].y, 2)] for i in base]
            out['buildings'].append({'osm': t.get('id'), 'name': o.name, 'tags': t, 'ring': ring,
                                     'base': round(min(pts[i].z for i in base), 2) if base else None,
                                     'height': round(max(p.z for p in pts) - max(pts[i].z for i in base), 2) if base else None})
        elif 'highway' in t:
            adj = {}
            for e in me.edges:
                a, b = e.vertices
                adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
            ends = [k for k, v in adj.items() if len(v) == 1] or list(adj)[:1]
            path, seen, cur = [], set(), (ends[0] if ends else None)
            while cur is not None and cur not in seen:
                seen.add(cur); path.append(cur)
                nxt = [n for n in adj.get(cur, []) if n not in seen]
                cur = nxt[0] if nxt else None
            out['highways'].append({'osm': t.get('id'), 'name': o.name, 'tags': t, 'line': [[round(pts[i].x, 2), round(pts[i].y, 2)] for i in path]})
        else:
            ring = me.polygons[0].vertices if me.polygons else range(len(pts))
            out['areas'].append({'osm': t.get('id'), 'name': o.name, 'tags': t, 'ring': [[round(pts[i].x, 2), round(pts[i].y, 2)] for i in ring]})
    X0, X1, Y0, Y1 = STATE['extent']
    step = STATE.get('dem_step', 6)
    dem = [[ground(x, y) for x in range(int(X0), int(X1) + 1, step)] for y in range(int(Y0), int(Y1) + 1, step)]
    bm.free()
    cpath = os.path.join(STATE['out'], 'context.json')
    out['context'] = json.load(open(cpath)) if os.path.exists(cpath) else None
    data = {'source': f'BlenderGIS osm_query + dem_query ({STATE.get("dem", "SRTMGL1")})',
            'crs': geo.crs, 'origin': {'lon': geo.lon, 'lat': geo.lat, 'x': geo.crsx, 'y': geo.crsy},
            'extent': {'x0': X0, 'x1': X1, 'y0': Y0, 'y1': Y1}, 'units': 'm',
            'window': dict(zip(('x0', 'x1', 'y0', 'y1'), STATE.get('window') or STATE['extent'])),
            'dem': {'step': step, 'x0': X0, 'y0': Y0, 'kind': 'dtm' if STATE.get('dem', '').startswith('USGS') else 'dsm', 'source': STATE.get('dem', 'SRTMGL1'), 'z': dem}, **out}
    with open(os.path.join(STATE['out'], 'blender-export.json'), 'w') as f:
        json.dump(data, f, indent=1)
    _status(stage='export', counts={k: len(v) for k, v in out.items() if isinstance(v, list)})


def _render(scn, ob):
    data = json.load(open(os.path.join(STATE['out'], 'blender-export.json')))
    col = bpy.data.collections.get('GeoRenderRoads') or bpy.data.collections.new('GeoRenderRoads')
    if col.name not in scn.collection.children:
        scn.collection.children.link(col)
    for h in data['highways']:
        if h['tags']['highway'] in ('footway', 'path', 'steps') or len(h['line']) < 2:
            continue
        cu = bpy.data.curves.new('road_' + str(h['osm']), 'CURVE'); cu.dimensions = '3D'
        sp = cu.splines.new('POLY'); sp.points.add(len(h['line']) - 1)
        for i, (x, y) in enumerate(h['line']):
            sp.points[i].co = (x, y, 30, 1)
        lanes = int(h['tags'].get('lanes', '2') or 2)
        cu.bevel_depth = (3.6 if h['tags']['highway'] == 'service' else max(2, lanes) * 3.3 + 2) / 2
        rob = bpy.data.objects.new('road_' + str(h['osm']), cu); rob.scale.z = 0.05
        col.objects.link(rob)
    X0, X1, Y0, Y1 = STATE['extent']
    cam = bpy.data.objects.get('GeoTopCam') or bpy.data.objects.new('GeoTopCam', bpy.data.cameras.new('GeoTopCam'))
    if cam.name not in scn.collection.objects:
        scn.collection.objects.link(cam)
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = max(X1 - X0, Y1 - Y0)
    cam.location = ((X0 + X1) / 2, (Y0 + Y1) / 2, 500); cam.rotation_euler = (0, 0, 0)
    scn.camera = cam
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.color_type = 'RANDOM'; scn.display.shading.light = 'FLAT'
    scn.render.resolution_x = 1024; scn.render.resolution_y = int(1024 * (Y1 - Y0) / (X1 - X0))
    scn.render.filepath = os.path.join(STATE['out'], 'reference-topdown.png')
    ob.hide_render = True
    bpy.ops.render.render(write_still=True, scene=scn.name)
    if STATE.get('save_blend'):
        bpy.ops.wm.save_mainfile()
    _status(stage='done')


def _run():
    try:
        scn, ob = _setup()
        _dem(scn, ob)
        _osm(scn, ob)
        try:
            _context(scn, ob)
        except Exception:
            _status(stage='context-skipped', context_error=traceback.format_exc()[-1500:])
        _export(scn, ob)
        _render(scn, ob)
    except Exception:
        _status(stage='error', error=traceback.format_exc()[-3000:])
    return None


def resume(out, from_stage='osm'):
    """Re-run the later stages on the scene start() made (e.g. after an Overpass outage) without re-fetching the DEM."""
    STATE.clear(); STATE.update(json.load(open(os.path.join(out, 'geo-status.json'))))
    STATE.pop('error', None)
    if STATE.get('dem') and not str(STATE['dem']).startswith(('USGS', 'SRTM')):
        STATE['dem'] = STATE.get('dem_source', 'SRTMGL1')

    def run():
        try:
            scn = bpy.data.scenes[STATE['scene']]
            # the extent plane may be 'GeoExtent.001' when an earlier import already used the name
            ob = scn.objects.get(STATE.get('extent_obj', '')) or next(o for o in scn.objects if o.name.startswith('GeoExtent'))
            steps = ['osm', 'context', 'export', 'render']
            for name in steps[steps.index(from_stage):]:
                {'osm': _osm, 'context': _context, 'export': _export, 'render': _render}[name](scn, ob)
        except Exception:
            _status(stage='error', error=traceback.format_exc()[-3000:])
        return None
    bpy.app.timers.register(run, first_interval=0.1)
    return STATE


def context_only(out, scene='GeoContextScratch'):
    """Fetch the context for an existing import (its geo-status.json gives lat/lon/extent) in a scratch georeferenced
    scene and merge it into <out>/blender-export.json, leaving the geometry untouched. Runs on a timer like start()."""
    st = json.load(open(os.path.join(out, 'geo-status.json')))
    STATE.clear(); STATE.update(st); STATE['out'] = out   # keep the import's own status fields (its scene, DEM, …)

    def run():
        try:
            gs = importlib.import_module(f'{PKG}.geoscene')
            scn = bpy.data.scenes.get(scene) or bpy.data.scenes.new(scene)
            geo = gs.GeoScene(scn)
            zone = int((STATE['lon'] + 180) // 6) + 1
            geo.crs = f"EPSG:{32600 + zone if STATE['lat'] >= 0 else 32700 + zone}"
            geo.setOriginGeo(STATE['lon'], STATE['lat'])
            _context(scn, None)
            path = os.path.join(out, 'blender-export.json')
            data = json.load(open(path))
            data['context'] = json.load(open(os.path.join(out, 'context.json')))
            with open(path, 'w') as f:
                json.dump(data, f, indent=1)
            _status(stage='context-done')
        except Exception:
            _status(stage='error', error=traceback.format_exc()[-3000:])
        return None
    bpy.app.timers.register(run, first_interval=0.1)
    return STATE


def start(lat, lon, extent, out, scene='GeoImport', save_blend='geo-import.blend', dem_step=6, dem='SRTMGL1', pad=0):
    """extent = (x0, x1, y0, y1) metres east/north of (lat, lon) — the map window. pad (metres) fetches that much more
    DEM and OSM on every side, so the map can be rotated onto the grid and cropped back to the window with nothing
    missing at its corners (the export carries both: `extent` = fetched, `window` = the map). Returns at once; poll
    <out>/geo-status.json."""
    os.makedirs(out, exist_ok=True)
    x0, x1, y0, y1 = extent
    STATE.clear(); STATE.update(lat=lat, lon=lon, extent=[x0 - pad, x1 + pad, y0 - pad, y1 + pad], window=[x0, x1, y0, y1], out=out, scene=scene, save_blend=save_blend, dem_step=dem_step, dem=dem, dem_source=dem)
    _status(stage='queued')
    bpy.app.timers.register(_run, first_interval=0.1)
    return STATE

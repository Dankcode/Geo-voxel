// The area picker: an OpenStreetMap slippy map with a box you move (drag the centre) and resize (drag a corner).
// The box is kept in metres (centre lat/lon + width × depth) and clamped to what the generator can build.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { localProjection, MAX_SIDE_M, MIN_SIDE_M } from '../../src/live/fetchPlace.js';

const icon = cls => L.divIcon({ className: `sel-handle ${cls}`, iconSize: [14, 14] });

export function createSelector(el, { lat, lon, widthM, depthM, onChange }) {
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([lat, lon], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    const sel = { lat, lon, widthM, depthM };
    const rect = L.rectangle([[0, 0], [0, 0]], { color: '#d9a35b', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(map);
    const pad = L.rectangle([[0, 0], [0, 0]], { color: '#d9a35b', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);
    const centre = L.marker([lat, lon], { draggable: true, icon: icon('centre'), title: 'Drag to move the area' }).addTo(map);
    const corners = ['sw', 'se', 'ne', 'nw'].map(c => L.marker([lat, lon], { draggable: true, icon: icon(c), title: 'Drag to resize' }).addTo(map));
    let overlay = null, warpLayer = null;
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => { const d = L.DomUtil.create('div', 'warp-legend'); d.hidden = true;
        d.innerHTML = '<span><i style="background:#f1f1f1"></i>streets as mapped</span><span><i class="dash"></i>straightened streets</span><span><i style="background:#7dd3a7"></i>built map (rotated)</span><span><i style="background:#8fb3ff"></i>buildings</span>'; return d; };
    legend.addTo(map);
    const cornersOf = (s, extra = 0) => { const { inv } = localProjection(s.lat, s.lon), hw = s.widthM / 2 + extra, hd = s.depthM / 2 + extra;
        return { sw: inv(-hw, -hd), se: inv(hw, -hd), ne: inv(hw, hd), nw: inv(-hw, hd) }; };
    const draw = () => {
        const c = cornersOf(sel), p = cornersOf(sel, 30);
        rect.setBounds([[c.sw[1], c.sw[0]], [c.ne[1], c.ne[0]]]); pad.setBounds([[p.sw[1], p.sw[0]], [p.ne[1], p.ne[0]]]);
        centre.setLatLng([sel.lat, sel.lon]);
        corners.forEach((m, i) => { const k = ['sw', 'se', 'ne', 'nw'][i]; m.setLatLng([c[k][1], c[k][0]]); });
        onChange?.({ ...sel });
    };
    centre.on('drag', e => { const ll = e.target.getLatLng(); sel.lat = ll.lat; sel.lon = ll.lng; draw(); });
    corners.forEach((m, i) => m.on('drag', e => {
        // resize symmetrically about the centre: the dragged corner sets half the width and depth
        const ll = e.target.getLatLng(), { fwd } = localProjection(sel.lat, sel.lon), [x, y] = fwd(ll.lng, ll.lat);
        sel.widthM = Math.round(Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, Math.abs(x) * 2)));
        sel.depthM = Math.round(Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, Math.abs(y) * 2)));
        draw();
    }));
    corners.forEach(m => m.on('dragend', draw));
    draw();
    return {
        map, get: () => ({ ...sel }),
        set(next, { fly = true } = {}) { Object.assign(sel, next); sel.widthM = Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, sel.widthM)); sel.depthM = Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, sel.depthM)); draw(); if (fly) map.setView([sel.lat, sel.lon], Math.max(map.getZoom(), 17)); },
        /** Show what was fetched (building outlines, streets) over the map, in lat/lon. */
        showFetched(geo) {
            overlay?.remove();
            const { inv } = localProjection(geo.origin.lat, geo.origin.lon), ll = ([x, y]) => { const [lo, la] = inv(x, y); return [la, lo]; };
            overlay = L.layerGroup([
                ...geo.buildings.map(b => L.polygon(b.ring.map(ll), { color: '#8fb3ff', weight: 1, fillOpacity: 0.15, interactive: false })),
                ...geo.highways.map(h => L.polyline(h.line.map(ll), { color: '#f1f1f1', weight: 1.5, opacity: 0.75, interactive: false }))
            ]).addTo(map);
        },
        /** The warp: the straightened streets (dashed) and the built map's rotated frame over the real streets. */
        showWarp(geo, warp) {
            warpLayer?.remove(); if (!warp?.frame) return;
            const { inv } = localProjection(geo.origin.lat, geo.origin.lon), ll = ([x, y]) => { const [lo, la] = inv(x, y); return [la, lo]; };
            warpLayer = L.layerGroup([
                L.polygon(warp.frame.map(ll), { color: '#7dd3a7', weight: 2, fill: false, interactive: false }),
                ...warp.streets.map(s => L.polyline(s.line.map(ll), { color: '#d9a35b', weight: 3, dashArray: '6 5' }).bindTooltip(s.name || 'street', { sticky: true }))
            ]).addTo(map);
            legend.getContainer().hidden = false;
        },
        invalidate: () => map.invalidateSize()
    };
}

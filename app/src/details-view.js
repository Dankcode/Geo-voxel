// The Details tab: what was found about the place — buildings and what they are, the signs placed, Wikipedia
// articles, geotagged Commons photos (reference for facades and signs) and the sources to credit.
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderDetails(el, result, source) {
    const d = result.details;
    if (!d) { el.innerHTML = '<p class="empty">No details for this map.</p>'; return; }
    const bs = d.buildings.slice().sort((a, b) => (b.landmark - a.landmark) || (!!b.name - !!a.name) || (b.tenants.length - a.tenants.length));
    const types = d.buildings.reduce((m, b) => ((m[b.use || 'building'] = (m[b.use || 'building'] || 0) + 1), m), {});
    const shops = source?.details?.shops || [];
    const wp = d.docs?.wikipedia || [], photos = d.docs?.commons || [];
    const signs = result.layers.signs || [];
    el.innerHTML = `
    <section class="d-head"><h2>${esc(result.name)}</h2>
      <p>${d.selection ? `${d.selection.lat.toFixed(5)}, ${d.selection.lon.toFixed(5)} · ${d.selection.widthM} × ${d.selection.depthM} m · fetched ${esc(d.selection.fetched?.slice(0, 10) || '')}` : ''}</p>
      <p class="chips">${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span>${esc(k)} ${n}</span>`).join('')}</p></section>

    <section><h3>Buildings <small>${d.buildings.length}</small></h3>
      <table><thead><tr><th>Name</th><th>Use in the map</th><th>OSM type</th><th>Storeys</th><th>Address</th><th>Tenants</th><th>Known facts</th></tr></thead><tbody>
      ${bs.map(b => `<tr${b.landmark ? ' class="lm"' : ''}><td>${esc(b.name || '—')}${b.osm ? ` <a href="https://www.openstreetmap.org/way/${esc(b.osm)}" target="_blank" rel="noopener">osm</a>` : ''}</td><td>${esc(b.use || '—')}</td><td>${esc(b.type || '—')}</td><td>${b.storeys}${b.levels ? ` <small>(OSM ${esc(b.levels)})</small>` : ''}</td><td>${esc(b.address || '')}</td><td>${esc(b.tenants.join(', '))}</td>
        <td>${b.wikidata ? [b.wikidata.style?.join(', '), b.wikidata.inception, b.wikidata.architect?.join(', '), b.wikidata.heritage?.join(', '), b.wikidata.heightM ? `${b.wikidata.heightM} m` : ''].filter(Boolean).map(esc).join(' · ') + ` <a href="https://www.wikidata.org/wiki/${esc(b.wikidata.id)}" target="_blank" rel="noopener">wd</a>` : [b.roof && `roof ${b.roof}`, b.material, b.colour].filter(Boolean).map(esc).join(' · ')}</td></tr>`).join('')}
      </tbody></table></section>

    <section><h3>Signs placed <small>${signs.length}</small></h3>
      ${signs.length ? `<p class="chips">${Object.entries(d.counts).map(([k, n]) => `<span>${esc(k.replace('_', ' '))} ${n}</span>`).join('')}</p>
      <p class="signlist">${signs.filter(s => s.kind === 'shop' || s.kind === 'street_name').map(s => `<span class="sg ${s.kind}" style="${s.colour ? `background:${esc(s.colour)}` : ''}">${esc(s.text)}</span>`).join('')}</p>` : '<p class="empty">No mapped shops, street names or traffic signs here.</p>'}
      ${shops.length ? `<details><summary>${shops.length} named places from OpenStreetMap</summary><ul class="shops">${shops.map(s => `<li><b>${esc(s.name)}</b> <small>${esc(s.kind)}</small>${s.colour ? ` <i style="background:${esc(s.colour)}"></i>` : ''}${s.hours ? ` · ${esc(s.hours)}` : ''}${s.website ? ` · <a href="${esc(s.website)}" target="_blank" rel="noopener">site</a>` : ''}</li>`).join('')}</ul></details>` : ''}</section>

    <section><h3>Documentation <small>${wp.length} articles · ${photos.length} photos</small></h3>
      ${wp.map(a => `<article class="wp">${a.thumb ? `<img src="${esc(a.thumb)}" alt="">` : ''}<div><h4><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h4><p>${esc(a.extract)}</p></div></article>`).join('') || '<p class="empty">No Wikipedia articles linked from the buildings here.</p>'}
      ${photos.length ? `<div class="photos">${photos.map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title)} — ${esc(p.author)} (${esc(p.license)})"><img loading="lazy" src="${esc(p.thumb)}" alt="${esc(p.description || p.title)}"><span>${esc(p.date || '')}</span></a>`).join('')}</div>
      <p class="note">Geotagged photos from Wikimedia Commons inside the area — references for facades, colours and signs. Click for author and licence.</p>` : ''}</section>

    <section><h3>Sources</h3><ul class="sources">${(d.sources || []).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> — ${esc(s.detail)} · ${esc(s.credit)}</li>`).join('') || `<li>${esc(source?.source || 'Blender export')}</li>`}</ul>
      ${d.warp?.straighten ? `<p class="note">Warp: the map is rotated ${d.warp.rotationDeg}° onto the street grid and every street is snapped to a straight grid line; streets moved up to ${(d.warp.straighten.maxShift * 0.9).toFixed(1)} m (mean ${(d.warp.straighten.meanShift * 0.9).toFixed(1)} m), buildings and land use were carried along.</p>` : ''}</section>`;
}

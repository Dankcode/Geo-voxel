// Documentation for a place, keyless and CORS-open: Wikidata facts for the landmarks and the brands on the shop
// fronts, Wikipedia summaries for what has an article, Wikimedia Commons photos taken inside the box.
const WD = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*&languages=en';
const val = (c, p) => (c[p] || []).map(s => s.mainsnak?.datavalue?.value).filter(v => v != null);

/**
 * { QID → { label, description, instanceOf, floors, floorsBelow, heightM, style, inception, architect, heritage, image,
 *           colour, logo, wikipedia } } — the same facts as the Blender stage, plus brand colour (P465), logo (P154) and
 * the English Wikipedia title.
 */
export async function wikidataFacts(qids, getJSON) {
    qids = [...new Set(qids)].filter(q => /^Q\d+$/.test(q)).slice(0, 50);
    if (!qids.length) return {};
    const ents = (await getJSON(`${WD}&props=labels|descriptions|claims|sitelinks&sitefilter=enwiki&ids=${qids.join('|')}`)).entities || {};
    const facts = {}, ref = new Set();
    for (const [q, e] of Object.entries(ents)) {
        const c = e.claims || {}, f = { label: e.labels?.en?.value || null, description: e.descriptions?.en?.value || null };
        for (const [key, p] of [['instanceOf', 'P31'], ['style', 'P149'], ['architect', 'P84'], ['heritage', 'P1435']]) { f[key] = val(c, p).filter(v => v.id).map(v => v.id); f[key].forEach(i => ref.add(i)); }
        for (const [key, p] of [['floors', 'P1101'], ['floorsBelow', 'P1139'], ['heightM', 'P2048']]) {
            const v = val(c, p)[0]; if (v?.amount == null) continue;
            let n = parseFloat(v.amount); if (key === 'heightM' && /Q3710$/.test(v.unit || '')) n *= 0.3048;
            f[key] = +n.toFixed(1);
        }
        const t = val(c, 'P571')[0]; if (t?.time) f.inception = t.time.slice(1, 5);
        const img = val(c, 'P18')[0]; if (img) f.image = img;
        const colour = val(c, 'P465')[0]; if (colour) f.colour = `#${String(colour).replace('#', '').slice(0, 6)}`;
        const logo = val(c, 'P154')[0]; if (logo) f.logo = logo;
        const wp = e.sitelinks?.enwiki?.title; if (wp) f.wikipedia = wp;
        facts[q] = f;
    }
    if (ref.size) {
        const lab = (await getJSON(`${WD}&props=labels&ids=${[...ref].slice(0, 50).join('|')}`)).entities || {};
        const name = i => lab[i]?.labels?.en?.value || i;
        for (const f of Object.values(facts)) for (const k of ['instanceOf', 'style', 'architect', 'heritage']) f[k] = f[k].map(name);
    }
    return facts;
}

/** Wikipedia page summaries (lead paragraph, thumbnail, link) for up to `max` titles. */
export async function wikipediaSummaries(titles, getJSON, { max = 6 } = {}) {
    const out = [];
    for (const title of [...new Set(titles)].slice(0, max)) {
        try {
            const s = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
            out.push({ title: s.title, extract: s.extract, url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`, thumb: s.thumbnail?.source || null, coordinates: s.coordinates || null });
        } catch { /* a missing article is not an error */ }
    }
    return out;
}

/** Wikimedia Commons photos taken inside a radius of the centre (reference pictures for signs, facades, colours). */
export async function commonsPhotos(lat, lon, radiusM, getJSON, { limit = 24 } = {}) {
    const r = Math.max(10, Math.min(10000, Math.round(radiusM)));
    const j = await getJSON(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat}|${lon}&ggsradius=${r}&ggsnamespace=6&ggslimit=${limit}&prop=imageinfo|coordinates&iiprop=url|extmetadata&iiurlwidth=320&iiextmetadatafilter=Artist|LicenseShortName|ImageDescription|DateTimeOriginal`);
    const strip = s => String(s || '').replace(/<[^>]+>/g, '').trim();
    return Object.values(j.query?.pages || {}).map(p => {
        const ii = p.imageinfo?.[0] || {}, m = ii.extmetadata || {};
        return { title: p.title.replace(/^File:/, ''), url: ii.descriptionurl, thumb: ii.thumburl, full: ii.url, at: p.coordinates?.[0] ? [p.coordinates[0].lon, p.coordinates[0].lat] : null,
            author: strip(m.Artist?.value), license: strip(m.LicenseShortName?.value), date: strip(m.DateTimeOriginal?.value).slice(0, 10), description: strip(m.ImageDescription?.value).slice(0, 200) };
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

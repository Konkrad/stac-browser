// A read-only STAC API answered in the browser: collections from a JSON file,
// items with DuckDB-WASM over monthly STAC GeoParquet files
// (<data base>/<folder>.parquet/<YYYY-MM>.parquet).
//
// collections.json: { title, description, data_base, collections: [ <STAC
// Collection without links> + "cdse:files": { "<folder>": ["YYYY-MM", ...] } ] }
// -- which folders and months hold items of that collection.
import { query, quote } from './db';
import { wkbToGeoJSON } from './wkb';

const STAC_VERSION = '1.1.0';
const GEOJSON = 'application/geo+json';
const JSON_TYPE = 'application/json';
const CONFORMANCE = [
  'https://api.stacspec.org/v1.0.0/core',
  'https://api.stacspec.org/v1.0.0/collections',
  'https://api.stacspec.org/v1.0.0/ogcapi-features',
  'https://api.stacspec.org/v1.0.0/item-search',
  'https://api.stacspec.org/v1.0.0/item-search#sort',
  'https://api.stacspec.org/v1.0.0/ogcapi-features#sort',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
];
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 1000;
// Top-level fields of a STAC item; every other column is a property.
const TOP_LEVEL = new Set(['type', 'stac_version', 'stac_extensions', 'id', 'collection', 'geometry', 'bbox', 'links', 'assets']);

/** Arrow values -> JSON: BigInt -> Number, map_entries -> object, nested rows -> objects. */
function plain(value) {
  if (value === null || value === undefined) { return value; }
  if (typeof value === 'bigint') { return Number(value); }
  if (value instanceof Uint8Array) { return undefined; }
  if (typeof value.toJSON === 'function' && !(value instanceof Date)) { value = value.toJSON(); }
  if (Array.isArray(value)) {
    if (value.length && value.every(v => v && typeof v === 'object' && 'key' in v && 'value' in v && Object.keys(v).length === 2)) {
      return Object.fromEntries(value.map(v => [v.key, plain(v.value)]));
    }
    return value.map(plain);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function dropNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, typeof v === 'object' && !Array.isArray(v) ? dropNulls(v) : v]));
}

function list(value) {
  if (value === undefined || value === null || value === '') { return null; }
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const out = arr.map(v => String(v).trim()).filter(Boolean);
  return out.length ? out : null;
}

function instant(value, end) {
  if (!value || value === '..') { return null; }
  if (/^\d{4}$/.test(value)) { return end ? `${value}-12-31T23:59:59.999Z` : `${value}-01-01T00:00:00Z`; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { return end ? `${value}T23:59:59.999Z` : `${value}T00:00:00Z`; }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) { throw new BadRequest(`Invalid datetime: ${value}`); }
  return d.toISOString();
}

export function parseParams(params = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(params.limit, 10) || DEFAULT_LIMIT));
  let bbox = list(params.bbox);
  if (bbox) {
    bbox = bbox.map(Number);
    if (bbox.length === 6) { bbox = [bbox[0], bbox[1], bbox[3], bbox[4]]; }
    if (bbox.length !== 4 || bbox.some(Number.isNaN)) { throw new BadRequest('bbox needs 4 numbers'); }
  }
  let datetime = [null, null];
  if (params.datetime) {
    const [a, b] = String(params.datetime).split('/');
    datetime = b === undefined ? [instant(a, false), instant(a, true)] : [instant(a, false), instant(b, true)];
  }
  // sortby: "-properties.datetime", "+datetime", [{field, direction}] (POST)
  let sort = 'desc';
  const sortby = Array.isArray(params.sortby) ? params.sortby[0] : list(params.sortby)?.[0];
  if (sortby) {
    if (typeof sortby === 'object') { sort = sortby.direction === 'asc' ? 'asc' : 'desc'; }
    else if (/datetime$/.test(sortby)) { sort = sortby.startsWith('-') ? 'desc' : 'asc'; }
  }
  return {
    limit, bbox, datetime, sort,
    collections: list(params.collections),
    ids: list(params.ids),
    token: params.token || null,
  };
}

function serializeParams(p) {
  const q = { limit: String(p.limit), sortby: `${p.sort === 'asc' ? '+' : '-'}properties.datetime`, token: p.token };
  if (p.bbox) { q.bbox = p.bbox.join(','); }
  if (p.datetime[0] || p.datetime[1]) { q.datetime = `${p.datetime[0] || '..'}/${p.datetime[1] || '..'}`; }
  if (p.collections) { q.collections = p.collections.join(','); }
  if (p.ids) { q.ids = p.ids.join(','); }
  return q;
}

export class NotFound extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export default class LocalApi {
  constructor({ url, collectionsUrl }) {
    this.base = url.replace(/\/+$/, '');
    this.collectionsUrl = collectionsUrl;
    this.catalog = null;
    this.schemas = new Map(); // folder -> Promise<[name, type][]>
  }

  load() {
    if (!this.catalog) {
      this.catalog = fetch(this.collectionsUrl).then(r => {
        if (!r.ok) {
          throw new Error(`${this.collectionsUrl}: HTTP ${r.status}`);
        }
        return r.json();
      });
      this.catalog.catch(() => { this.catalog = null; });
    }
    return this.catalog;
  }

  /** Answer a request; `path` is relative to the API root, `params` from the query string or POST body. */
  async handle(method, path, params) {
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const cat = await this.load();
    if (parts.length === 0) {
      return this.landing(cat);
    }
    if (parts[0] === 'conformance' && parts.length === 1) {
      return { conformsTo: CONFORMANCE };
    }
    if (parts[0] === 'search' && parts.length === 1) {
      return this.search(cat, params, 'search');
    }
    if (parts[0] === 'collections') {
      if (parts.length === 1) {
        return {
          collections: cat.collections.map(c => this.collection(c)),
          links: [this.link('self', '/collections', JSON_TYPE), this.link('root', '', JSON_TYPE)],
        };
      }
      const coll = cat.collections.find(c => c.id === parts[1]);
      if (!coll) {
        throw new NotFound(`Collection ${parts[1]} not found`);
      }
      if (parts.length === 2) {
        return this.collection(coll);
      }
      if (parts[2] === 'items' && parts.length === 3) {
        return this.search(cat, Object.assign({}, params, { collections: [coll.id] }), `collections/${coll.id}/items`);
      }
      if (parts[2] === 'items' && parts.length === 4) {
        const res = await this.search(cat, { collections: [coll.id], ids: [parts[3]], limit: 1 }, null);
        if (res.features.length === 0) {
          throw new NotFound(`Item ${parts[3]} not found in ${coll.id}`);
        }
        return res.features[0];
      }
    }
    throw new NotFound(`${method} /${path} is not part of this API`);
  }

  link(rel, path, type, extra = {}) {
    return Object.assign({ rel, href: this.base + path, type }, extra);
  }

  landing(cat) {
    return {
      type: 'Catalog',
      stac_version: STAC_VERSION,
      id: cat.id || 'catalogue',
      title: cat.title,
      description: cat.description,
      conformsTo: CONFORMANCE,
      links: [
        this.link('self', '/', JSON_TYPE),
        this.link('root', '/', JSON_TYPE),
        this.link('conformance', '/conformance', JSON_TYPE),
        this.link('data', '/collections', JSON_TYPE),
        this.link('search', '/search', GEOJSON, { method: 'GET' }),
        ...cat.collections.map(c => this.link('child', `/collections/${encodeURIComponent(c.id)}`, JSON_TYPE, { title: c.title || c.id })),
        ...(cat.links || []),
      ],
    };
  }

  collection(c) {
    const out = Object.assign({}, c);
    delete out['cdse:files'];
    const self = `/collections/${encodeURIComponent(c.id)}`;
    out.links = [
      this.link('self', self, JSON_TYPE),
      this.link('root', '/', JSON_TYPE),
      this.link('parent', '/', JSON_TYPE),
      this.link('items', `${self}/items`, GEOJSON),
      ...(c.links || []),
    ];
    return out;
  }

  /** The month files to read, newest first (or oldest first), each with the collections in it. */
  months(cat, collectionIds, interval, ids, ascending) {
    const wanted = collectionIds && collectionIds.length ? new Set(collectionIds) : null;
    let idMonths = null;
    if (ids && ids.length) { // an id carries its sensing date: read only that month and the next
      idMonths = new Set();
      for (const id of ids) {
        const m = /(\d{4})(\d{2})\d{2}T\d{6}/.exec(id);
        if (!m) {
          idMonths = null;
          break;
        }
        const y = Number(m[1]), mo = Number(m[2]);
        idMonths.add(`${m[1]}-${m[2]}`);
        idMonths.add(mo === 12 ? `${y + 1}-01` : `${m[1]}-${String(mo + 1).padStart(2, '0')}`);
      }
    }
    const [start, end] = interval;
    const byMonth = new Map(); // month -> Map(folder -> Set(collection))
    for (const c of cat.collections) {
      if (wanted && !wanted.has(c.id)) {
        continue;
      }
      for (const [folder, months] of Object.entries(c['cdse:files'] || {})) {
        for (const month of months) {
          if (start && `${month}-31T23:59:59Z` < start) { continue; }
          if (end && `${month}-01T00:00:00Z` > end) { continue; }
          if (idMonths && !idMonths.has(month)) { continue; }
          if (!byMonth.has(month)) { byMonth.set(month, new Map()); }
          const folders = byMonth.get(month);
          if (!folders.has(folder)) { folders.set(folder, new Set()); }
          folders.get(folder).add(c.id);
        }
      }
    }
    const ordered = [...byMonth.keys()].sort();
    if (!ascending) { ordered.reverse(); }
    return ordered.map(month => ({ month, folders: byMonth.get(month) }));
  }

  /** Column names and types of a folder's files (from its newest month), to build the SELECT. */
  schema(cat, folder, url) {
    if (!this.schemas.has(folder)) {
      const p = query(`DESCRIBE SELECT * FROM read_parquet(${quote(url)})`).then(rows => rows.map(r => [r.column_name, r.column_type]));
      p.catch(() => this.schemas.delete(folder));
      this.schemas.set(folder, p);
    }
    return this.schemas.get(folder);
  }

  selectList(columns) {
    // overviews: COGP's simplified geometries for map rendering, not item data.
    // cdse:*: the files' extras beyond CDSE's STAC items (raw OData record, ...), not shown.
    return columns.filter(([name]) => name !== 'overviews' && !name.startsWith('cdse:')).map(([name, type]) => {
      const q = `"${name.replace(/"/g, '""')}"`;
      if (type.startsWith('TIMESTAMP')) { // ISO strings, as STAC wants
        return `strftime(CAST(${q} AS TIMESTAMP), '%Y-%m-%dT%H:%M:%S.%fZ') AS ${q}`;
      }
      if (type.startsWith('MAP(')) {
        return `map_entries(${q}) AS ${q}`;
      }
      if (name === 'geometry') {
        return `CAST(${q} AS BLOB) AS ${q}`;
      }
      return q;
    }).join(', ');
  }

  async search(cat, params, path) {
    const p = parseParams(params);
    const ascending = p.sort === 'asc';
    const months = this.months(cat, p.collections, p.datetime, p.ids, ascending);
    const base = cat.data_base.replace(/\/+$/, '');
    let [monthIndex, skip] = p.token ? p.token.split(':').map(Number) : [0, 0];
    const features = [];
    let next = null;

    while (monthIndex < months.length) {
      const { month, folders } = months[monthIndex];
      const need = p.limit - features.length;
      const entries = [...folders].map(([folder, colls]) => [folder, colls, `${base}/${folder}.parquet/${month}.parquet`]);
      // eslint-disable-next-line no-await-in-loop -- months are read one after another until the page is full
      const schemas = await Promise.all(entries.map(([folder, , url]) => this.schema(cat, folder, url)));
      const parts = [];
      for (const [i, [, colls, url]] of entries.entries()) {
        const columns = schemas[i];
        const where = [`collection IN (${[...colls].map(quote).join(', ')})`];
        if (p.ids) { where.push(`id IN (${p.ids.map(quote).join(', ')})`); }
        if (p.bbox) {
          const [w, s, e, n] = p.bbox;
          where.push(`bbox.xmax >= ${w} AND bbox.xmin <= ${e} AND bbox.ymax >= ${s} AND bbox.ymin <= ${n}`);
        }
        if (p.datetime[0]) { where.push(`datetime >= TIMESTAMPTZ ${quote(p.datetime[0])}`); }
        if (p.datetime[1]) { where.push(`datetime <= TIMESTAMPTZ ${quote(p.datetime[1])}`); }
        parts.push(`SELECT ${this.selectList(columns)} FROM read_parquet(${quote(url)}) WHERE ${where.join(' AND ')}`);
      }
      const sql = `SELECT * FROM (${parts.join(' UNION ALL BY NAME ')})
        ORDER BY datetime ${ascending ? 'ASC' : 'DESC'}, id LIMIT ${need + 1} OFFSET ${skip}`;
      // eslint-disable-next-line no-await-in-loop -- see above
      const rows = await query(sql);
      for (const row of rows.slice(0, need)) {
        features.push(this.item(row));
      }
      if (rows.length > need) { // more in this month
        next = `${monthIndex}:${skip + need}`;
        break;
      }
      monthIndex++;
      skip = 0;
      if (features.length >= p.limit) {
        if (monthIndex < months.length) { next = `${monthIndex}:0`; }
        break;
      }
    }

    const links = [];
    if (path) {
      links.push(this.link('root', '/', JSON_TYPE));
      if (next) {
        const q = new URLSearchParams(serializeParams(Object.assign({}, p, { token: next })));
        links.push(this.link('next', `/${path}?${q}`, GEOJSON, { method: 'GET' }));
      }
    }
    return { type: 'FeatureCollection', features, links, numberReturned: features.length };
  }

  item(row) {
    const props = {};
    for (const [key, value] of Object.entries(row)) {
      if (TOP_LEVEL.has(key) || value === null || value === undefined) { continue; }
      props[key] = plain(value);
    }
    const b = row.bbox;
    const self = `/collections/${encodeURIComponent(row.collection)}/items/${encodeURIComponent(row.id)}`;
    return {
      type: 'Feature',
      stac_version: row.stac_version || STAC_VERSION,
      stac_extensions: plain(row.stac_extensions) || [],
      id: row.id,
      collection: row.collection,
      geometry: wkbToGeoJSON(row.geometry),
      bbox: b ? [b.xmin, b.ymin, b.xmax, b.ymax].map(Number) : undefined,
      properties: props,
      assets: dropNulls(plain(row.assets) || {}),
      links: [
        ...(plain(row.links) || []),
        this.link('self', self, GEOJSON),
        this.link('parent', `/collections/${encodeURIComponent(row.collection)}`, JSON_TYPE),
        this.link('collection', `/collections/${encodeURIComponent(row.collection)}`, JSON_TYPE),
        this.link('root', '/', JSON_TYPE),
      ],
    };
  }
}

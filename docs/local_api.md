# Local API (fork)

This fork can answer a read-only STAC API in the browser, with no server: the
config option `localApi` puts an adapter in front of axios that handles every
request under `localApi.url` itself (`src/local-api`), and lets all other
requests through.

```js
localApi: {
  url: "https://dataspace.konrad.online/api/",          // also set catalogUrl to it
  collectionsUrl: "https://dataspace.konrad.online/collections.json"
}
```

Use `historyMode: "hash"` when the files are served from a bucket, which can't
route deep links back to `index.html`.

## Data

Items are STAC GeoParquet files, one per folder and month:
`<data_base>/<folder>.parquet/<YYYY-MM>.parquet` (see
[dataspace](https://github.com/Konkrad/dataspace)). `collectionsUrl` points to:

```json
{
  "title": "...", "description": "...", "data_base": "https://dataspace.konrad.online",
  "collections": [
    { "type": "Collection", "id": "sentinel-2-l2a", "title": "...", "extent": {...},
      "cdse:files": { "sentinel-2-l2a": ["2015-07", "2015-08", ...] } }
  ]
}
```

`cdse:files` says which folders and months hold the collection's items, so a
search only reads the months its `datetime` range covers.

## Endpoints

| Endpoint | Answered from |
|---|---|
| `/`, `/conformance` | static (core, collections, features, item-search, sort) |
| `/collections`, `/collections/{id}` | `collections.json` |
| `/collections/{id}/items`, `/search` (GET, POST) | DuckDB-WASM: `collections`, `ids`, `bbox`, `datetime`, `limit`, `sortby` (datetime), paging |
| `/collections/{id}/items/{itemId}` | the month in the item id |

Searches go month by month (newest first, or oldest first with
`sortby=+properties.datetime`) until a page is full, so an open-ended search
doesn't open every file. `bbox` is matched against the files' `bbox` column,
which lets DuckDB skip row groups. No free text or CQL2 filters yet.

DuckDB-WASM's WebAssembly comes from jsDelivr (the version in package.json).

// DuckDB-WASM, started once. The WebAssembly bundle comes from jsDelivr (the
// version pinned in package.json); the worker is wrapped in a same-origin Blob,
// since browsers don't start workers from another origin.
import * as duckdb from '@duckdb/duckdb-wasm';

let ready = null;

export function getDb() {
  if (!ready) {
    ready = (async () => {
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
      );
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await db.open({ filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false } });
      URL.revokeObjectURL(workerUrl);
      // The parquet extension is otherwise fetched on the first read_parquet;
      // if this fails, that autoload still tries again.
      const conn = await db.connect();
      try {
        await conn.query('LOAD parquet');
      }
      catch (error) {
        console.warn('Local API: loading the DuckDB parquet extension failed', error);
      }
      finally {
        await conn.close();
      }
      return db;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

/**
 * Start DuckDB in the background once the page is idle, so its download and
 * startup (~6 MB, about a second) overlap with the landing page instead of
 * delaying the first collection that is opened. A failure here is left to the
 * first query, which starts DuckDB again.
 */
export function warmUp() {
  const start = () => getDb().catch(() => {});
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(start, { timeout: 2000 });
  }
  else {
    setTimeout(start, 500);
  }
}

const files = new Map();
let fileCount = 0;

/**
 * The name to read a remote file by: its URL registered with DuckDB under a plain
 * name. read_parquet('https://...') first globs the URL, which sends a HEAD
 * without a Range header; Firefox caches that 200 and answers the ranged HEAD
 * that opens the file with it, which DuckDB (reliableHeadRequests, no full
 * reads) rejects. A registered name skips the glob, so the first request is the
 * ranged HEAD, and its 206 is what gets cached.
 */
export function file(url) {
  if (!files.has(url)) {
    const name = `f${fileCount++}.parquet`;
    const p = getDb()
      .then(db => db.registerFileURL(name, url, duckdb.DuckDBDataProtocol.HTTP, false))
      .then(() => name);
    p.catch(() => files.delete(url));
    files.set(url, p);
  }
  return files.get(url);
}

/** Run a query on its own connection; returns plain objects. */
export async function query(sql) {
  const db = await getDb();
  const conn = await db.connect();
  try {
    const table = await conn.query(sql);
    return table.toArray().map(row => row.toJSON());
  }
  finally {
    await conn.close();
  }
}

export function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

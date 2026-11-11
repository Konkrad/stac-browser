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
      URL.revokeObjectURL(workerUrl);
      return db;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
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

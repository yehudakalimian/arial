// Tiny promise wrapper around IndexedDB (no dependencies).
// Stores: local_care_events, sync_outbox_queue, active_timers, milk_stash, growth_measurements, kv
const DB_NAME = 'ariel-tracker';
const DB_VERSION = 1;
export const STORES = ['local_care_events', 'sync_outbox_queue', 'active_timers', 'milk_stash', 'growth_measurements', 'kv'];

let dbp = null;
let memory = null; // fallback when IndexedDB is unavailable (private mode on some browsers)

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (!globalThis.indexedDB) { memory = Object.fromEntries(STORES.map((s) => [s, new Map()])); return resolve(null); }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('local_care_events')) {
        const s = db.createObjectStore('local_care_events', { keyPath: 'client_mutation_id' });
        s.createIndex('started_at', 'started_at');
      }
      if (!db.objectStoreNames.contains('sync_outbox_queue')) {
        const s = db.createObjectStore('sync_outbox_queue', { keyPath: 'client_mutation_id' });
        s.createIndex('queued_at', 'queued_at');
      }
      for (const name of ['active_timers', 'milk_stash', 'growth_measurements']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { memory = Object.fromEntries(STORES.map((s) => [s, new Map()])); resolve(null); };
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return dbp;
}

const keyOf = (store, v, k) => k ?? (store === 'local_care_events' || store === 'sync_outbox_queue' ? v.client_mutation_id : v.id);

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getAll(store) {
  const db = await open();
  if (!db) return [...memory[store].values()];
  return tx(db, store, 'readonly', (s) => req2p(s.getAll()));
}
export async function get(store, key) {
  const db = await open();
  if (!db) return memory[store].get(key);
  return tx(db, store, 'readonly', (s) => req2p(s.get(key)));
}
export async function put(store, value, key) {
  const db = await open();
  if (!db) { memory[store].set(keyOf(store, value, key), structuredClone(value)); return; }
  return tx(db, store, 'readwrite', (s) => { store === 'kv' ? s.put(value, key) : s.put(value); });
}
export async function putMany(store, values) {
  if (!values.length) return;
  const db = await open();
  if (!db) { values.forEach((v) => memory[store].set(keyOf(store, v), structuredClone(v))); return; }
  return tx(db, store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); });
}
export async function del(store, key) {
  const db = await open();
  if (!db) { memory[store].delete(key); return; }
  return tx(db, store, 'readwrite', (s) => { s.delete(key); });
}
export async function clear(store) {
  const db = await open();
  if (!db) { memory[store].clear(); return; }
  return tx(db, store, 'readwrite', (s) => { s.clear(); });
}
export async function clearAll() { for (const s of STORES) await clear(s); }

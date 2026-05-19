// db.js — IndexedDB ラッパー

const DB = (() => {
  const NAME = 'consumable-forecast';
  const VER  = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = ({ target: { result: db } }) => {
        if (!db.objectStoreNames.contains('items')) {
          const s = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
          s.createIndex('archived', 'archived', { unique: false });
        }
        if (!db.objectStoreNames.contains('purchases')) {
          const s = db.createObjectStore('purchases', { keyPath: 'id', autoIncrement: true });
          s.createIndex('item_id', 'item_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('openings')) {
          const s = db.createObjectStore('openings', { keyPath: 'id', autoIncrement: true });
          s.createIndex('item_id', 'item_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
      };
      req.onsuccess  = ({ target: { result } }) => { _db = result; resolve(_db); };
      req.onerror    = ({ target: { error } })  => reject(error);
    });
  }

  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  async function tx(stores, mode = 'readonly') {
    const db = await open();
    return db.transaction(stores, mode);
  }

  // ── items ──────────────────────────────────────────────────────────────────

  async function getItems() {
    const t = await tx('items');
    const all = await wrap(t.objectStore('items').getAll());
    return all.filter(i => !i.archived).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  async function getItem(id) {
    const t = await tx('items');
    return wrap(t.objectStore('items').get(id));
  }

  async function addItem(item) {
    const t = await tx('items', 'readwrite');
    const id = await wrap(t.objectStore('items').add(item));
    return { ...item, id };
  }

  async function putItem(item) {
    const t = await tx('items', 'readwrite');
    await wrap(t.objectStore('items').put(item));
    return item;
  }

  // ── purchases ─────────────────────────────────────────────────────────────

  async function getPurchasesByItem(itemId) {
    const t = await tx('purchases');
    return wrap(t.objectStore('purchases').index('item_id').getAll(itemId));
  }

  async function addPurchase(p) {
    const t = await tx('purchases', 'readwrite');
    const id = await wrap(t.objectStore('purchases').add(p));
    return { ...p, id };
  }

  async function getPurchase(id) {
    const t = await tx('purchases');
    return wrap(t.objectStore('purchases').get(id));
  }

  async function updatePurchase(p) {
    const t = await tx('purchases', 'readwrite');
    return wrap(t.objectStore('purchases').put(p));
  }

  async function deletePurchase(id) {
    const t = await tx('purchases', 'readwrite');
    return wrap(t.objectStore('purchases').delete(id));
  }

  // ── openings ──────────────────────────────────────────────────────────────

  async function getOpeningsByItem(itemId) {
    const t = await tx('openings');
    return wrap(t.objectStore('openings').index('item_id').getAll(itemId));
  }

  async function addOpening(o) {
    const t = await tx('openings', 'readwrite');
    const id = await wrap(t.objectStore('openings').add(o));
    return { ...o, id };
  }

  async function getOpening(id) {
    const t = await tx('openings');
    return wrap(t.objectStore('openings').get(id));
  }

  async function deleteOpening(id) {
    const t = await tx('openings', 'readwrite');
    return wrap(t.objectStore('openings').delete(id));
  }

  // ── settings ──────────────────────────────────────────────────────────────

  const DEFAULT_SETTINGS = {
    id: 1, lead_time_days: 3, safety_margin_days: 2,
    notify_time: '08:00', shopping_weekday: null, last_notified_date: null,
  };

  async function getSettings() {
    const t = await tx('settings');
    const s = await wrap(t.objectStore('settings').get(1));
    return s ? { ...DEFAULT_SETTINGS, ...s } : { ...DEFAULT_SETTINGS };
  }

  async function putSettings(settings) {
    const t = await tx('settings', 'readwrite');
    return wrap(t.objectStore('settings').put({ id: 1, ...settings }));
  }

  // ── export / import ───────────────────────────────────────────────────────

  async function exportAll() {
    const db = await open();
    const t = db.transaction(['items', 'purchases', 'openings', 'settings'], 'readonly');
    const [items, purchases, openings, settings] = await Promise.all([
      wrap(t.objectStore('items').getAll()),
      wrap(t.objectStore('purchases').getAll()),
      wrap(t.objectStore('openings').getAll()),
      wrap(t.objectStore('settings').get(1)),
    ]);
    return { items, purchases, openings, settings: settings ?? {} };
  }

  async function importAll(data) {
    const db = await open();
    const t = db.transaction(['items', 'purchases', 'openings', 'settings'], 'readwrite');
    t.objectStore('items').clear();
    t.objectStore('purchases').clear();
    t.objectStore('openings').clear();
    for (const item of data.items    ?? []) t.objectStore('items').put(item);
    for (const p    of data.purchases ?? []) t.objectStore('purchases').put(p);
    for (const o    of data.openings  ?? []) t.objectStore('openings').put(o);
    if (data.settings && Object.keys(data.settings).length) {
      t.objectStore('settings').put({ ...DEFAULT_SETTINGS, ...data.settings, id: 1 });
    }
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  return {
    getItems, getItem, addItem, putItem,
    getPurchasesByItem, addPurchase, getPurchase, updatePurchase, deletePurchase,
    getOpeningsByItem, addOpening, getOpening, deleteOpening,
    getSettings, putSettings,
    exportAll, importAll,
  };
})();

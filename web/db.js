// db.js — IndexedDB ラッパー

const DB = (() => {
  const NAME = 'consumable-forecast';
  const VER  = 3;   // v2: adjustments（在庫の数え直し） / v3: 支出（expenses・expense_lines・name_links）
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
        if (!db.objectStoreNames.contains('adjustments')) {
          const s = db.createObjectStore('adjustments', { keyPath: 'id', autoIncrement: true });
          s.createIndex('item_id', 'item_id', { unique: false });
        }
        // 支出（1回の買い物）。mode: 'bulk'（合計だけ） | 'lines'（購入品ごと）
        if (!db.objectStoreNames.contains('expenses')) {
          const s = db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
          s.createIndex('spent_on', 'spent_on', { unique: false });
        }
        // 購入品の行。item_id があればストック品目と紐づき、purchase_id の購入記録を持つ
        if (!db.objectStoreNames.contains('expense_lines')) {
          const s = db.createObjectStore('expense_lines', { keyPath: 'id', autoIncrement: true });
          s.createIndex('expense_id', 'expense_id', { unique: false });
        }
        // 購入品名 → ストック品目の対応（一度紐づけた名前を次回から自動で紐づける）
        if (!db.objectStoreNames.contains('name_links')) {
          db.createObjectStore('name_links', { keyPath: 'name' });
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

  async function getArchivedItems() {
    const t = await tx('items');
    const all = await wrap(t.objectStore('items').getAll());
    return all.filter(i => i.archived).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  // 品目の記録（買った・使用開始・数え直し）を消す。
  //   mode 'delete': 品目ごと削除。家計簿の支出は残し、品目との紐づけだけ外す
  //   mode 'reset' : 品目は残し、記録を消して initialStock から始め直す
  // 1つのトランザクションで行い、途中で失敗したら何も変わらない。
  async function removeItemRecords(itemId, mode, initialStock = 0) {
    const db = await open();
    const stores = ['items', 'purchases', 'openings', 'adjustments', 'expense_lines', 'name_links'];
    const t = db.transaction(stores, 'readwrite');
    const finished = new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('中止しました'));
    });
    const counts = {};
    for (const name of ['purchases', 'openings', 'adjustments']) {
      const s = t.objectStore(name);
      const keys = await wrap(s.index('item_id').getAllKeys(itemId));
      keys.forEach(k => s.delete(k));
      counts[name] = keys.length;
    }
    const lines = t.objectStore('expense_lines');
    for (const l of await wrap(lines.getAll())) {
      if (l.item_id !== itemId) continue;
      lines.put({ ...l, purchase_id: null, stock_qty: 0, item_id: mode === 'delete' ? null : l.item_id });
    }
    const items = t.objectStore('items');
    if (mode === 'delete') {
      items.delete(itemId);
      const links = t.objectStore('name_links');
      for (const l of await wrap(links.getAll())) if (l.item_id === itemId) links.delete(l.name);
    } else {
      const item = await wrap(items.get(itemId));
      if (item) items.put({ ...item, initial_stock: initialStock, created_at: new Date().toISOString(), archived: false });
    }
    await finished;
    return counts;
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

  // ── adjustments（在庫の数え直し）────────────────────────────────────────

  async function getAdjustmentsByItem(itemId) {
    const t = await tx('adjustments');
    return wrap(t.objectStore('adjustments').index('item_id').getAll(itemId));
  }

  async function addAdjustment(a) {
    const t = await tx('adjustments', 'readwrite');
    const id = await wrap(t.objectStore('adjustments').add(a));
    return { ...a, id };
  }

  async function deleteAdjustment(id) {
    const t = await tx('adjustments', 'readwrite');
    return wrap(t.objectStore('adjustments').delete(id));
  }

  // ── expenses（支出）────────────────────────────────────────────────────────
  //
  // 支出・購入品の行・在庫の「買った」記録は1つのトランザクションで書き、
  // 片方だけ保存されて在庫と家計簿がずれることがないようにする。

  const EXPENSE_STORES = ['expenses', 'expense_lines', 'purchases', 'items', 'name_links'];

  function done(t) {
    return new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('保存を中止しました'));
    });
  }

  async function getExpensesBetween(fromDate, toDate) {   // 'YYYY-MM-DD'（両端を含む）
    const t = await tx('expenses');
    return wrap(t.objectStore('expenses').index('spent_on').getAll(IDBKeyRange.bound(fromDate, toDate)));
  }

  async function getAllExpenses() {
    const t = await tx('expenses');
    return wrap(t.objectStore('expenses').getAll());
  }

  async function getExpense(id) {
    const t = await tx(['expenses', 'expense_lines']);
    const exp = await wrap(t.objectStore('expenses').get(id));
    if (!exp) return null;
    const lines = await wrap(t.objectStore('expense_lines').index('expense_id').getAll(id));
    return { ...exp, lines: lines.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) };
  }

  async function getLinesByExpenseIds(ids) {
    const t = await tx('expense_lines');
    const idx = t.objectStore('expense_lines').index('expense_id');
    const rows = await Promise.all(ids.map(id => wrap(idx.getAll(id))));
    return rows.flat();
  }

  async function getNameLinks() {
    const t = await tx('name_links');
    return wrap(t.objectStore('name_links').getAll());
  }

  // 既存の支出の行と、そこから作った「買った」記録を消す（同じトランザクション内）
  // keepPurchases: 「買った」の記録は消さずに、支出との紐づけだけ外す（以前の明細を1件にまとめるとき）
  async function removeExpenseRecords(t, expenseId, keepPurchases = false) {
    const lineStore = t.objectStore('expense_lines');
    const purchases = t.objectStore('purchases');
    const lines = await wrap(lineStore.index('expense_id').getAll(expenseId));
    for (const l of lines) {
      if (l.purchase_id != null) {
        if (keepPurchases) {
          const p = await wrap(purchases.get(l.purchase_id));
          if (p) {
            const { expense_id: _e, expense_line_id: _l, ...rest } = p;
            purchases.put(rest);
          }
        } else {
          purchases.delete(l.purchase_id);
        }
      }
      lineStore.delete(l.id);
    }
  }

  // expense: { id?, spent_on, store, payment, mode, total, category, memo }
  // lines:   [{ name, amount, qty, category, item_id, stock_qty }]
  // 紐づいた行は purchases に { source: 'expense' } で「買った」を記録し、品目の単価も更新する
  async function saveExpense(expense, lines, { keepPurchases = false } = {}) {
    const db = await open();
    const t = db.transaction(EXPENSE_STORES, 'readwrite');
    const finished = done(t);
    const now = new Date().toISOString();
    const { lines: _ignore, ...head } = expense;
    if (head.id != null) await removeExpenseRecords(t, head.id, keepPurchases);
    const record = { ...head, updated_at: now, created_at: head.created_at || now };
    if (record.id == null) delete record.id;
    const expenseId = await wrap(t.objectStore('expenses').put(record));
    // 購入時刻: 当日の入力なら今の時刻、過去日ならその日の正午（日付がずれないように）
    const purchasedAt = head.spent_on === localDateStr(new Date())
      ? now
      : new Date(`${head.spent_on}T12:00:00`).toISOString();

    for (const [order, line] of lines.entries()) {
      const row = { ...line, expense_id: expenseId, order, purchase_id: null };
      delete row.id;
      const lineId = await wrap(t.objectStore('expense_lines').add(row));
      if (line.item_id != null && line.stock_qty > 0) {
        const purchaseId = await wrap(t.objectStore('purchases').add({
          item_id: line.item_id, purchased_at: purchasedAt, quantity: line.stock_qty,
          source: 'expense', expense_id: expenseId, expense_line_id: lineId,
        }));
        t.objectStore('expense_lines').put({ ...row, id: lineId, purchase_id: purchaseId });
        if (line.amount > 0) {
          const item = await wrap(t.objectStore('items').get(line.item_id));
          if (item) t.objectStore('items').put({ ...item, unit_price: Math.round(line.amount / line.stock_qty) });
        }
      }
      const key = normalizeName(line.name);
      if (key && line.item_id != null && line.stock_qty > 0) {
        t.objectStore('name_links').put({
          name: key, item_id: line.item_id,
          stock_per_qty: line.qty > 0 ? line.stock_qty / line.qty : 1,
        });
      }
    }
    await finished;
    return expenseId;
  }

  async function deleteExpense(id) {
    const db = await open();
    const t = db.transaction(EXPENSE_STORES, 'readwrite');
    const finished = done(t);
    await removeExpenseRecords(t, id);
    t.objectStore('expenses').delete(id);
    await finished;
  }

  // 履歴から「買った」を消したとき、支出の行は残して紐づけだけ外す
  async function detachPurchaseFromExpense(purchase) {
    if (purchase?.expense_line_id == null) return;
    const t = await tx('expense_lines', 'readwrite');
    const s = t.objectStore('expense_lines');
    const line = await wrap(s.get(purchase.expense_line_id));
    if (line) await wrap(s.put({ ...line, purchase_id: null, stock_qty: 0 }));
  }

  function normalizeName(name) {
    return String(name || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  }

  function localDateStr(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ── settings ──────────────────────────────────────────────────────────────

  const DEFAULT_SETTINGS = {
    id: 1, lead_time_days: 3, safety_margin_days: 2,
    notify_time: '08:00', shopping_weekday: null, last_notified_date: null,
    last_export_date: null, last_seen_version: null,
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

  const DATA_STORES = ['items', 'purchases', 'openings', 'adjustments', 'expenses', 'expense_lines', 'name_links'];
  const STORES = [...DATA_STORES, 'settings'];

  async function exportAll() {
    const db = await open();
    const t = db.transaction(STORES, 'readonly');
    const rows = await Promise.all(DATA_STORES.map(name => wrap(t.objectStore(name).getAll())));
    const settings = await wrap(t.objectStore('settings').get(1));
    const data = Object.fromEntries(DATA_STORES.map((name, i) => [name, rows[i]]));
    return { ...data, settings: settings ?? {} };
  }

  async function importAll(data) {
    const db = await open();
    const t = db.transaction(STORES, 'readwrite');
    for (const name of DATA_STORES) {
      t.objectStore(name).clear();
      for (const rec of data[name] ?? []) t.objectStore(name).put(rec);
    }
    if (data.settings && Object.keys(data.settings).length) {
      t.objectStore('settings').put({ ...DEFAULT_SETTINGS, ...data.settings, id: 1 });
    }
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  return {
    getItems, getItem, addItem, putItem,
    getPurchasesByItem, addPurchase, getPurchase, updatePurchase, deletePurchase,
    getOpeningsByItem, addOpening, getOpening, deleteOpening,
    getAdjustmentsByItem, addAdjustment, deleteAdjustment,
    getExpensesBetween, getAllExpenses, getExpense, getLinesByExpenseIds, getNameLinks,
    saveExpense, deleteExpense, detachPurchaseFromExpense, normalizeName,
    getArchivedItems, removeItemRecords,
    getSettings, putSettings,
    exportAll, importAll,
  };
})();

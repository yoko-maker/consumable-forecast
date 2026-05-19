// app.js — メインアプリケーション（IndexedDB 完全オフライン版）

// ── 品目 + 予測データの取得 ──────────────────────────────────────────────────

async function loadItemWithEstimate(item, settings) {
  const purchases = await DB.getPurchasesByItem(item.id);
  const openings  = await DB.getOpeningsByItem(item.id);

  const purchaseQtySum = purchases.reduce((s, p) => s + (p.quantity || 1), 0);
  const openingDates   = openings
    .map(o => new Date(o.opened_at))
    .sort((a, b) => a - b);

  const currentStock = calcStock(item.initial_stock || 0, purchaseQtySum, openings.length);
  const est = estimate(openingDates, currentStock, {
    packageQty:        item.package_qty,
    priorIntervalDays: item.prior_interval_days,
    leadTime:          settings.lead_time_days    || 3,
    safetyMargin:      settings.safety_margin_days || 2,
  });

  const lastPurchase = purchases.length
    ? purchases.sort((a, b) => b.purchased_at.localeCompare(a.purchased_at))[0].purchased_at
    : null;
  const lastOpening = openings.length
    ? openings.sort((a, b) => b.opened_at.localeCompare(a.opened_at))[0].opened_at
    : null;

  return {
    ...item, ...est,
    last_purchase: lastPurchase,
    last_opening:  lastOpening,
    status: computeStatus(est.notifyDate, est.expectedRunout),
  };
}

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  view: 'home',
  items: [],
  settings: {},
  soonItems: [],
  checkedIds: new Set(),
};

// ── Render helpers ───────────────────────────────────────────────────────────

function statusClass(s) {
  return s === 'overdue' ? 'overdue' : s === 'soon' ? 'soon' : 'ok';
}
function statusLabel(s) {
  return s === 'overdue' ? '⚠ 枯渇超過' : s === 'soon' ? '🔔 そろそろ' : '✓ 余裕あり';
}

function daysUntil(date) {
  if (!date) return null;
  const diff = Math.round((new Date(date) - Date.now()) / 86400000);
  if (diff < 0)  return `${-diff}日前に切れ`;
  if (diff === 0) return '今日が目安';
  return `あと${diff}日`;
}

function fmt(date) {
  if (!date) return '−';
  return new Date(date).toISOString().slice(0, 10);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stockLabel(item) {
  const s = item.currentStock ?? item.current_stock ?? 0;
  const unit = item.stock_unit || '個';
  if (item.package_qty && item.package_qty !== 1) {
    return `${s}${unit}（計${s * item.package_qty}${unit}分）`;
  }
  return `${s}${unit}`;
}

// ── Render views ─────────────────────────────────────────────────────────────

function renderHome() {
  if (!state.items.length) {
    return `<div class="empty">
      <p>まだ品目がありません。</p>
      <button class="btn-primary" onclick="showView('add')">+ 品目を追加</button>
    </div>`;
  }
  return state.items.map(item => {
    const days = daysUntil(item.expectedRunout);
    const hasEst = !!item.expectedRunout;
    return `
    <div class="card status-${statusClass(item.status)}">
      <div class="card-header">
        <span class="item-name">${esc(item.name)}</span>
        <span class="badge badge-${statusClass(item.status)}">${statusLabel(item.status)}</span>
      </div>
      <div class="card-stock">在庫: <strong>${stockLabel(item)}</strong></div>
      <div class="card-body">
        ${hasEst
          ? `<span class="runout-label">次回購入目安:</span>
             <span class="runout">${days}</span>
             ${item.depletionLow && item.depletionHigh
               ? `<span class="range">(${fmt(item.depletionLow)}〜${fmt(item.depletionHigh)})</span>`
               : ''}
             ${!item.learning ? '<span class="learning-badge">学習中</span>' : ''}`
          : '<span class="runout-label no-estimate">使用開始を記録すると予測が始まります</span>'}
      </div>
      <div class="card-actions">
        <button class="btn-buy"  id="buy-btn-${item.id}"
          onclick="recordPurchase(${item.id},this)">買った</button>
        <button class="btn-open" id="open-btn-${item.id}"
          onclick="recordOpening(${item.id},this)">使用開始</button>
        <button class="btn-icon" onclick="openEdit(${item.id})" title="編集">✏</button>
      </div>
    </div>`;
  }).join('');
}

function renderSoon() {
  if (!state.soonItems.length) {
    return '<div class="empty"><p>現在、そろそろリストはありません。</p></div>';
  }
  return `
    <p class="hint">チェックした品目を「買った」として記録します。</p>
    ${state.soonItems.map(item => `
      <label class="soon-item">
        <input type="checkbox" value="${item.id}"
          ${state.checkedIds.has(item.id) ? 'checked' : ''}
          onchange="toggleCheck(${item.id},this.checked)">
        <div class="soon-info">
          <span class="soon-name">${esc(item.name)}</span>
          <span class="soon-stock">在庫: ${(item.currentStock ?? 0)}${item.stock_unit || '個'}</span>
        </div>
        <span class="runout">${daysUntil(item.expectedRunout) ?? '−'}</span>
      </label>`).join('')}
    <button class="btn-primary" onclick="submitChecked()" style="margin-top:16px">
      チェックした品目を「買った」として記録
    </button>`;
}

function renderAdd() {
  return `
    <form onsubmit="submitItem(event)">
      <label>品目名 <span class="req">*</span>
        <input type="text" id="f-name" required placeholder="例: シャンプー">
      </label>
      <label>現在の在庫数
        <input type="number" id="f-stock" step="0.5" min="0" value="0">
      </label>
      <label>在庫の単位
        <input type="text" id="f-unit" placeholder="個" value="個">
      </label>
      <details>
        <summary class="detail-toggle">詳細設定（任意）</summary>
        <div class="detail-body">
          <label>パッケージ量（1つあたりの量）
            <input type="number" id="f-qty" step="0.1" min="0.1" placeholder="例: 500（ml）">
          </label>
          <label>初期消費ペース申告（日）
            <input type="number" id="f-prior" step="1" min="1" placeholder="例: 30（月1回）">
          </label>
          <label>単価（円）
            <input type="number" id="f-price" step="1" min="0" placeholder="任意">
          </label>
        </div>
      </details>
      <div class="form-actions">
        <button type="submit" class="btn-primary">登録</button>
        <button type="button" class="btn-ghost" onclick="showView('home')">キャンセル</button>
      </div>
    </form>`;
}

function renderSettings() {
  const s = state.settings;
  return `
    <form onsubmit="submitSettings(event)">
      <label>買い物リードタイム（日）
        <input type="number" id="s-lead" min="0" value="${s.lead_time_days ?? 3}">
      </label>
      <label>安全マージン（日）
        <input type="number" id="s-margin" min="0" value="${s.safety_margin_days ?? 2}">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn-primary">保存</button>
      </div>
    </form>
    <hr>
    <h3>データ管理</h3>
    <div class="data-actions">
      <button class="btn-ghost" onclick="exportData()">エクスポート (JSON)</button>
      <label class="btn-ghost" style="cursor:pointer">インポート (JSON)
        <input type="file" accept=".json" style="display:none" onchange="importData(event)">
      </label>
      <button class="btn-danger" onclick="confirmDeleteAll()">全データ削除</button>
    </div>`;
}

function render() {
  const main = document.getElementById('main');
  switch (state.view) {
    case 'home':     main.innerHTML = renderHome();     break;
    case 'soon':     main.innerHTML = renderSoon();     break;
    case 'add':      main.innerHTML = renderAdd();      break;
    case 'settings': main.innerHTML = renderSettings(); break;
  }
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === state.view)
  );
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  state.settings = await DB.getSettings();
  const rawItems = await DB.getItems();
  state.items = await Promise.all(
    rawItems.map(item => loadItemWithEstimate(item, state.settings))
  );
  state.soonItems = state.items.filter(item => {
    if (!item.expectedRunout) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const n = item.notifyDate ? new Date(item.notifyDate) : null;
    return n && today >= n;
  });
  render();
}

function showView(v) { state.view = v; render(); }

// ── 取り消しボタン ────────────────────────────────────────────────────────────

function showUndo(anchorId, onUndo) {
  const anchor = document.getElementById(anchorId);
  if (!anchor) return;
  const btn = document.createElement('button');
  btn.className = 'btn-undo';
  btn.textContent = '取り消す';
  btn.onclick = async () => { btn.disabled = true; await onUndo(); await loadAll(); };
  anchor.insertAdjacentElement('afterend', btn);
  setTimeout(() => btn.remove(), 5000);
}

// ── 買った ───────────────────────────────────────────────────────────────────

async function recordPurchase(itemId, btn) {
  if (btn) btn.disabled = true;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const purchases = await DB.getPurchasesByItem(itemId);
    const todayRec = purchases.find(
      p => p.purchased_at.slice(0, 10) === today && p.source !== 'import'
    );
    let savedId;
    if (todayRec) {
      await DB.updatePurchase({ ...todayRec, quantity: todayRec.quantity + 1 });
      savedId = todayRec.id;
    } else {
      const p = await DB.addPurchase({ item_id: itemId, purchased_at: now, quantity: 1, source: 'manual' });
      savedId = p.id;
    }
    await loadAll();
    showUndo(`buy-btn-${itemId}`, async () => {
      const rec = await DB.getPurchase(savedId);
      if (!rec) return;
      if (rec.quantity > 1) await DB.updatePurchase({ ...rec, quantity: rec.quantity - 1 });
      else await DB.deletePurchase(savedId);
    });
  } catch (e) {
    alert('記録に失敗しました: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

// ── 使用開始 ─────────────────────────────────────────────────────────────────

async function recordOpening(itemId, btn) {
  if (btn) btn.disabled = true;
  const now = new Date().toISOString();
  try {
    const o = await DB.addOpening({ item_id: itemId, opened_at: now, source: 'manual' });
    await loadAll();
    showUndo(`open-btn-${itemId}`, () => DB.deleteOpening(o.id));
  } catch (e) {
    alert('記録に失敗しました: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

// ── そろそろリスト ────────────────────────────────────────────────────────────

function toggleCheck(id, checked) {
  if (checked) state.checkedIds.add(id);
  else state.checkedIds.delete(id);
}

async function submitChecked() {
  if (!state.checkedIds.size) return;
  const now = new Date().toISOString();
  try {
    for (const id of state.checkedIds) {
      await DB.addPurchase({ item_id: id, purchased_at: now, quantity: 1, source: 'list' });
    }
    state.checkedIds.clear();
    await loadAll();
    showView('home');
  } catch (e) {
    alert('記録に失敗しました: ' + e.message);
  }
}

// ── 品目登録 ─────────────────────────────────────────────────────────────────

async function submitItem(e) {
  e.preventDefault();
  const name = document.getElementById('f-name').value.trim();
  if (!name) return;
  const item = {
    name,
    initial_stock: parseFloat(document.getElementById('f-stock').value) || 0,
    stock_unit:    document.getElementById('f-unit').value.trim() || '個',
    archived:      false,
    created_at:    new Date().toISOString(),
  };
  const qty   = parseFloat(document.getElementById('f-qty').value);
  const prior = parseFloat(document.getElementById('f-prior').value);
  const price = parseFloat(document.getElementById('f-price').value);
  if (!isNaN(qty))   item.package_qty         = qty;
  if (!isNaN(prior)) item.prior_interval_days = prior;
  if (!isNaN(price)) item.unit_price          = price;
  try {
    await DB.addItem(item);
    await loadAll();
    showView('home');
  } catch (e) {
    alert('登録に失敗しました: ' + e.message);
  }
}

// ── 設定保存 ─────────────────────────────────────────────────────────────────

async function submitSettings(e) {
  e.preventDefault();
  const updated = {
    ...state.settings,
    lead_time_days:    parseInt(document.getElementById('s-lead').value),
    safety_margin_days: parseInt(document.getElementById('s-margin').value),
  };
  try {
    await DB.putSettings(updated);
    state.settings = updated;
    await loadAll();
    alert('設定を保存しました');
  } catch (e) {
    alert('保存に失敗しました: ' + e.message);
  }
}

// ── 編集ダイアログ ────────────────────────────────────────────────────────────

let editingItemId = null;
function openEdit(id) {
  editingItemId = id;
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  document.getElementById('e-name').value  = item.name;
  document.getElementById('e-stock').value = item.initial_stock ?? 0;
  document.getElementById('e-unit').value  = item.stock_unit ?? '個';
  document.getElementById('e-qty').value   = item.package_qty ?? '';
  document.getElementById('e-prior').value = item.prior_interval_days ?? '';
  document.getElementById('e-price').value = item.unit_price ?? '';
  document.getElementById('edit-dialog').showModal();
}

async function submitEdit(e) {
  e.preventDefault();
  const item = await DB.getItem(editingItemId);
  if (!item) return;
  const name  = document.getElementById('e-name').value.trim();
  const stock = document.getElementById('e-stock').value;
  const unit  = document.getElementById('e-unit').value.trim();
  const qty   = parseFloat(document.getElementById('e-qty').value);
  const prior = parseFloat(document.getElementById('e-prior').value);
  const price = parseFloat(document.getElementById('e-price').value);
  if (name)        item.name          = name;
  if (stock !== '') item.initial_stock = parseFloat(stock);
  if (unit)        item.stock_unit    = unit;
  if (!isNaN(qty))   item.package_qty         = qty;
  if (!isNaN(prior)) item.prior_interval_days = prior;
  if (!isNaN(price)) item.unit_price          = price;
  try {
    await DB.putItem(item);
    document.getElementById('edit-dialog').close();
    await loadAll();
  } catch (e) {
    alert('更新に失敗しました: ' + e.message);
  }
}

async function archiveItem() {
  if (!confirm('この品目をアーカイブしますか？')) return;
  const item = await DB.getItem(editingItemId);
  if (!item) return;
  try {
    await DB.putItem({ ...item, archived: true });
    document.getElementById('edit-dialog').close();
    await loadAll();
  } catch (e) {
    alert('失敗しました: ' + e.message);
  }
}

// ── データ管理 ────────────────────────────────────────────────────────────────

async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `consumable-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await DB.importAll(data);
    await loadAll();
    alert('インポートしました');
  } catch (err) {
    alert('インポート失敗: ' + err.message);
  }
}

async function confirmDeleteAll() {
  if (!confirm('全データを削除します。この操作は取り消せません。')) return;
  await DB.importAll({ items: [], purchases: [], openings: [] });
  await loadAll();
}

// ── 起動時通知チェック ────────────────────────────────────────────────────────

async function checkAndNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const today = new Date().toISOString().slice(0, 10);
  const settings = await DB.getSettings();
  if (settings.last_notified_date === today) return;

  const soonNames = state.soonItems.map(i => i.name);
  if (!soonNames.length) return;

  const body = soonNames.length === 1
    ? `「${soonNames[0]}」の補充時期です`
    : `${soonNames.length}点の補充時期です（${soonNames.slice(0, 2).join('、')}ほか）`;

  new Notification('消耗品ストック予測', { body, icon: './icon-192.png' });
  await DB.putSettings({ ...settings, last_notified_date: today });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

window.addEventListener('DOMContentLoaded', async () => {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'soon') state.view = 'soon';

  document.querySelectorAll('.nav-tab').forEach(t =>
    t.addEventListener('click', () => showView(t.dataset.view))
  );
  document.getElementById('btn-add').addEventListener('click', () => showView('add'));
  document.getElementById('edit-form').addEventListener('submit', submitEdit);
  document.getElementById('btn-archive').addEventListener('click', archiveItem);
  document.getElementById('btn-close-edit').addEventListener('click', () =>
    document.getElementById('edit-dialog').close()
  );

  await loadAll();
  await checkAndNotify();
});

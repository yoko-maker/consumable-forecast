// app.js — メインアプリケーション（IndexedDB 完全オフライン版）

// ── 絵文字 ───────────────────────────────────────────────────────────────────

const EMOJI_CHOICES = [
  '🧴', '🧻', '🪥', '🧼', '🧽', '🧺', '☕', '🍵', '🍚', '🥫',
  '💊', '😷', '🔋', '💡', '🗑️', '🐾', '👁️', '🪒', '🧂', '📦',
];

// 品目名から絵文字を推測（未選択時の自動表示）
const EMOJI_RULES = [
  [/シャンプー|リンス|コンディショナー|ボディソープ|ハンドソープ|化粧水|乳液|ローション/, '🧴'],
  [/トイレ|ペーパー|ティッシュ/, '🧻'],
  [/歯磨|歯ブラシ|フロス/, '🪥'],
  [/洗剤|石鹸|せっけん|柔軟剤|漂白/, '🧼'],
  [/スポンジ/, '🧽'],
  [/コーヒー|珈琲/, '☕'],
  [/お茶|茶葉|紅茶|緑茶/, '🍵'],
  [/米|パスタ|麺/, '🍚'],
  [/缶|レトルト/, '🥫'],
  [/薬|サプリ|ビタミン/, '💊'],
  [/マスク/, '😷'],
  [/電池|バッテリー/, '🔋'],
  [/電球|蛍光灯/, '💡'],
  [/ゴミ袋|ごみ袋|ポリ袋/, '🗑️'],
  [/ペット|猫砂|キャット|ドッグ|フード/, '🐾'],
  [/コンタクト|目薬/, '👁️'],
  [/カミソリ|剃刀|替刃/, '🪒'],
  [/塩|砂糖|醤油|しょうゆ|味噌|調味料|油/, '🧂'],
];

function guessEmoji(name) {
  for (const [re, e] of EMOJI_RULES) if (re.test(name)) return e;
  return '📦';
}

function itemEmoji(item) {
  return item.emoji || guessEmoji(item.name || '');
}

// ── 品目 + 予測データの取得 ──────────────────────────────────────────────────

const validDate = d => !isNaN(d);

async function loadItemWithEstimate(item, settings) {
  const [purchases, openings, adjustments] = await Promise.all([
    DB.getPurchasesByItem(item.id),
    DB.getOpeningsByItem(item.id),
    DB.getAdjustmentsByItem(item.id),
  ]);

  const purchaseEvents = purchases
    .map(p => ({ at: new Date(p.purchased_at), qty: p.quantity ?? 1 }))
    .filter(p => validDate(p.at));
  const openingDates = openings
    .map(o => new Date(o.opened_at))
    .filter(validDate)
    .sort((a, b) => a - b);
  const adjustEvents = adjustments
    .map(a => ({ at: new Date(a.adjusted_at), value: a.value }))
    .filter(a => validDate(a.at));

  const { stock, emptyAfter } = stockTimeline(
    item.initial_stock || 0, purchaseEvents, openingDates, adjustEvents
  );
  const est = estimate(openingDates, stock, {
    packageQty:        item.package_qty,
    priorIntervalDays: item.prior_interval_days,
    leadTime:          settings.lead_time_days     ?? 3,
    safetyMargin:      settings.safety_margin_days ?? 2,
    start:             item.created_at ? new Date(item.created_at) : null,
    emptyAfter,
  });

  const latest = (rows, key) =>
    rows.reduce((m, r) => (m === null || r[key] > m ? r[key] : m), null);

  return {
    ...item, ...est,
    last_purchase: latest(purchases, 'purchased_at'),
    last_opening:  latest(openings, 'opened_at'),
    // 単価は1個（1パッケージ）あたり → 30日あたりの出費
    monthlyCost: item.unit_price != null && est.intervalDays
      ? item.unit_price * 30 / est.intervalDays
      : null,
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
  storagePersisted: null,
  update: null,        // { version, changes } 新しいバージョンが待機中
  justUpdated: null,   // 更新直後に変更点を見せるバージョン
  installPrompt: null, // beforeinstallprompt イベント（インストールボタン用）
};

// ── Format helpers ───────────────────────────────────────────────────────────

const WEEKDAYS = '日月火水木金土';
const pad2 = n => String(n).padStart(2, '0');

// ローカル時刻の YYYY-MM-DD（toISOString は UTC なので JST 0〜9時に前日になる）
function localDate(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// <input type="datetime-local"> 用の値
function localDateTimeInput(date = new Date()) {
  const d = new Date(date);
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmt(date) {
  if (!date) return '−';
  return localDate(date);
}

// 範囲表示用の短い日付（M/D、年が違えば YYYY/M/D）
function fmtShort(date) {
  const d = new Date(date);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : '';
  return `${y}${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtRange(low, high) {
  const a = fmtShort(low), b = fmtShort(high);
  return a === b ? a : `${a}〜${b}`;
}

function fmtDateTime(date) {
  const d = new Date(date);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : '';
  return `${y}${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 暦日での差（今日=0）
function dayDiff(date) {
  const a = new Date(date); a.setHours(0, 0, 0, 0);
  const t = new Date();     t.setHours(0, 0, 0, 0);
  return Math.round((a - t) / MS_PER_DAY);
}

function daysUntil(date) {
  if (!date) return null;
  const diff = dayDiff(date);
  if (diff < 0)   return `${-diff}日前に切れ`;
  if (diff === 0) return '今日が目安';
  return `あと${diff}日`;
}

const fmtNum = n => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
const yen = n => '¥' + Math.round(n).toLocaleString('ja-JP');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stockLabel(item) {
  const s = item.currentStock ?? 0;
  const unit = esc(item.stock_unit || '個');
  if (s > 0 && item.package_qty && item.package_unit) {
    return `${fmtNum(s)}${unit}（計${fmtNum(s * item.package_qty)}${esc(item.package_unit)}）`;
  }
  return `${fmtNum(s)}${unit}`;
}

// ── Render helpers ───────────────────────────────────────────────────────────

function statusClass(s) {
  return s === 'overdue' ? 'overdue' : s === 'soon' ? 'soon' : 'ok';
}
function statusLabel(s) {
  return s === 'overdue' ? '⚠ 枯渇超過' : s === 'soon' ? '🔔 そろそろ' : '✓ 余裕あり';
}

const STATUS_RANK = { overdue: 0, soon: 1, ok: 2 };

// 急ぐ順: 超過 → そろそろ → 余裕あり（予測日が近い順）→ 予測なし
function sortByUrgency(items) {
  return [...items].sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || (a.expectedRunout ? 0 : 1) - (b.expectedRunout ? 0 : 1)
    || (a.expectedRunout && b.expectedRunout ? a.expectedRunout - b.expectedRunout : 0)
    || a.name.localeCompare(b.name, 'ja')
  );
}

// 残量のビン（アイコンのキャラクター）。中身は次の補充までの残り時間の割合
function jarSvg(item) {
  let frac = 0.5;
  if (item.expectedRunout && item.periodStart) {
    const total = item.expectedRunout - item.periodStart;
    frac = total > 0 ? Math.min(Math.max((item.expectedRunout - Date.now()) / total, 0), 1) : 0;
  }
  const fills = { ok: '#ffc44d', soon: '#f59e0b', overdue: '#f87171' };
  const fill  = item.expectedRunout ? fills[statusClass(item.status)] : '#cbd5e1';
  const mouth = {
    ok:      'M16 28 Q20 32 24 28',
    soon:    'M16.5 29.5 L23.5 29.5',
    overdue: 'M16 31 Q20 27 24 31',
  }[statusClass(item.status)];
  const top = 11 + 33 * (1 - frac);
  const clip = `jar-clip-${item.id}`;
  return `
    <svg class="jar" viewBox="0 0 40 48" aria-hidden="true">
      <defs><clipPath id="${clip}"><rect x="6" y="11" width="28" height="33" rx="7"/></clipPath></defs>
      <rect x="4" y="9" width="32" height="37" rx="9" fill="#fff" stroke="#cbd5e1" stroke-width="2"/>
      <rect x="6" y="${top.toFixed(1)}" width="28" height="40" fill="${fill}" clip-path="url(#${clip})"/>
      <rect x="7" y="2" width="26" height="9" rx="3.5" fill="#ff8a8a"/>
      <circle cx="15" cy="23" r="2" fill="#2d376e"/>
      <circle cx="25" cy="23" r="2" fill="#2d376e"/>
      <path d="${mouth}" stroke="#2d376e" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    </svg>`;
}

// ── Render views ─────────────────────────────────────────────────────────────

function renderSummary() {
  const over = state.items.filter(i => i.status === 'overdue').length;
  const soon = state.items.filter(i => i.status === 'soon').length;
  const costs = state.items.filter(i => i.monthlyCost != null);
  const monthly = costs.reduce((s, i) => s + i.monthlyCost, 0);

  const chips = [];
  if (over) chips.push(`<button class="chip chip-overdue" onclick="showView('soon')">⚠ 超過 ${over}件</button>`);
  if (soon) chips.push(`<button class="chip chip-soon" onclick="showView('soon')">🔔 そろそろ ${soon}件</button>`);
  if (!over && !soon) chips.push('<span class="chip chip-ok">✓ ぜんぶ余裕あり</span>');
  if (costs.length) chips.push(`<span class="chip chip-cost" title="単価を登録した品目の合計">💴 月あたり約${yen(monthly)}</span>`);
  return `<div class="summary">${chips.join('')}</div>`;
}

function backupBanner() {
  if (!state.items.length) return '';
  const last = state.settings.last_export_date;
  if (last) {
    const days = -dayDiff(last);
    if (days < 30) return '';
    return `<div class="banner">💾 前回のバックアップから${days}日たちました
      <button class="btn-ghost btn-small" onclick="exportData()">今すぐ保存</button></div>`;
  }
  const oldest = Math.min(...state.items.map(i => new Date(i.created_at || Date.now()).getTime()));
  if (-dayDiff(oldest) < 7) return '';
  return `<div class="banner">💾 データはこの端末の中だけにあります。バックアップしておきましょう
    <button class="btn-ghost btn-small" onclick="exportData()">保存する</button></div>`;
}

function renderHome() {
  if (!state.items.length) {
    return `<div class="empty">
      <img class="empty-mascot" src="./icon-192.png" alt="">
      <p>まだ品目がありません。<br>よく使う消耗品を登録してみましょう。</p>
      <button class="btn-primary" onclick="showView('add')">+ 品目を追加</button>
    </div>`;
  }
  return renderSummary() + backupBanner() + sortByUrgency(state.items).map(item => {
    const hasEst = !!item.expectedRunout;
    return `
    <div class="card status-${statusClass(item.status)}">
      <div class="card-main">
        ${jarSvg(item)}
        <div class="card-content">
          <div class="card-header">
            <button class="item-name" onclick="openHistory(${item.id})" title="履歴を見る">
              <span class="item-emoji">${itemEmoji(item)}</span>${esc(item.name)}
            </button>
            <span class="badge badge-${statusClass(item.status)}">${statusLabel(item.status)}</span>
          </div>
          <div class="card-stock">在庫: <strong>${stockLabel(item)}</strong></div>
          <div class="card-body">
            ${hasEst
              ? `<span class="runout-label">次回購入目安:</span>
                 <span class="runout">${daysUntil(item.expectedRunout)}</span>
                 ${item.depletionLow && item.depletionHigh
                   ? `<span class="range">(${fmtRange(item.depletionLow, item.depletionHigh)})</span>`
                   : ''}
                 ${!item.learning ? '<span class="learning-badge">学習中</span>' : ''}
                 ${item.monthlyCost != null ? `<span class="cost">月約${yen(item.monthlyCost)}</span>` : ''}`
              : '<span class="runout-label no-estimate">使用開始を記録すると予測が始まります</span>'}
          </div>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-buy"  id="buy-btn-${item.id}"
          onclick="recordPurchase(${item.id},this)">買った</button>
        <button class="btn-open" id="open-btn-${item.id}"
          onclick="recordOpening(${item.id},this)">使用開始</button>
        <button class="btn-icon" onclick="openEdit(${item.id})" title="編集" aria-label="編集">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
      </div>
    </div>`;
  }).join('');
}

function renderSoon() {
  if (!state.soonItems.length) {
    return `<div class="empty">
      <img class="empty-mascot" src="./icon-192.png" alt="">
      <p>いま買い足すものはありません。</p>
    </div>`;
  }
  return `
    <div class="soon-head">
      <p class="hint">チェックした品目を「買った」として記録します。</p>
      <button class="btn-ghost btn-small" onclick="shareSoonList()">📤 共有</button>
    </div>
    ${state.soonItems.map(item => `
      <label class="soon-item">
        <input type="checkbox" value="${item.id}"
          ${state.checkedIds.has(item.id) ? 'checked' : ''}
          onchange="toggleCheck(${item.id},this.checked)">
        <span class="item-emoji">${itemEmoji(item)}</span>
        <div class="soon-info">
          <span class="soon-name">${esc(item.name)}</span>
          <span class="soon-stock">在庫: ${stockLabel(item)}</span>
        </div>
        <span class="runout">${daysUntil(item.expectedRunout) ?? '−'}</span>
      </label>`).join('')}
    <button class="btn-primary" id="btn-submit-checked" onclick="submitChecked(this)" style="margin-top:16px">
      チェックした品目を「買った」として記録
    </button>`;
}

function emojiPickerHtml(prefix, selected = '') {
  return `
    <div class="emoji-picker">
      <input type="hidden" id="${prefix}-emoji" value="${esc(selected)}">
      <button type="button" class="emoji-opt ${!selected ? 'selected' : ''}" data-emoji=""
        title="品目名から自動で選びます">自動</button>
      ${EMOJI_CHOICES.map(e => `
        <button type="button" class="emoji-opt ${selected === e ? 'selected' : ''}"
          data-emoji="${e}">${e}</button>`).join('')}
    </div>`;
}

function renderAdd() {
  return `
    <form onsubmit="submitItem(event)">
      <label>品目名 <span class="req">*</span>
        <input type="text" id="f-name" required placeholder="例: シャンプー">
      </label>
      <div class="field">
        <span class="field-label">アイコン</span>
        ${emojiPickerHtml('f')}
      </div>
      <label>現在の在庫数（未開封）
        <input type="number" id="f-stock" step="0.5" min="0" value="0">
      </label>
      <label>在庫の単位
        <input type="text" id="f-unit" placeholder="個" value="個">
      </label>
      <details>
        <summary class="detail-toggle">詳細設定（任意）</summary>
        <div class="detail-body">
          <div class="row">
            <label>1つあたりの量
              <input type="number" id="f-qty" step="0.1" min="0.1" placeholder="例: 500">
            </label>
            <label>量の単位
              <input type="text" id="f-punit" placeholder="例: ml">
            </label>
          </div>
          <label>初期消費ペース申告（日）
            <input type="number" id="f-prior" step="1" min="1" placeholder="例: 30（月1回）">
          </label>
          <label>単価（円・1つあたり）
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

function renderNotifySection() {
  if (!('Notification' in window)) {
    return `<p class="hint">このブラウザは通知に対応していません。
      iPhone の場合は Safari の「ホーム画面に追加」から開くと通知を使えます（iOS 16.4 以降）。</p>`;
  }
  switch (Notification.permission) {
    case 'granted':
      return `<p class="status-line">✓ 通知はオンです。アプリを開いたときに、補充時期の品目を1日1回お知らせします。</p>
        <button class="btn-ghost" onclick="testNotification()">テスト通知を送る</button>`;
    case 'denied':
      return `<p class="status-line warn">通知がブロックされています。ブラウザのサイト設定から許可してください。</p>`;
    default:
      return `<p class="hint">補充時期になった品目をお知らせします。</p>
        <button class="btn-primary" onclick="enableNotifications()">🔔 通知を許可する</button>`;
  }
}

function renderStorageSection() {
  const last = state.settings.last_export_date;
  const lastText = last ? `最終バックアップ: ${fmt(last)}` : 'まだバックアップしていません';
  let persisted;
  if (state.storagePersisted === true) {
    persisted = '<p class="status-line">✓ データ保護オン（ブラウザが自動で削除しません）</p>';
  } else if (state.storagePersisted === false) {
    persisted = `<p class="status-line warn">⚠ 容量不足や長期間未使用のとき、ブラウザがデータを削除することがあります。
        ホーム画面に追加して使うと保護されやすくなります。</p>
      <button class="btn-ghost" onclick="requestPersist()">データ保護をリクエスト</button>`;
  } else {
    persisted = '';
  }
  return `${persisted}<p class="hint">${lastText}</p>`;
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function renderAboutSection() {
  let install;
  if (isStandalone()) {
    install = '<p class="status-line">✓ アプリとしてインストール済みです</p>';
  } else if (state.installPrompt) {
    install = '<button class="btn-primary" onclick="installApp()">📲 アプリとしてインストール</button>';
  } else {
    install = `<p class="hint">ブラウザのメニューから「ホーム画面に追加」（iPhone は Safari の共有ボタン →
      「ホーム画面に追加」）でアプリとして使えます。</p>`;
  }
  return `
    <p class="status-line">バージョン <strong>v${esc(self.APP_VERSION)}</strong></p>
    ${state.update
      ? `<button class="btn-primary" onclick="applyUpdate()">✨ v${esc(state.update.version)} に更新する</button>`
      : '<button class="btn-ghost" onclick="checkForUpdate(this)">更新を確認</button>'}
    ${install}`;
}

function renderSettings() {
  const s = state.settings;
  return `
    <form onsubmit="submitSettings(event)">
      <label>買い物リードタイム（日）
        <input type="number" id="s-lead" min="0" step="1" value="${s.lead_time_days ?? 3}">
      </label>
      <label>安全マージン（日）
        <input type="number" id="s-margin" min="0" step="1" value="${s.safety_margin_days ?? 2}">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn-primary">保存</button>
      </div>
    </form>
    <hr>
    <h3>通知</h3>
    <div class="section">${renderNotifySection()}</div>
    <hr>
    <h3>データ保護</h3>
    <div class="section">${renderStorageSection()}</div>
    <hr>
    <h3>アプリについて</h3>
    <div class="section">${renderAboutSection()}</div>
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

function renderNotice() {
  const el = document.getElementById('app-notice');
  if (state.update) {
    el.innerHTML = `
      <span>✨ 新しいバージョン（v${esc(state.update.version)}）があります</span>
      <button class="btn-small btn-notice" onclick="applyUpdate()">更新する</button>`;
    el.hidden = false;
  } else if (state.justUpdated) {
    el.innerHTML = `
      <div class="notice-body">
        <strong>🎉 v${esc(state.justUpdated)} に更新しました</strong>
        <ul>${(self.APP_CHANGES || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      </div>
      <button class="btn-close" onclick="dismissNotice()" aria-label="閉じる">✕</button>`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function dismissNotice() {
  state.justUpdated = null;
  renderNotice();
}

function render() {
  renderNotice();
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
  state.soonItems = sortByUrgency(state.items.filter(item => item.status !== 'ok'));
  // リストから外れた品目のチェックは捨てる
  const soonIds = new Set(state.soonItems.map(i => i.id));
  state.checkedIds = new Set([...state.checkedIds].filter(id => soonIds.has(id)));
  updateAppBadge();
  render();
}

function showView(v) { state.view = v; render(); }

// ── 汎用の選択ダイアログ ─────────────────────────────────────────────────────

function choose(title, message, options) {
  const dlg = document.getElementById('choice-dialog');
  dlg.querySelector('#choice-title').textContent = title;
  dlg.querySelector('#choice-message').textContent = message;
  const box = dlg.querySelector('.choice-actions');
  box.innerHTML = '';
  return new Promise(resolve => {
    let result = null;
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = o.primary ? 'btn-primary' : 'btn-ghost';
      b.textContent = o.label;
      b.onclick = () => { result = o.value; dlg.close(); };
      box.appendChild(b);
    }
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
  });
}

// ── 取り消しボタン ────────────────────────────────────────────────────────────

function showUndo(anchorId, onUndo) {
  const anchor = document.getElementById(anchorId);
  if (!anchor) return;
  const btn = document.createElement('button');
  btn.className = 'btn-undo';
  btn.textContent = '取り消す';
  btn.onclick = async () => { btn.disabled = true; await onUndo(); await loadAll(); };
  anchor.parentElement.appendChild(btn);
  setTimeout(() => btn.remove(), 5000);
}

// ── 買った ───────────────────────────────────────────────────────────────────

async function recordPurchase(itemId, btn) {
  if (btn) btn.disabled = true;
  const now = new Date().toISOString();
  const today = localDate();

  try {
    const purchases = await DB.getPurchasesByItem(itemId);
    const todayRec = purchases.find(
      p => localDate(p.purchased_at) === today && p.source === 'manual'
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
  const item = state.items.find(i => i.id === itemId);
  let alsoPurchase = false;
  if (item && (item.currentStock ?? 0) <= 0) {
    const choice = await choose(
      '在庫が0になっています',
      `「${item.name}」の「買った」の記録が抜けていませんか？`,
      [
        { value: 'both', label: '買ったも記録して使用開始', primary: true },
        { value: 'open', label: '使用開始だけ記録' },
        { value: null,   label: 'やめる' },
      ],
    );
    if (!choice) return;
    alsoPurchase = choice === 'both';
  }

  if (btn) btn.disabled = true;
  const now = new Date().toISOString();
  try {
    // 同時刻なら 購入 → 使用開始 の順に数えられる
    const p = alsoPurchase
      ? await DB.addPurchase({ item_id: itemId, purchased_at: now, quantity: 1, source: 'manual' })
      : null;
    const o = await DB.addOpening({ item_id: itemId, opened_at: now, source: 'manual' });
    await loadAll();
    showUndo(`open-btn-${itemId}`, async () => {
      await DB.deleteOpening(o.id);
      if (p) await DB.deletePurchase(p.id);
    });
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

async function submitChecked(btn) {
  if (!state.checkedIds.size) return;
  if (btn) btn.disabled = true;
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
    if (btn) btn.disabled = false;
  }
}

async function shareSoonList() {
  const targets = state.checkedIds.size
    ? state.soonItems.filter(i => state.checkedIds.has(i.id))
    : state.soonItems;
  const text = '🛒 買い物リスト\n' + targets
    .map(i => `・${itemEmoji(i)} ${i.name}（${daysUntil(i.expectedRunout) ?? '−'}）`)
    .join('\n');
  try {
    if (navigator.share) {
      await navigator.share({ title: '買い物リスト', text });
    } else {
      await navigator.clipboard.writeText(text);
      alert('買い物リストをコピーしました');
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert('共有に失敗しました: ' + e.message);
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
  const emoji = document.getElementById('f-emoji').value;
  const punit = document.getElementById('f-punit').value.trim();
  const qty   = parseFloat(document.getElementById('f-qty').value);
  const prior = parseFloat(document.getElementById('f-prior').value);
  const price = parseFloat(document.getElementById('f-price').value);
  if (emoji)         item.emoji               = emoji;
  if (punit)         item.package_unit        = punit;
  if (!isNaN(qty))   item.package_qty         = qty;
  if (!isNaN(prior)) item.prior_interval_days = prior;
  if (!isNaN(price)) item.unit_price          = price;
  try {
    await DB.addItem(item);
    requestPersist({ silent: true });
    await loadAll();
    showView('home');
  } catch (e) {
    alert('登録に失敗しました: ' + e.message);
  }
}

// ── 設定保存 ─────────────────────────────────────────────────────────────────

async function submitSettings(e) {
  e.preventDefault();
  const lead   = parseInt(document.getElementById('s-lead').value, 10);
  const margin = parseInt(document.getElementById('s-margin').value, 10);
  if (isNaN(lead) || isNaN(margin) || lead < 0 || margin < 0) {
    alert('0以上の整数を入力してください');
    return;
  }
  const updated = {
    ...state.settings,
    lead_time_days:     lead,
    safety_margin_days: margin,
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
  document.getElementById('e-emoji-wrap').innerHTML = emojiPickerHtml('e', item.emoji || '');
  document.getElementById('e-name').value  = item.name;
  document.getElementById('e-stock').value = item.initial_stock ?? 0;
  document.getElementById('e-unit').value  = item.stock_unit ?? '個';
  document.getElementById('e-qty').value   = item.package_qty ?? '';
  document.getElementById('e-punit').value = item.package_unit ?? '';
  document.getElementById('e-prior').value = item.prior_interval_days ?? '';
  document.getElementById('e-price').value = item.unit_price ?? '';
  document.getElementById('edit-dialog').showModal();
}

async function submitEdit(e) {
  e.preventDefault();
  const item = await DB.getItem(editingItemId);
  if (!item) return;
  const name  = document.getElementById('e-name').value.trim();
  const stock = parseFloat(document.getElementById('e-stock').value);
  const unit  = document.getElementById('e-unit').value.trim();
  if (name) item.name = name;
  item.initial_stock = isNaN(stock) ? 0 : stock;
  item.stock_unit    = unit || '個';

  // 任意項目は空欄にしたら削除する
  const optional = {
    emoji:               document.getElementById('e-emoji').value || null,
    package_unit:        document.getElementById('e-punit').value.trim() || null,
    package_qty:         parseFloat(document.getElementById('e-qty').value),
    prior_interval_days: parseFloat(document.getElementById('e-prior').value),
    unit_price:          parseFloat(document.getElementById('e-price').value),
  };
  for (const [key, v] of Object.entries(optional)) {
    if (v === null || (typeof v === 'number' && isNaN(v))) delete item[key];
    else item[key] = v;
  }
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

// ── 履歴ダイアログ ────────────────────────────────────────────────────────────

let historyItemId = null;

const SOURCE_LABELS = { list: 'リストから', import: 'インポート' };

async function openHistory(id) {
  historyItemId = id;
  document.getElementById('h-at').value = localDateTimeInput();
  document.getElementById('h-type').value = 'purchase';
  updateHistoryForm();
  await renderHistory();
  const dlg = document.getElementById('history-dialog');
  if (!dlg.open) dlg.showModal();
}

function updateHistoryForm() {
  const type = document.getElementById('h-type').value;
  const qtyLabel = document.getElementById('h-qty-label');
  const qty = document.getElementById('h-qty');
  qtyLabel.hidden = type === 'opening';
  qtyLabel.querySelector('span').textContent = type === 'adjust' ? 'いまの在庫数（未開封）' : '個数';
  if (type === 'adjust') {
    const item = state.items.find(i => i.id === historyItemId);
    qty.value = item ? item.currentStock : 0;
    qty.min = 0;
  } else {
    qty.value = 1;
    qty.min = 0.5;
  }
}

async function renderHistory() {
  const item = state.items.find(i => i.id === historyItemId);
  if (!item) return;
  const [purchases, openings, adjustments] = await Promise.all([
    DB.getPurchasesByItem(item.id),
    DB.getOpeningsByItem(item.id),
    DB.getAdjustmentsByItem(item.id),
  ]);
  const unit = esc(item.stock_unit || '個');
  const events = [
    ...purchases.map(p => ({
      kind: 'purchase', id: p.id, at: p.purchased_at, icon: '🛒',
      text: `買った ×${fmtNum(p.quantity ?? 1)}`, source: p.source,
    })),
    ...openings.map(o => ({
      kind: 'opening', id: o.id, at: o.opened_at, icon: '📂',
      text: '使用開始', source: o.source,
    })),
    ...adjustments.map(a => ({
      kind: 'adjust', id: a.id, at: a.adjusted_at, icon: '🔢',
      text: `在庫を数え直し → ${fmtNum(a.value)}${unit}`, source: null,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  document.getElementById('history-title').textContent = `${itemEmoji(item)} ${item.name}`;
  document.getElementById('history-stock').innerHTML =
    `在庫: <strong>${stockLabel(item)}</strong>` +
    (item.intervalDays ? `<span class="hint">　1つ約${fmtNum(Math.round(item.intervalDays))}日で使用</span>` : '');
  document.getElementById('history-list').innerHTML = events.length
    ? events.map(ev => `
      <li class="history-row">
        <span class="history-icon">${ev.icon}</span>
        <span class="history-text">${ev.text}
          ${SOURCE_LABELS[ev.source] ? `<small>${SOURCE_LABELS[ev.source]}</small>` : ''}
        </span>
        <span class="history-date">${fmtDateTime(ev.at)}</span>
        <button class="btn-del" title="削除" onclick="deleteHistoryEvent('${ev.kind}',${ev.id})">✕</button>
      </li>`).join('')
    : '<li class="hint">まだ記録がありません。</li>';
}

async function submitHistory(e) {
  e.preventDefault();
  const type = document.getElementById('h-type').value;
  const atValue = document.getElementById('h-at').value;
  const at = atValue ? new Date(atValue) : new Date();
  if (isNaN(at)) { alert('日時が正しくありません'); return; }
  if (at > new Date()) { alert('未来の日時は記録できません'); return; }
  const iso = at.toISOString();
  const qty = parseFloat(document.getElementById('h-qty').value);
  try {
    if (type === 'purchase') {
      if (isNaN(qty) || qty <= 0) { alert('個数を入力してください'); return; }
      await DB.addPurchase({ item_id: historyItemId, purchased_at: iso, quantity: qty, source: 'manual' });
    } else if (type === 'opening') {
      await DB.addOpening({ item_id: historyItemId, opened_at: iso, source: 'manual' });
    } else {
      if (isNaN(qty) || qty < 0) { alert('在庫数を入力してください'); return; }
      await DB.addAdjustment({ item_id: historyItemId, adjusted_at: iso, value: qty });
    }
    await loadAll();
    document.getElementById('h-at').value = localDateTimeInput();
    updateHistoryForm();
    await renderHistory();
  } catch (err) {
    alert('記録に失敗しました: ' + err.message);
  }
}

async function deleteHistoryEvent(kind, id) {
  if (!confirm('この記録を削除しますか？')) return;
  if (kind === 'purchase')     await DB.deletePurchase(id);
  else if (kind === 'opening') await DB.deleteOpening(id);
  else                         await DB.deleteAdjustment(id);
  await loadAll();
  await renderHistory();
}

// ── データ管理 ────────────────────────────────────────────────────────────────

async function exportData() {
  const data = await DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `consumable-export-${localDate()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  await DB.putSettings({ ...state.settings, last_export_date: new Date().toISOString() });
  await loadAll();
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('品目データが見つかりません');
    if (!confirm(`品目${data.items.length}件を読み込みます。今のデータは置き換わります。よろしいですか？`)) return;
    await DB.importAll(data);
    await loadAll();
    alert('インポートしました');
  } catch (err) {
    alert('インポート失敗: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

async function confirmDeleteAll() {
  if (!confirm('全データを削除します。この操作は取り消せません。')) return;
  await DB.importAll({ items: [], purchases: [], openings: [], adjustments: [] });
  await loadAll();
}

async function requestPersist({ silent = false } = {}) {
  if (!navigator.storage?.persist) return;
  try {
    state.storagePersisted = await navigator.storage.persist();
    if (!silent) {
      render();
      if (!state.storagePersisted) {
        alert('ブラウザに保護を許可されませんでした。ホーム画面に追加して使うと許可されやすくなります。');
      }
    }
  } catch { /* 非対応環境では何もしない */ }
}

// ── 通知 ─────────────────────────────────────────────────────────────────────

// Android Chrome では new Notification() が使えないので Service Worker 経由で出す
async function showNotification(title, body) {
  const opts = {
    body, icon: './icon-192.png', badge: './favicon-32.png',
    tag: 'soon', data: { url: './?view=soon' },
  };
  if ('serviceWorker' in navigator) {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(res => setTimeout(() => res(null), 3000)),
    ]);
    if (reg) { await reg.showNotification(title, opts); return; }
  }
  new Notification(title, opts);
}

async function enableNotifications() {
  const result = await Notification.requestPermission();
  render();
  if (result === 'granted') await checkAndNotify();
}

async function testNotification() {
  try {
    await showNotification('消耗品ストック予測', '通知のテストです 🫙');
  } catch (e) {
    alert('通知を出せませんでした: ' + e.message);
  }
}

async function checkAndNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const today = localDate();
  const settings = await DB.getSettings();
  if (settings.last_notified_date === today) return;

  const soonNames = state.soonItems.map(i => `${itemEmoji(i)}${i.name}`);
  if (!soonNames.length) return;

  const body = soonNames.length === 1
    ? `「${soonNames[0]}」の補充時期です`
    : `${soonNames.length}点の補充時期です（${soonNames.slice(0, 2).join('、')}ほか）`;

  try {
    await showNotification('消耗品ストック予測', body);
    await DB.putSettings({ ...settings, last_notified_date: today });
  } catch (e) {
    console.warn('通知に失敗しました', e);
  }
}

function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = state.soonItems.length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ── アップデート ─────────────────────────────────────────────────────────────

let swRegistration = null;
let waitingWorker = null;

function askWorker(worker, message) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    worker.postMessage(message, [ch.port2]);
    setTimeout(() => resolve(null), 3000);
  });
}

async function onUpdateReady(worker) {
  waitingWorker = worker;
  const info = await askWorker(worker, 'GET_VERSION');
  state.update = { version: info?.version ?? '新版', changes: info?.changes ?? [] };
  render();
}

async function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // updateViaCache: 'none' — sw.js と version.js を HTTP キャッシュを通さず確認する
    swRegistration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  } catch (e) {
    console.warn('Service Worker の登録に失敗しました', e);
    return;
  }
  const reg = swRegistration;
  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // 既存の SW があるときだけ「更新」。初回インストールはそのまま有効になる
      if (worker.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady(worker);
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg.waiting);
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // アプリに戻ってきたとき・1時間ごとに新しいバージョンを確認
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
  setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
}

function applyUpdate() {
  if (!waitingWorker) { location.reload(); return; }
  waitingWorker.postMessage('SKIP_WAITING');   // controllerchange で再読み込みされる
}

async function checkForUpdate(btn) {
  if (!swRegistration) { alert('このブラウザでは更新を確認できません'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '確認中…'; }
  try {
    await swRegistration.update();
    // 新しい版が見つかると installing → waiting になり、onUpdateReady でお知らせが出る
    const found = swRegistration.installing || swRegistration.waiting;
    if (!found) alert(`最新版です（v${self.APP_VERSION}）`);
  } catch (e) {
    alert('更新を確認できませんでした（オフラインかもしれません）');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '更新を確認'; }
  }
}

// 更新後の初回起動なら変更点を表示する
async function checkJustUpdated() {
  const settings = await DB.getSettings();
  const seen = settings.last_seen_version;
  if (seen !== self.APP_VERSION) {
    if (seen) state.justUpdated = self.APP_VERSION;   // 初めて使うときは出さない
    await DB.putSettings({ ...settings, last_seen_version: self.APP_VERSION });
  }
}

// ── インストール ─────────────────────────────────────────────────────────────

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  if (state.view === 'settings') render();
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  if (state.view === 'settings') render();
});

async function installApp() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  state.installPrompt = null;
  await prompt.prompt();
  render();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

setupUpdates();

window.addEventListener('DOMContentLoaded', async () => {
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
  document.getElementById('btn-edit-history').addEventListener('click', () => {
    document.getElementById('edit-dialog').close();
    openHistory(editingItemId);
  });
  document.getElementById('history-form').addEventListener('submit', submitHistory);
  document.getElementById('h-type').addEventListener('change', updateHistoryForm);
  document.getElementById('btn-close-history').addEventListener('click', () =>
    document.getElementById('history-dialog').close()
  );

  // 絵文字ピッカー（追加画面・編集ダイアログ共通）
  document.addEventListener('click', ev => {
    const opt = ev.target.closest('.emoji-opt');
    if (!opt) return;
    const picker = opt.closest('.emoji-picker');
    picker.querySelector('input[type=hidden]').value = opt.dataset.emoji;
    picker.querySelectorAll('.emoji-opt').forEach(b => b.classList.toggle('selected', b === opt));
  });

  if (navigator.storage?.persisted) {
    state.storagePersisted = await navigator.storage.persisted().catch(() => null);
  }

  await checkJustUpdated();
  await loadAll();
  await checkAndNotify();
});

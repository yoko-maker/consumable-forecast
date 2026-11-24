// expenses.js — 家計簿（支出の記録・集計・ストック品目への反映）
// app.js の state / esc / yen / localDate / loadAll / showView を使う。

const EXPENSE_CATEGORIES = [
  '食費', '日用品', '外食', '飲み物・おやつ', '衣服・美容', '医療・薬',
  '交通', '趣味・娯楽', '住まい・光熱', '通信', '交際', 'その他',
];
const PAYMENT_CHOICES = ['現金', 'クレジット', '電子マネー', 'QR決済', 'デビット'];
const STOCK_CATEGORY = '日用品';   // ストック品目に紐づけた行の既定カテゴリ

// ── 状態 ─────────────────────────────────────────────────────────────────────

Object.assign(state, {
  expMonth: localDate().slice(0, 7),   // 'YYYY-MM'
  expenses: [],                        // 表示中の月の支出（lines 付き）
  thisMonthTotal: 0,
  nameLinks: new Map(),                // 正規化した品名 → { item_id, stock_per_qty }
  expStores: [],                       // 過去に入力した店名
  expPayments: [],
  expNames: [],                        // 過去に入力した品名
  expDraft: null,                      // 入力中の支出
});

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchMonth(ym) {
  const [from, to] = monthRange(ym);
  const exps = await DB.getExpensesBetween(from, to);
  const lines = await DB.getLinesByExpenseIds(exps.map(e => e.id));
  const byExp = new Map();
  for (const l of lines) {
    if (!byExp.has(l.expense_id)) byExp.set(l.expense_id, []);
    byExp.get(l.expense_id).push(l);
  }
  return exps
    .map(e => ({ ...e, lines: (byExp.get(e.id) || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }))
    .sort((a, b) => b.spent_on.localeCompare(a.spent_on) || (b.created_at || '').localeCompare(a.created_at || ''));
}

// loadAll から呼ばれる
async function loadExpenses() {
  state.expenses = await fetchMonth(state.expMonth);
  const thisMonth = localDate().slice(0, 7);
  const current = thisMonth === state.expMonth ? state.expenses : await fetchMonth(thisMonth);
  state.thisMonthTotal = current.reduce((s, e) => s + (e.total || 0), 0);

  const links = await DB.getNameLinks();
  state.nameLinks = new Map(links.map(l => [l.name, l]));

  const all = await DB.getAllExpenses();
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const recent = all.sort((a, b) => (b.spent_on || '').localeCompare(a.spent_on || ''));
  state.expStores = uniq(recent.map(e => e.store)).slice(0, 30);
  state.expPayments = uniq([...recent.map(e => e.payment), ...PAYMENT_CHOICES]);
  state.expNames = uniq([
    ...state.expenses.flatMap(e => e.lines.map(l => l.name)),
    ...state.items.map(i => i.name),
  ]);
}

async function changeMonth(delta) {
  state.expMonth = shiftMonth(state.expMonth, delta);
  state.expenses = await fetchMonth(state.expMonth);
  render();
}

// ── 集計 ─────────────────────────────────────────────────────────────────────

// 支出をカテゴリごとの金額に分ける（個別入力は行ごと、一括は支出のカテゴリ）
function categoryTotals(expenses) {
  const sums = new Map();
  const add = (cat, v) => sums.set(cat || 'その他', (sums.get(cat || 'その他') || 0) + v);
  for (const e of expenses) {
    if (e.mode === 'lines' && e.lines.length) {
      for (const l of e.lines) add(l.category, l.amount || 0);
    } else {
      add(e.category, e.total || 0);
    }
  }
  return [...sums.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
}

// ── 一覧画面 ─────────────────────────────────────────────────────────────────

function renderExpenses() {
  const [y, m] = state.expMonth.split('-').map(Number);
  const total = state.expenses.reduce((s, e) => s + (e.total || 0), 0);
  const cats = categoryTotals(state.expenses);
  const max = Math.max(1, ...cats.map(([, v]) => v));
  const linked = state.expenses.reduce((n, e) => n + e.lines.filter(l => l.purchase_id != null).length, 0);
  const isThisMonth = state.expMonth === localDate().slice(0, 7);

  const head = `
    <div class="exp-month">
      <button class="btn-ghost btn-small" onclick="changeMonth(-1)" aria-label="前の月">◀</button>
      <strong>${y}年${m}月</strong>
      <button class="btn-ghost btn-small" onclick="changeMonth(1)" aria-label="次の月"
        ${isThisMonth ? 'disabled' : ''}>▶</button>
    </div>
    <div class="exp-total-card">
      <div class="exp-total-label">支出合計</div>
      <div class="exp-total">${yen(total)}</div>
      <div class="hint">${state.expenses.length}件${linked ? `・ストックに反映 ${linked}品` : ''}</div>
      ${cats.length ? `<div class="exp-cats">${cats.map(([c, v]) => `
        <div class="exp-cat">
          <span class="exp-cat-name">${esc(c)}</span>
          <span class="exp-bar"><span style="width:${Math.max(2, v / max * 100)}%"></span></span>
          <span class="exp-cat-val">${yen(v)}</span>
        </div>`).join('')}</div>` : ''}
    </div>
    <button class="btn-primary" onclick="newExpense()">＋ 支出を記録</button>`;

  if (!state.expenses.length) {
    return head + `<div class="empty"><p>この月の支出はまだありません。</p></div>`;
  }

  let lastDay = null;
  const rows = state.expenses.map(e => {
    const day = e.spent_on !== lastDay
      ? `<div class="exp-day">${fmtDay(e.spent_on)}</div>` : '';
    lastDay = e.spent_on;
    const names = e.mode === 'lines'
      ? e.lines.map(l => esc(l.name || '（品名なし）'))
      : [esc(e.category || 'その他') + '（一括）'];
    const summary = names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}品` : '');
    const stockCount = e.lines.filter(l => l.purchase_id != null).length;
    return `${day}
      <button class="exp-row" onclick="editExpense(${e.id})">
        <span class="exp-row-main">
          <span class="exp-row-store">${esc(e.store || '（店名なし）')}
            ${e.payment ? `<small>${esc(e.payment)}</small>` : ''}</span>
          <span class="exp-row-items">${summary}</span>
        </span>
        ${stockCount ? `<span class="exp-stock-badge" title="ストックに反映した品数">📦${stockCount}</span>` : ''}
        <span class="exp-row-total">${yen(e.total || 0)}</span>
      </button>`;
  }).join('');
  return head + `<div class="exp-list">${rows}</div>`;
}

function fmtDay(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

// ── 入力フォーム ─────────────────────────────────────────────────────────────

function blankLine(category) {
  return { name: '', amount: null, qty: 1, category: category || '食費', item_id: null, stock_qty: 0 };
}

function newExpense() {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  state.expDraft = {
    spent_on: localDate(), store: '', payment: '', mode: 'lines',
    category: '食費', total: null, memo: '', lines: [blankLine('食費')],
  };
  showView('expense-form');
}

async function editExpense(id) {
  const exp = await DB.getExpense(id);
  if (!exp) return;
  if (!exp.lines.length) exp.lines = [blankLine(exp.category)];
  state.expDraft = exp;
  showView('expense-form');
}

const catOptions = sel => EXPENSE_CATEGORIES
  .map(c => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');

function itemOptions(sel) {
  return `<option value="">ストック連携なし</option>` + state.items
    .map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${itemEmoji(i)} ${esc(i.name)}</option>`)
    .join('');
}

function lineHtml(l) {
  const item = state.items.find(i => i.id === l.item_id);
  const unit = esc(item?.stock_unit || '個');
  return `
    <div class="exp-line ${l.item_id != null ? 'linked' : ''}">
      <div class="exp-line-top">
        <input type="text" class="l-name" list="dl-exp-names" placeholder="品名" value="${esc(l.name || '')}"
          oninput="onLineName(this)" autocomplete="off">
        <input type="number" class="l-amount" inputmode="numeric" step="1" placeholder="金額"
          value="${l.amount ?? ''}" oninput="updateExpenseTotal()">
        <button type="button" class="btn-del" title="行を削除" onclick="removeLine(this)">✕</button>
      </div>
      <div class="exp-line-sub">
        <label class="l-qty-wrap">×<input type="number" class="l-qty" min="1" step="1" value="${l.qty ?? 1}"
          oninput="onLineQty(this)"></label>
        <select class="l-cat">${catOptions(l.category)}</select>
        <select class="l-item" onchange="onLineItem(this)">${itemOptions(l.item_id)}</select>
        <label class="l-stock-wrap" ${l.item_id == null ? 'hidden' : ''}>在庫＋
          <input type="number" class="l-stock" min="0" step="0.5" value="${l.stock_qty ?? 0}"
            oninput="this.dataset.touched='1'"><span class="l-unit">${unit}</span></label>
      </div>
    </div>`;
}

function renderExpenseForm() {
  const d = state.expDraft;
  if (!d) { state.view = 'expenses'; return renderExpenses(); }
  const isLines = d.mode === 'lines';
  return `
    <form id="exp-form" onsubmit="submitExpense(event)">
      <datalist id="dl-exp-stores">${state.expStores.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <datalist id="dl-exp-pay">${state.expPayments.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <datalist id="dl-exp-names">${state.expNames.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
      <div class="row">
        <label>日付
          <input type="date" id="x-date" required value="${esc(d.spent_on)}" max="${localDate()}">
        </label>
        <label>支払方法
          <input type="text" id="x-pay" list="dl-exp-pay" value="${esc(d.payment || '')}" placeholder="例: 現金">
        </label>
      </div>
      <label>お店
        <input type="text" id="x-store" list="dl-exp-stores" value="${esc(d.store || '')}" placeholder="例: ○○スーパー">
      </label>

      <div class="seg" role="tablist">
        <button type="button" class="seg-btn ${isLines ? 'active' : ''}" onclick="setExpenseMode('lines')">購入品ごと</button>
        <button type="button" class="seg-btn ${!isLines ? 'active' : ''}" onclick="setExpenseMode('bulk')">合計だけ</button>
      </div>

      <div id="x-bulk" ${isLines ? 'hidden' : ''} class="detail-body" style="margin-top:0">
        <div class="row">
          <label>金額（円） <span class="req">*</span>
            <input type="number" id="x-total" inputmode="numeric" step="1" value="${!isLines && d.total != null ? d.total : ''}">
          </label>
          <label>カテゴリ
            <select id="x-cat" class="select">${catOptions(d.category)}</select>
          </label>
        </div>
      </div>

      <div id="x-lines" ${!isLines ? 'hidden' : ''}>
        <p class="hint">ストック品目を選ぶと、保存したときにその品目の「買った」も記録されます。</p>
        <div id="x-line-list">${d.lines.map(lineHtml).join('')}</div>
        <div class="form-actions" style="margin-top:8px">
          <button type="button" class="btn-ghost" onclick="addLine()">＋ 行を追加</button>
          <button type="button" class="btn-ghost" onclick="togglePaste()">📋 レシートの文字を貼り付け</button>
        </div>
        <div id="x-paste" hidden class="exp-paste">
          <p class="hint">スマホの文字認識（iPhone の「テキスト認識表示」、Android の Google レンズなど）で
            レシートの文字をコピーして貼り付けると、「品名 金額」の行を読み取ります。</p>
          <textarea id="x-paste-text" rows="6" placeholder="牛乳 198&#10;食パン ¥158&#10;トイレットペーパー 12R 398"></textarea>
          <button type="button" class="btn-primary btn-small" onclick="parsePasted()">読み取って行に追加</button>
        </div>
        <div class="exp-sum">
          <span>合計 <strong id="x-sum">¥0</strong></span>
          <label class="exp-receipt">レシートの合計
            <input type="number" id="x-receipt" inputmode="numeric" step="1" placeholder="任意"
              oninput="updateExpenseTotal()" value="${isLines && d.receipt_total != null ? d.receipt_total : ''}">
          </label>
        </div>
        <div id="x-diff" class="hint" hidden></div>
      </div>

      <label>メモ
        <input type="text" id="x-memo" value="${esc(d.memo || '')}" placeholder="任意">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn-primary" id="x-save">保存</button>
        <button type="button" class="btn-ghost" onclick="cancelExpense()">キャンセル</button>
        ${d.id != null ? `<button type="button" class="btn-danger" style="margin-left:auto" onclick="removeExpense()">削除</button>` : ''}
      </div>
    </form>`;
}

// render() 後に呼ぶ（合計の表示など）
function afterRenderExpenseForm() {
  if (state.view === 'expense-form') updateExpenseTotal();
}

function setExpenseMode(mode) {
  state.expDraft = readExpenseForm();
  state.expDraft.mode = mode;
  // 一括 → 個別に切り替えたら、行のカテゴリを一括のカテゴリにそろえる
  if (mode === 'lines' && state.expDraft.lines.every(l => !l.name && l.amount == null)) {
    state.expDraft.lines = [blankLine(state.expDraft.category)];
  }
  render();
}

// 新しい行のカテゴリ: ストック連携していない直近の行に合わせる（連携行は「日用品」に固定されるため）
function lastFreeCategory() {
  const rows = [...document.querySelectorAll('#x-line-list .exp-line')].reverse();
  const row = rows.find(r => !r.querySelector('.l-item').value);
  return row ? row.querySelector('.l-cat').value : '食費';
}

function addLine(line) {
  const list = document.getElementById('x-line-list');
  list.insertAdjacentHTML('beforeend', lineHtml(line || blankLine(lastFreeCategory())));
  if (!line) list.lastElementChild.querySelector('.l-name').focus();
  updateExpenseTotal();
}

function removeLine(btn) {
  const list = document.getElementById('x-line-list');
  btn.closest('.exp-line').remove();
  if (!list.children.length) addLine();
  updateExpenseTotal();
}

function stockPerQty(itemId, name) {
  const link = state.nameLinks.get(DB.normalizeName(name));
  return link && link.item_id === itemId && link.stock_per_qty > 0 ? link.stock_per_qty : 1;
}

function setLineItem(row, itemId) {
  const sel = row.querySelector('.l-item');
  sel.value = itemId == null ? '' : String(itemId);
  const wrap = row.querySelector('.l-stock-wrap');
  const stock = row.querySelector('.l-stock');
  row.classList.toggle('linked', itemId != null);
  wrap.hidden = itemId == null;
  if (itemId != null) {
    const item = state.items.find(i => i.id === itemId);
    row.querySelector('.l-unit').textContent = item?.stock_unit || '個';
    const qty = parseFloat(row.querySelector('.l-qty').value) || 1;
    stock.value = fmtNum(qty * stockPerQty(itemId, row.querySelector('.l-name').value));
    delete stock.dataset.touched;
    row.querySelector('.l-cat').value = STOCK_CATEGORY;
  }
}

// 品名から、覚えた対応 → 品目名の一致 の順でストック品目を探す
function findItemForName(name) {
  const key = DB.normalizeName(name);
  if (!key) return null;
  const link = state.nameLinks.get(key);
  if (link && state.items.some(i => i.id === link.item_id)) return link.item_id;
  const hit = state.items.find(i => DB.normalizeName(i.name) === key);
  return hit ? hit.id : null;
}

function onLineName(input) {
  const row = input.closest('.exp-line');
  const sel = row.querySelector('.l-item');
  if (sel.dataset.manual) return;   // 手で選んだ紐づけは変えない
  const id = findItemForName(input.value);
  const cur = sel.value ? Number(sel.value) : null;
  if (id !== cur) setLineItem(row, id);
}

function onLineItem(sel) {
  sel.dataset.manual = '1';
  setLineItem(sel.closest('.exp-line'), sel.value ? Number(sel.value) : null);
}

function onLineQty(input) {
  const row = input.closest('.exp-line');
  const sel = row.querySelector('.l-item');
  const stock = row.querySelector('.l-stock');
  if (sel.value && !stock.dataset.touched) {
    const qty = parseFloat(input.value) || 1;
    stock.value = fmtNum(qty * stockPerQty(Number(sel.value), row.querySelector('.l-name').value));
  }
}

function readLines() {
  return [...document.querySelectorAll('#x-line-list .exp-line')].map(row => {
    const amount = parseFloat(row.querySelector('.l-amount').value);
    const qty = parseFloat(row.querySelector('.l-qty').value);
    const itemVal = row.querySelector('.l-item').value;
    const stock = parseFloat(row.querySelector('.l-stock').value);
    return {
      name: row.querySelector('.l-name').value.trim(),
      amount: isNaN(amount) ? null : amount,
      qty: isNaN(qty) || qty <= 0 ? 1 : qty,
      category: row.querySelector('.l-cat').value,
      item_id: itemVal ? Number(itemVal) : null,
      stock_qty: itemVal && !isNaN(stock) && stock > 0 ? stock : 0,
    };
  });
}

function readExpenseForm() {
  const d = state.expDraft || {};
  const total = parseFloat(document.getElementById('x-total')?.value);
  const receipt = parseFloat(document.getElementById('x-receipt')?.value);
  return {
    ...d,
    spent_on: document.getElementById('x-date').value,
    payment: document.getElementById('x-pay').value.trim(),
    store: document.getElementById('x-store').value.trim(),
    category: document.getElementById('x-cat').value,
    total: isNaN(total) ? null : total,
    receipt_total: isNaN(receipt) ? null : receipt,
    memo: document.getElementById('x-memo').value.trim(),
    lines: readLines(),
  };
}

function updateExpenseTotal() {
  const sumEl = document.getElementById('x-sum');
  if (!sumEl) return;
  const sum = readLines().reduce((s, l) => s + (l.amount || 0), 0);
  sumEl.textContent = yen(sum);
  const receipt = parseFloat(document.getElementById('x-receipt').value);
  const diffEl = document.getElementById('x-diff');
  const diff = isNaN(receipt) ? 0 : Math.round(receipt - sum);
  diffEl.hidden = !diff;
  if (diff) {
    diffEl.innerHTML = `レシートの合計と ${yen(Math.abs(diff))} ${diff > 0 ? '足りません' : '多いです'}。
      <button type="button" class="btn-ghost btn-small" onclick="addDiffLine(${diff})">
        差額を1行で追加（${diff > 0 ? '税など' : '値引きなど'}）</button>`;
  }
}

function addDiffLine(diff) {
  const lines = readLines();
  const cat = lines.length ? lines[lines.length - 1].category : 'その他';
  // 空の行があれば使う
  const empty = [...document.querySelectorAll('#x-line-list .exp-line')]
    .find(r => !r.querySelector('.l-name').value && !r.querySelector('.l-amount').value);
  if (empty) empty.remove();
  addLine({ ...blankLine(cat), name: diff > 0 ? '消費税など' : '値引き', amount: diff });
}

// ── レシート文字の貼り付け ───────────────────────────────────────────────────

const RECEIPT_SKIP = /合計|小計|総計|お釣|釣銭|おつり|預り|預かり|お預|対象|税率|内税|外税|消費税|現金|クレジット|カード|ポイント|残高|領収|TEL|電話|登録番号|レジ|担当|点数|買上|お買上|ありがとう|No\.|伝票|〒/i;

// 「品名 金額」の行を取り出す。値引き行（-50 / ▲50）はマイナスにする
function parseReceiptText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.normalize('NFKC').trim();
    if (!line || RECEIPT_SKIP.test(line)) continue;
    const m = line.match(/^(.*?)[\s　]*([-−▲△]?)[\s　]*[¥￥\\]?[\s　]*(\d{1,3}(?:,\d{3})+|\d+)[\s　]*円?[\s　]*(?:[※*＊軽外内非](?:税)?)?$/);
    if (!m) continue;
    let name = m[1].replace(/[\s　]+$/, '').replace(/[¥￥\\]$/, '').trim();
    const amount = parseInt(m[3].replace(/,/g, ''), 10) * (m[2] ? -1 : 1);
    if (!name || !isFinite(amount) || /^[\d\s:/.-]+$/.test(name)) continue;   // 日付・時刻だけの行
    let qty = 1;
    const q = name.match(/^(.*?)[\s　]*[x×X*＊][\s　]*(\d+)(?:個|点)?$/) || name.match(/^(.*?)[\s　]+(\d+)(?:個|点)$/);
    if (q && q[1]) { name = q[1].trim(); qty = parseInt(q[2], 10) || 1; }
    if (/値引|割引|クーポン/.test(name) && amount > 0) out.push({ name, amount: -amount, qty: 1 });
    else out.push({ name, amount, qty });
  }
  return out;
}

function togglePaste() {
  const box = document.getElementById('x-paste');
  box.hidden = !box.hidden;
  if (!box.hidden) document.getElementById('x-paste-text').focus();
}

function parsePasted() {
  const ta = document.getElementById('x-paste-text');
  const found = parseReceiptText(ta.value);
  if (!found.length) { alert('「品名 金額」の行が見つかりませんでした'); return; }
  // 空の行は取り除いてから足す
  document.querySelectorAll('#x-line-list .exp-line').forEach(r => {
    if (!r.querySelector('.l-name').value && !r.querySelector('.l-amount').value) r.remove();
  });
  const cat = lastFreeCategory();
  for (const f of found) {
    const itemId = findItemForName(f.name);
    const line = { ...blankLine(itemId != null ? STOCK_CATEGORY : cat), ...f, item_id: itemId };
    if (itemId != null) line.stock_qty = f.qty * stockPerQty(itemId, f.name);
    addLine(line);
  }
  ta.value = '';
  document.getElementById('x-paste').hidden = true;
}

// ── 保存・削除 ───────────────────────────────────────────────────────────────

async function submitExpense(e) {
  e.preventDefault();
  const d = readExpenseForm();
  if (!d.spent_on) { alert('日付を入力してください'); return; }
  if (d.spent_on > localDate()) { alert('未来の日付は記録できません'); return; }

  let lines = [];
  let total;
  if (d.mode === 'bulk') {
    if (d.total == null || d.total <= 0) { alert('金額を入力してください'); return; }
    total = d.total;
  } else {
    lines = d.lines.filter(l => l.name || l.amount != null);
    if (!lines.length) { alert('購入品を1つ以上入力してください'); return; }
    if (lines.some(l => l.amount == null)) { alert('金額が空の行があります'); return; }
    total = lines.reduce((s, l) => s + l.amount, 0);
  }

  const btn = document.getElementById('x-save');
  btn.disabled = true;
  try {
    const { lines: _l, ...head } = d;
    await DB.saveExpense({
      ...head,
      total,
      category: d.mode === 'bulk' ? d.category : null,
      receipt_total: d.mode === 'lines' ? d.receipt_total : null,
    }, lines);
    requestPersist({ silent: true });
    const stocked = lines.filter(l => l.item_id != null && l.stock_qty > 0);
    state.expDraft = null;
    state.expMonth = d.spent_on.slice(0, 7);
    state.view = 'expenses';
    await loadAll();
    if (stocked.length) toast(`📦 ストックに反映: ${stocked.map(l => {
      const item = state.items.find(i => i.id === l.item_id);
      return `${item?.name ?? l.name} +${fmtNum(l.stock_qty)}`;
    }).join('、')}`);
  } catch (err) {
    alert('保存に失敗しました: ' + err.message);
    btn.disabled = false;
  }
}

async function removeExpense() {
  const d = state.expDraft;
  if (!d?.id) return;
  const linked = (d.lines || []).filter(l => l.purchase_id != null).length;
  const msg = linked
    ? `この支出を削除します。ストックに反映した「買った」${linked}件も取り消されます。`
    : 'この支出を削除しますか？';
  if (!confirm(msg)) return;
  await DB.deleteExpense(d.id);
  state.expDraft = null;
  state.view = 'expenses';
  await loadAll();
}

function cancelExpense() {
  state.expDraft = null;
  showView('expenses');
}

function toast(text) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

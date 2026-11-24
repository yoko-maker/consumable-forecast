// expenses.js — 家計簿（支出の記録・集計）
// 支出は「日付・金額・カテゴリ（・メモ）」だけを記録する。
// v0.6 までの「購入品ごと」の支出（mode: 'lines'）は表示・集計・削除でき、編集すると1件にまとめる。
// app.js の state / esc / yen / localDate / loadAll / showView を使う。

const EXPENSE_CATEGORIES = [
  '食費', '日用品', '外食', '飲み物・おやつ', '衣服・美容', '医療・薬',
  '交通', '趣味・娯楽', '住まい・光熱', '通信', '交際', 'その他',
];

// ── 状態 ─────────────────────────────────────────────────────────────────────

Object.assign(state, {
  expMonth: localDate().slice(0, 7),   // 'YYYY-MM'
  expenses: [],                        // 表示中の月の支出（以前の明細は lines 付き）
  thisMonthTotal: 0,
  todayTotal: 0,
  catUsage: [],                        // よく使うカテゴリ順（選択肢の並び）
  quick: { category: null },           // かんたん記録で選んだカテゴリ
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
  const today = localDate();
  state.todayTotal = current.filter(e => e.spent_on === today).reduce((s, e) => s + (e.total || 0), 0);

  const all = await DB.getAllExpenses();
  // 直近90日に使ったカテゴリの回数順
  const since = localDate(new Date(Date.now() - 90 * 86400000));
  const recentExp = all.filter(e => e.spent_on >= since);
  const recentLines = await DB.getLinesByExpenseIds(recentExp.filter(e => e.mode === 'lines').map(e => e.id));
  const count = new Map();
  for (const c of [...recentExp.filter(e => e.mode !== 'lines').map(e => e.category), ...recentLines.map(l => l.category)]) {
    if (c) count.set(c, (count.get(c) || 0) + 1);
  }
  state.catUsage = [...EXPENSE_CATEGORIES].sort((a, b) =>
    (count.get(b) || 0) - (count.get(a) || 0) || EXPENSE_CATEGORIES.indexOf(a) - EXPENSE_CATEGORIES.indexOf(b));
}

async function changeMonth(delta) {
  state.expMonth = shiftMonth(state.expMonth, delta);
  state.expenses = await fetchMonth(state.expMonth);
  render();
}

// ── 集計 ─────────────────────────────────────────────────────────────────────

// 支出をカテゴリごとの金額に分ける（以前の明細は行ごと、それ以外は支出のカテゴリ）
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

// ── ホーム: 支出とストックの入口 ─────────────────────────────────────────────

function renderHomeDashboard() {
  const over = state.items.filter(i => i.status === 'overdue').length;
  const soon = state.items.filter(i => i.status === 'soon').length;

  let stockValue = '余裕あり';
  let stockTone = 'ok';
  if (!state.items.length) {
    stockValue = '未登録';
    stockTone = 'muted';
  } else if (over) {
    stockValue = `超過 ${over}件`;
    stockTone = 'overdue';
  } else if (soon) {
    stockValue = `そろそろ ${soon}件`;
    stockTone = 'soon';
  }
  const stockSub = [over && soon ? `そろそろ ${soon}件` : '', state.items.length ? `全${state.items.length}品目` : '']
    .filter(Boolean).join('・');

  return `
    <div class="tiles">
      <button type="button" class="tile tile-stock" onclick="showView('stock')">
        <span class="tile-label">ストック</span><span class="tile-arrow" aria-hidden="true">↗</span>
        <span class="tile-value tile-${stockTone}">${stockValue}</span>
        <span class="tile-sub">${stockSub || '品目を登録する'}</span>
      </button>
      <button type="button" class="tile" onclick="showView('expenses')">
        <span class="tile-label">今月の支出</span><span class="tile-arrow" aria-hidden="true">↗</span>
        <span class="tile-value">${yen(state.thisMonthTotal)}</span>
        <span class="tile-sub">今日 ${yen(state.todayTotal)}</span>
      </button>
    </div>`;
}

// タイル用の短い残り日数
function shortDays(date) {
  if (!date) return '−';
  const d = dayDiff(date);
  return d < 0 ? `${-d}日超過` : d === 0 ? '今日' : `あと${d}日`;
}

// カテゴリの選択肢（よく使う順のチップ）。onclick は pickCat(this)
function catChips(selected) {
  const cats = state.catUsage.length ? state.catUsage : EXPENSE_CATEGORIES;
  const sel = cats.includes(selected) ? selected : cats[0];
  return `<div class="quick-cats" role="radiogroup" aria-label="カテゴリ">
    ${cats.map(c => `<button type="button" class="qcat ${c === sel ? 'selected' : ''}" role="radio"
      aria-checked="${c === sel}" onclick="pickCat(this)" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
  </div>`;
}

function pickCat(btn) {
  btn.parentElement.querySelectorAll('.qcat').forEach(b => {
    b.classList.toggle('selected', b === btn);
    b.setAttribute('aria-checked', String(b === btn));
  });
}

const selectedCat = root => root.querySelector('.qcat.selected')?.dataset.cat || 'その他';

// ホームの「かんたん支出記録」: 今日の日付で、金額とカテゴリだけ
function renderQuickEntry() {
  return `
    <form class="quick" id="quick-form" onsubmit="submitQuick(event)" autocomplete="off">
      <h2 class="quick-title">かんたん支出記録</h2>
      <input type="number" id="q-amount" aria-label="金額（円）" inputmode="numeric" step="1" min="1" placeholder="金額（円）" required>
      ${catChips(state.quick.category)}
      <button type="submit" class="btn-primary" id="q-save">記録</button>
    </form>`;
}

async function submitQuick(e) {
  e.preventDefault();
  const form = document.getElementById('quick-form');
  const amount = parseFloat(document.getElementById('q-amount').value);
  if (isNaN(amount) || amount <= 0) { alert('金額を入力してください'); return; }
  const category = selectedCat(form);
  state.quick.category = category;
  const btn = document.getElementById('q-save');
  btn.disabled = true;
  try {
    const id = await DB.saveExpense({ spent_on: localDate(), mode: 'bulk', category, total: amount, memo: '' }, []);
    requestPersist({ silent: true });
    await loadAll();
    toast(`✓ ${yen(amount)}を記録（${category}）`, async () => { await DB.deleteExpense(id); await loadAll(); });
  } catch (err) {
    alert('記録に失敗しました: ' + err.message);
    btn.disabled = false;
  }
}

// ── 一覧画面 ─────────────────────────────────────────────────────────────────

function renderExpenses() {
  const [y, m] = state.expMonth.split('-').map(Number);
  const total = state.expenses.reduce((s, e) => s + (e.total || 0), 0);
  const cats = categoryTotals(state.expenses);
  const max = Math.max(1, ...cats.map(([, v]) => v));
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
      <div class="hint">${state.expenses.length}件</div>
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
    // 以前の明細つき支出は、店名（なければ「明細」）と品名を出す
    const isLines = e.mode === 'lines' && e.lines.length;
    const title = isLines ? (e.store || `明細 ${e.lines.length}品`) : (e.category || 'その他');
    const names = isLines ? e.lines.map(l => l.name || '（品名なし）') : [];
    const sub = isLines
      ? names.slice(0, 3).join('、') + (names.length > 3 ? ` ほか${names.length - 3}品` : '')
      : (e.memo || e.store || '');
    return `${day}
      <button class="exp-row" onclick="editExpense(${e.id})">
        <span class="exp-row-main">
          <span class="exp-row-store">${esc(title)}</span>
          ${sub ? `<span class="exp-row-items">${esc(sub)}</span>` : ''}
        </span>
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

function newExpense() {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  state.expDraft = { spent_on: localDate(), mode: 'bulk', category: state.quick.category, total: null, memo: '' };
  showView('expense-form');
}

async function editExpense(id) {
  const exp = await DB.getExpense(id);
  if (!exp) return;
  if (exp.mode === 'lines' && exp.lines.length) {
    // 以前の明細: いちばん金額の大きいカテゴリを初期値にする
    const byCat = new Map();
    for (const l of exp.lines) byCat.set(l.category, (byCat.get(l.category) || 0) + (l.amount || 0));
    exp.category = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'その他';
  }
  state.expDraft = exp;
  showView('expense-form');
}

function renderExpenseForm() {
  const d = state.expDraft;
  if (!d) { state.view = 'expenses'; return renderExpenses(); }
  const legacy = d.mode === 'lines' && d.lines?.length;
  const stocked = legacy ? d.lines.filter(l => l.purchase_id != null).length : 0;
  return `
    <form id="exp-form" onsubmit="submitExpense(event)" autocomplete="off">
      <label>日付
        <input type="date" id="x-date" required value="${esc(d.spent_on)}" max="${localDate()}">
      </label>
      <label>金額（円）
        <input type="number" id="x-total" inputmode="numeric" step="1" min="1" required
          value="${d.total != null ? d.total : ''}" placeholder="例: 1200">
      </label>
      <div class="field">
        <span class="field-label">カテゴリ</span>
        ${catChips(d.category)}
      </div>
      <label>メモ（任意）
        <input type="text" id="x-memo" value="${esc(d.memo || '')}" placeholder="例: 〇〇スーパー">
      </label>
      ${legacy ? `<p class="hint legacy-note">以前に明細で記録した支出です（${d.lines.length}品${d.store ? `・${esc(d.store)}` : ''}）。
        保存すると明細はなくなり、1件の支出にまとまります。${stocked ? 'ストックに記録した「買った」はそのまま残ります。' : ''}</p>` : ''}
      <div class="form-actions">
        <button type="submit" class="btn-primary" id="x-save">保存</button>
        <button type="button" class="btn-ghost" onclick="cancelExpense()">キャンセル</button>
        ${d.id != null ? `<button type="button" class="btn-danger" style="margin-left:auto" onclick="removeExpense()">削除</button>` : ''}
      </div>
    </form>`;
}

// render() 後に呼ぶ（app.js から呼ばれる。今は何もしない）
function afterRenderExpenseForm() {}

// ── 保存・削除 ───────────────────────────────────────────────────────────────

async function submitExpense(e) {
  e.preventDefault();
  const d = state.expDraft || {};
  const spent_on = document.getElementById('x-date').value;
  const total = parseFloat(document.getElementById('x-total').value);
  if (!spent_on) { alert('日付を入力してください'); return; }
  if (spent_on > localDate()) { alert('未来の日付は記録できません'); return; }
  if (isNaN(total) || total <= 0) { alert('金額を入力してください'); return; }
  const category = selectedCat(document.getElementById('exp-form'));

  const btn = document.getElementById('x-save');
  btn.disabled = true;
  try {
    const { lines: _l, ...head } = d;
    // 以前の明細を1件にまとめるときも、ストックの「買った」は消さない
    await DB.saveExpense({
      ...head, spent_on, total, category, mode: 'bulk',
      memo: document.getElementById('x-memo').value.trim(),
      receipt_total: null,
    }, [], { keepPurchases: true });
    requestPersist({ silent: true });
    state.quick.category = category;
    state.expDraft = null;
    state.expMonth = spent_on.slice(0, 7);
    state.view = 'expenses';
    await loadAll();
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
    ? `この支出を削除します。この支出からストックに記録した「買った」${linked}件も取り消されます。`
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

// onUndo を渡すと「取り消す」ボタンを付ける（6秒間）
function toast(text, onUndo) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (onUndo) {
    const b = document.createElement('button');
    b.className = 'toast-undo';
    b.textContent = '取り消す';
    b.onclick = async () => { b.disabled = true; el.remove(); await onUndo(); };
    el.appendChild(b);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), onUndo ? 6000 : 4000);
}

// forecast.js — 消費予測エンジン（app/forecast.py の JS 移植版）

const MS_PER_DAY = 86400000;

function _median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _iqr(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return s[Math.floor(3 * n / 4)] - s[Math.floor(n / 4)];
}

/**
 * 在庫数を時系列で積み上げる。
 * 在庫0での使用開始は購入の記録漏れとみなし、0 未満にはしない
 * （在庫切れ後の購入は 0 から数え直される）。
 * 「数え直し」はその時点の在庫数を上書きする。
 * 同時刻なら 数え直し → 購入 → 使用開始 の順。
 *
 * @param {number} initialStock
 * @param {{at: Date, qty: number}[]} purchases
 * @param {Date[]} openings      昇順
 * @param {{at: Date, value: number}[]} adjustments
 * @returns {{stock: number, emptyAfter: boolean[]}}
 *   emptyAfter[i]: i 番目の使用開始で未開封在庫が 0 になった（次の補充まで在庫切れ）
 */
function stockTimeline(initialStock, purchases, openings, adjustments = []) {
  const events = [
    ...adjustments.map(a => ({ t: new Date(a.at).getTime(), order: 0, set: a.value })),
    ...purchases.map(p => ({ t: new Date(p.at).getTime(), order: 1, delta: p.qty })),
    ...openings.map((d, i) => ({ t: new Date(d).getTime(), order: 2, delta: -1, idx: i })),
  ].sort((a, b) => a.t - b.t || a.order - b.order);

  let stock = initialStock || 0;
  const emptyAfter = openings.map(() => false);
  for (const e of events) {
    stock = e.set !== undefined ? Math.max(e.set, 0) : Math.max(stock + e.delta, 0);
    if (e.idx !== undefined) emptyAfter[e.idx] = stock === 0;
  }
  return { stock, emptyAfter };
}

function calcStock(initialStock, purchases, openings, adjustments = []) {
  return stockTimeline(initialStock, purchases, openings, adjustments).stock;
}

/**
 * @param {Date[]} openings       使用開始日時の昇順配列
 * @param {number} currentStock   未開封の在庫数
 * @param {object} opts
 *   emptyAfter: stockTimeline の結果。在庫切れをはさむ間隔は買い待ちの時間を含むので、
 *               ほかに十分なデータがあれば学習から除く
 */
function estimate(openings, currentStock, {
  packageQty = 1.0,
  priorIntervalDays = null,
  leadTime = 3,
  safetyMargin = 2,
  priorK = 2,
  start = null,   // 使用開始記録がないときの起点（品目の登録日時）
  emptyAfter = null,
} = {}) {
  const prior = priorIntervalDays ?? 30.0;
  const pkg = packageQty || 1.0;
  const m = openings.length;
  // 使用開始済みなら「使用中の1個 + 未開封の在庫」、未使用なら在庫数だけ持つ
  const S = m >= 1 ? currentStock + 1 : currentStock;

  let intervalHat, spread, last, learning;

  if (m === 0) {
    if (priorIntervalDays == null) {
      return { currentStock, consumptionRate: null, intervalDays: null, expectedRunout: null,
               depletionLow: null, depletionHigh: null, notifyDate: null, learning: false,
               periodStart: null };
    }
    intervalHat = prior; spread = prior * 0.3;
    last = start ? new Date(start) : new Date(); learning = false;
  } else if (m === 1) {
    intervalHat = prior; spread = prior * 0.3;
    last = new Date(openings[0]); learning = false;
  } else {
    const sorted = [...openings].map(d => new Date(d)).sort((a, b) => a - b);
    const all = [], clean = [];
    for (let i = 1; i < sorted.length; i++) {
      const v = Math.max((sorted[i] - sorted[i - 1]) / MS_PER_DAY, 1.0);
      all.push(v);
      if (!(emptyAfter && emptyAfter[i - 1])) clean.push(v);
    }
    const intervals = clean.length >= 2 ? clean : all;
    const n = intervals.length + 1;   // 有効な間隔数に対応する観測数
    const med = _median(intervals);
    if (n >= 4) {
      intervalHat = med;
      spread = intervals.length >= 4 ? _iqr(intervals) : intervalHat * 0.3;
    } else {
      const w = n / (n + priorK);
      intervalHat = w * med + (1 - w) * prior;
      spread = intervalHat * 0.3;
    }
    last = sorted[sorted.length - 1]; learning = true;
  }

  const half = spread / 2;
  const expectedRunout = new Date(last.getTime() + intervalHat * S * MS_PER_DAY);
  const notifyDate    = new Date(expectedRunout.getTime() - (leadTime + safetyMargin) * MS_PER_DAY);

  return {
    currentStock,
    consumptionRate: pkg / intervalHat,
    intervalDays: intervalHat,
    expectedRunout,
    depletionLow:  new Date(last.getTime() + Math.max(intervalHat - half, 1) * S * MS_PER_DAY),
    depletionHigh: new Date(last.getTime() + (intervalHat + half) * S * MS_PER_DAY),
    notifyDate,
    learning,
    periodStart: last,
  };
}

function computeStatus(notifyDate, expectedRunout) {
  if (!notifyDate || !expectedRunout) return 'ok';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const r = new Date(expectedRunout); r.setHours(0, 0, 0, 0);
  const n = new Date(notifyDate);     n.setHours(0, 0, 0, 0);
  if (today >= r) return 'overdue';
  if (today >= n) return 'soon';
  return 'ok';
}

// forecast.js — 消費予測エンジン（app/forecast.py の JS 移植版）

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

function calcStock(initialStock, purchaseQtySum, openingCount) {
  return (initialStock || 0) + (purchaseQtySum || 0) - (openingCount || 0);
}

/**
 * @param {Date[]} openings       使用開始日時の昇順配列
 * @param {number} currentStock   現在庫数
 * @param {object} opts
 */
function estimate(openings, currentStock, {
  packageQty = 1.0,
  priorIntervalDays = null,
  leadTime = 3,
  safetyMargin = 2,
  priorK = 2,
} = {}) {
  const prior = priorIntervalDays ?? 30.0;
  const pkg = packageQty || 1.0;
  const m = openings.length;
  const S = Math.max(currentStock, 1.0);
  const MS = 86400000; // ms/day

  let intervalHat, spread, last, learning;

  if (m === 0) {
    if (priorIntervalDays === null) {
      return { currentStock, consumptionRate: null, expectedRunout: null,
               depletionLow: null, depletionHigh: null, notifyDate: null, learning: false };
    }
    intervalHat = prior; spread = prior * 0.3;
    last = new Date(); learning = false;
  } else if (m === 1) {
    intervalHat = prior; spread = prior * 0.3;
    last = new Date(openings[0]); learning = false;
  } else {
    const sorted = [...openings].map(d => new Date(d)).sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(Math.max((sorted[i] - sorted[i - 1]) / MS, 1.0));
    }
    const med = _median(intervals);
    if (m >= 4) {
      intervalHat = med;
      spread = intervals.length >= 4 ? _iqr(intervals) : intervalHat * 0.3;
    } else {
      const w = m / (m + priorK);
      intervalHat = w * med + (1 - w) * prior;
      spread = intervalHat * 0.3;
    }
    last = sorted[sorted.length - 1]; learning = true;
  }

  const half = spread / 2;
  const expectedRunout = new Date(last.getTime() + intervalHat * S * MS);
  const notifyDate    = new Date(expectedRunout.getTime() - (leadTime + safetyMargin) * MS);

  return {
    currentStock,
    consumptionRate: pkg / intervalHat,
    expectedRunout,
    depletionLow:  new Date(last.getTime() + Math.max(intervalHat - half, 1) * S * MS),
    depletionHigh: new Date(last.getTime() + (intervalHat + half) * S * MS),
    notifyDate,
    learning,
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

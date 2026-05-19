from datetime import datetime, timedelta
from statistics import median
from typing import TypedDict


class ForecastResult(TypedDict):
    current_stock: float
    consumption_rate: float | None
    expected_runout: datetime | None
    depletion_low: datetime | None
    depletion_high: datetime | None
    notify_date: datetime | None
    learning: bool


def _iqr(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    q1 = s[n // 4]
    q3 = s[(3 * n) // 4]
    return q3 - q1


def calc_stock(
    initial_stock: float,
    purchase_qty_sum: float,
    opening_count: int,
) -> float:
    return initial_stock + purchase_qty_sum - opening_count


def estimate(
    openings: list[datetime],
    current_stock: float,
    package_qty: float = 1.0,
    prior_interval_days: float | None = None,
    lead_time: int = 3,
    safety_margin: int = 2,
    prior_k: int = 2,
) -> ForecastResult:
    """
    openings: 使用開始イベントの昇順 datetime リスト
    current_stock: 現在庫数（初期在庫 + 購入合計 - 使用開始回数）
    """
    prior = prior_interval_days if prior_interval_days is not None else 30.0
    pkg = package_qty if package_qty else 1.0
    m = len(openings)
    S = max(current_stock, 1.0)

    if m == 0:
        # 使用開始記録なし → 在庫数のみ表示、予測なし（事前分布もなければ）
        if prior_interval_days is None:
            return ForecastResult(
                current_stock=current_stock,
                consumption_rate=None,
                expected_runout=None,
                depletion_low=None,
                depletion_high=None,
                notify_date=None,
                learning=False,
            )
        # 事前分布申告がある場合は暫定予測
        interval_hat = prior
        spread = prior * 0.3
        last = datetime.now()
        learning = False
    elif m == 1:
        interval_hat = prior
        spread = prior * 0.3
        last = openings[-1]
        learning = False
    else:
        intervals = [
            max((openings[i] - openings[i - 1]).total_seconds() / 86400.0, 1.0)
            for i in range(1, m)
        ]
        med = median(intervals)
        if m >= 4:
            interval_hat = med
            spread = _iqr(intervals) if len(intervals) >= 4 else interval_hat * 0.3
        else:
            w_data = m / (m + prior_k)
            interval_hat = w_data * med + (1 - w_data) * prior
            spread = interval_hat * 0.3
        last = openings[-1]
        learning = True

    half = spread / 2.0
    expected_runout = last + timedelta(days=interval_hat * S)
    notify_date = expected_runout - timedelta(days=lead_time + safety_margin)

    return ForecastResult(
        current_stock=current_stock,
        consumption_rate=pkg / interval_hat,
        expected_runout=expected_runout,
        depletion_low=last + timedelta(days=max(interval_hat - half, 1.0) * S),
        depletion_high=last + timedelta(days=(interval_hat + half) * S),
        notify_date=notify_date,
        learning=learning,
    )


def compute_status(notify_date: datetime | None, expected_runout: datetime | None) -> str:
    if notify_date is None or expected_runout is None:
        return "ok"
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    if today >= expected_runout.replace(hour=0, minute=0, second=0, microsecond=0):
        return "overdue"
    if today >= notify_date.replace(hour=0, minute=0, second=0, microsecond=0):
        return "soon"
    return "ok"

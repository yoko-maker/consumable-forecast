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


def parse_dt(value: str) -> datetime:
    """ISO 8601 文字列をローカル時刻の naive datetime に変換する（"Z" やオフセット付きも可）。"""
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def stock_timeline(
    initial_stock: float,
    purchases: list[tuple[datetime, float]],
    openings: list[datetime],
) -> tuple[float, list[bool]]:
    """
    在庫数を時系列で積み上げる。
    在庫0での使用開始は購入の記録漏れとみなし、0 未満にはしない
    （在庫切れ後の購入は 0 から数え直される）。
    同時刻なら購入 → 使用開始の順に処理する。

    戻り値: (現在の未開封在庫数, empty_after)
      empty_after[i]: i 番目（openings の並び順）の使用開始で未開封在庫が 0 になった
    """
    events = [(t, 0, qty, None) for t, qty in purchases] + [
        (t, 1, -1.0, i) for i, t in enumerate(openings)
    ]
    stock = float(initial_stock)
    empty_after = [False] * len(openings)
    for _, _, delta, idx in sorted(events, key=lambda e: (e[0], e[1])):
        stock = max(stock + delta, 0.0)
        if idx is not None:
            empty_after[idx] = stock == 0
    return stock, empty_after


def calc_stock(
    initial_stock: float,
    purchases: list[tuple[datetime, float]],
    openings: list[datetime],
) -> float:
    return stock_timeline(initial_stock, purchases, openings)[0]


def estimate(
    openings: list[datetime],
    current_stock: float,
    package_qty: float = 1.0,
    prior_interval_days: float | None = None,
    lead_time: int = 3,
    safety_margin: int = 2,
    prior_k: int = 2,
    start: datetime | None = None,
    empty_after: list[bool] | None = None,
) -> ForecastResult:
    """
    openings: 使用開始イベントの昇順 datetime リスト
    current_stock: 未開封の在庫数（calc_stock の結果）
    start: 使用開始記録がないときの起点（品目の登録日時）。省略時は現在時刻
    empty_after: stock_timeline の結果（openings と同じ並び）。在庫切れをはさむ間隔は
                 買い待ちの時間を含むので、ほかに十分なデータがあれば学習から除く
    """
    prior = prior_interval_days if prior_interval_days is not None else 30.0
    pkg = package_qty if package_qty else 1.0
    m = len(openings)
    # 使用開始済みなら「使用中の1個 + 未開封の在庫」、未使用なら在庫数だけ持つ
    S = current_stock + 1 if m >= 1 else current_stock

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
        last = start or datetime.now()
        learning = False
    elif m == 1:
        interval_hat = prior
        spread = prior * 0.3
        last = openings[-1]
        learning = False
    else:
        all_intervals: list[float] = []
        clean: list[float] = []
        for i in range(1, m):
            v = max((openings[i] - openings[i - 1]).total_seconds() / 86400.0, 1.0)
            all_intervals.append(v)
            if not (empty_after and empty_after[i - 1]):
                clean.append(v)
        intervals = clean if len(clean) >= 2 else all_intervals
        n = len(intervals) + 1  # 有効な間隔数に対応する観測数
        med = median(intervals)
        if n >= 4:
            interval_hat = med
            spread = _iqr(intervals) if len(intervals) >= 4 else interval_hat * 0.3
        else:
            w_data = n / (n + prior_k)
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

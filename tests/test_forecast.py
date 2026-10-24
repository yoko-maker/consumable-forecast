from datetime import datetime, timedelta, timezone

import pytest

from app.forecast import estimate, compute_status, calc_stock, parse_dt


BASE = datetime(2026, 1, 1)


def days(n):
    return BASE + timedelta(days=n)


# ── calc_stock ───────────────────────────────────────────────────────────────

def test_stock_calculation():
    assert calc_stock(3, [(days(1), 2.0)], [days(2)]) == 4.0   # 初期3 + 購入2 - 使用1 = 4
    assert calc_stock(0, [], []) == 0.0
    assert calc_stock(1, [], [days(1)]) == 0.0


def test_stock_resets_after_running_out():
    # 在庫1 → 使用3回（2回は購入記録漏れ）→ 2個購入: 在庫はマイナスを引きずらず 2
    openings = [days(1), days(10), days(20)]
    assert calc_stock(1, [(days(30), 2.0)], openings) == 2.0


def test_stock_same_time_purchase_then_opening():
    # 同時刻の「買った」→「使用開始」は在庫0から 1 → 0
    assert calc_stock(0, [(days(1), 1.0)], [days(1)]) == 0.0


def test_parse_dt_aware_to_local_naive():
    dt = parse_dt("2026-01-01T00:00:00Z")
    assert dt.tzinfo is None
    assert dt == datetime(2026, 1, 1, tzinfo=timezone.utc).astimezone().replace(tzinfo=None)


# ── 在庫0と1で予測が変わる（使用中の1個を数える）──────────────────────────────

def test_stock_zero_vs_one_differ():
    openings = [days(i * 30) for i in range(5)]
    r0 = estimate(openings, current_stock=0)
    r1 = estimate(openings, current_stock=1)
    assert r0["expected_runout"] == days(120 + 30)
    assert r1["expected_runout"] == days(120 + 60)


# ── 使用開始なし → 登録日時が起点（毎回ずれない）──────────────────────────────

def test_no_openings_uses_start():
    r = estimate([], current_stock=2, prior_interval_days=10, start=days(0))
    assert r["expected_runout"] == days(20)


# ── 使用開始なし → 予測なし（prior_interval_daysもなし）────────────────────

def test_no_openings_no_prior():
    result = estimate([], current_stock=2)
    assert result["expected_runout"] is None
    assert result["notify_date"] is None
    assert result["learning"] is False


# ── 使用開始なし → 事前分布で暫定予測 ────────────────────────────────────────

def test_no_openings_with_prior():
    result = estimate([], current_stock=3, prior_interval_days=30)
    assert result["expected_runout"] is not None
    assert result["learning"] is False


# ── 在庫数が多いほど枯渇日が延びる ──────────────────────────────────────────

def test_stock_extends_runout():
    openings = [days(i * 30) for i in range(5)]
    r1 = estimate(openings, current_stock=1, prior_interval_days=30)
    r3 = estimate(openings, current_stock=3, prior_interval_days=30)
    assert r3["expected_runout"] > r1["expected_runout"]


# ── 等間隔データ → 間隔がそのまま推定される ──────────────────────────────────

def test_regular_interval():
    openings = [days(i * 30) for i in range(5)]
    result = estimate(openings, current_stock=1, prior_interval_days=30)
    assert result["consumption_rate"] == pytest.approx(1.0 / 30.0, rel=0.05)
    assert result["learning"] is True


# ── まとめ使用（外れ値）に頑健 ────────────────────────────────────────────────

def test_outlier_robust():
    openings = [days(0), days(30), days(60), days(61), days(90)]
    result = estimate(openings, current_stock=2)
    rate = result["consumption_rate"]
    assert 0.01 < rate < 0.1


# ── ベイズ収束 ────────────────────────────────────────────────────────────────

def test_bayesian_convergence():
    prior = 60.0
    actual = 30
    few  = [days(i * actual) for i in range(2)]
    many = [days(i * actual) for i in range(10)]
    r_few  = estimate(few,  current_stock=1, prior_interval_days=prior)
    r_many = estimate(many, current_stock=1, prior_interval_days=prior)
    int_few  = 1.0 / r_few["consumption_rate"]
    int_many = 1.0 / r_many["consumption_rate"]
    assert abs(int_many - actual) < abs(int_few - actual)


# ── 通知日 ───────────────────────────────────────────────────────────────────

def test_notify_date():
    openings = [days(i * 30) for i in range(5)]
    result = estimate(openings, current_stock=2, lead_time=3, safety_margin=2)
    expected = result["expected_runout"] - timedelta(days=5)
    assert abs((result["notify_date"] - expected).total_seconds()) < 1


# ── compute_status ───────────────────────────────────────────────────────────

def test_status_ok():
    assert compute_status(datetime.now() + timedelta(20), datetime.now() + timedelta(30)) == "ok"

def test_status_soon():
    assert compute_status(datetime.now() - timedelta(1), datetime.now() + timedelta(10)) == "soon"

def test_status_overdue():
    assert compute_status(datetime.now() - timedelta(5), datetime.now() - timedelta(1)) == "overdue"

def test_status_none():
    assert compute_status(None, None) == "ok"


# ── 在庫切れをはさむ間隔は学習から除く ────────────────────────────────────────

def test_stockout_interval_excluded():
    # 10日ごとに使用、ただし 20→50日 は在庫切れで買い待ち（30日）
    openings = [days(0), days(10), days(20), days(50), days(60), days(70)]
    empty_after = [False, False, True, False, False, False]
    with_flag = estimate(openings, current_stock=1, empty_after=empty_after)
    without   = estimate(openings, current_stock=1)
    assert 1.0 / with_flag["consumption_rate"] == pytest.approx(10.0)
    assert 1.0 / without["consumption_rate"] >= 10.0


def test_stock_timeline_marks_empty():
    from app.forecast import stock_timeline
    # 在庫1 → 使用(0) → 購入1 → 使用(0) → 使用(0, 記録漏れ)
    stock, empty = stock_timeline(1, [(days(5), 1.0)], [days(1), days(10), days(20)])
    assert stock == 0
    assert empty == [True, True, True]
    stock, empty = stock_timeline(3, [], [days(1), days(10)])
    assert stock == 1 and empty == [False, False]

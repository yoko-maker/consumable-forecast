import sqlite3
from datetime import datetime

from .forecast import estimate, parse_dt, stock_timeline
from .models import get_connection
from .notify import update_shopping_weekday


def _parse_or_none(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return parse_dt(value)
    except ValueError:
        return None


def _recompute(conn: sqlite3.Connection, item: sqlite3.Row, settings: sqlite3.Row, now_str: str) -> None:
    purchase_rows = conn.execute(
        "SELECT purchased_at, quantity FROM purchases WHERE item_id = ?",
        (item["id"],),
    ).fetchall()
    opening_rows = conn.execute(
        "SELECT opened_at FROM openings WHERE item_id = ?",
        (item["id"],),
    ).fetchall()

    purchases = []
    for r in purchase_rows:
        t = _parse_or_none(r["purchased_at"])
        if t is not None:
            purchases.append((t, r["quantity"] if r["quantity"] is not None else 1.0))
    openings = sorted(
        t for t in (_parse_or_none(r["opened_at"]) for r in opening_rows) if t is not None
    )

    current_stock, empty_after = stock_timeline(item["initial_stock"] or 0, purchases, openings)

    result = estimate(
        openings=openings,
        current_stock=current_stock,
        package_qty=item["package_qty"] or 1.0,
        prior_interval_days=item["prior_interval_days"],
        lead_time=settings["lead_time_days"],
        safety_margin=settings["safety_margin_days"],
        start=_parse_or_none(item["created_at"]),
        empty_after=empty_after,
    )

    conn.execute(
        """
        INSERT OR REPLACE INTO estimates
            (item_id, current_stock, consumption_rate, expected_runout,
             depletion_low, depletion_high, notify_date, learning, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item["id"],
            result["current_stock"],
            result["consumption_rate"],
            result["expected_runout"].isoformat() if result["expected_runout"] else None,
            result["depletion_low"].isoformat() if result["depletion_low"] else None,
            result["depletion_high"].isoformat() if result["depletion_high"] else None,
            result["notify_date"].isoformat() if result["notify_date"] else None,
            int(result["learning"]),
            now_str,
        ),
    )


def recompute_item(item_id: int) -> None:
    with get_connection() as conn:
        settings = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
        item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            return
        _recompute(conn, item, settings, datetime.now().isoformat())


def recompute_all() -> int:
    with get_connection() as conn:
        settings = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
        items = conn.execute("SELECT * FROM items WHERE archived = 0").fetchall()
        now_str = datetime.now().isoformat()
        for item in items:
            _recompute(conn, item, settings, now_str)

    update_shopping_weekday()
    return len(items)


def daily_job() -> None:
    recompute_all()

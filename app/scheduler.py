from datetime import datetime

from .forecast import estimate, calc_stock
from .models import get_connection
from .notify import update_shopping_weekday


def recompute_all() -> int:
    with get_connection() as conn:
        settings = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
        items = conn.execute("SELECT * FROM items WHERE archived = 0").fetchall()

    lead_time = settings["lead_time_days"]
    safety_margin = settings["safety_margin_days"]
    now_str = datetime.now().isoformat()
    count = 0

    for item in items:
        with get_connection() as conn:
            purchase_rows = conn.execute(
                "SELECT quantity FROM purchases WHERE item_id = ?",
                (item["id"],),
            ).fetchall()
            opening_rows = conn.execute(
                "SELECT opened_at FROM openings WHERE item_id = ? ORDER BY opened_at",
                (item["id"],),
            ).fetchall()

        purchase_qty_sum = sum(r["quantity"] for r in purchase_rows)
        opening_count = len(opening_rows)
        current_stock = calc_stock(
            item["initial_stock"] or 0,
            purchase_qty_sum,
            opening_count,
        )

        openings = []
        for r in opening_rows:
            try:
                openings.append(datetime.fromisoformat(r["opened_at"]))
            except ValueError:
                continue

        result = estimate(
            openings=openings,
            current_stock=current_stock,
            package_qty=item["package_qty"] or 1.0,
            prior_interval_days=item["prior_interval_days"],
            lead_time=lead_time,
            safety_margin=safety_margin,
        )

        with get_connection() as conn:
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
        count += 1

    update_shopping_weekday()
    return count


def daily_job() -> None:
    recompute_all()

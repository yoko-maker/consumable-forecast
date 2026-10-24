from datetime import datetime

from .models import get_connection


def get_soon_items() -> list[dict]:
    """notify_date が今日以前の品目を返す（そろそろリスト）。"""
    today = datetime.now().strftime("%Y-%m-%d")
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT i.id, i.name, e.expected_runout, e.depletion_low,
                   e.depletion_high, e.notify_date, e.consumption_rate
            FROM items i
            JOIN estimates e ON e.item_id = i.id
            WHERE i.archived = 0
              AND substr(e.notify_date, 1, 10) <= ?
            ORDER BY e.expected_runout
            """,
            (today,),
        ).fetchall()
    return [dict(r) for r in rows]


def update_shopping_weekday() -> None:
    """purchases の曜日分布から最頻曜日を settings に書き込む。"""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT purchased_at FROM purchases"
        ).fetchall()

    if len(rows) < 10:
        return

    counts: list[int] = [0] * 7
    for row in rows:
        try:
            dt = datetime.fromisoformat(row["purchased_at"])
            counts[dt.weekday()] += 1
        except ValueError:
            continue

    best = counts.index(max(counts))
    with get_connection() as conn:
        conn.execute(
            "UPDATE settings SET shopping_weekday = ? WHERE id = 1", (best,)
        )

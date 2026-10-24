from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import notion_sync
from .forecast import compute_status, parse_dt
from .models import get_connection
from .scheduler import recompute_all, recompute_item as _recompute_item

router = APIRouter(prefix="/api")


# ── Pydantic schemas ────────────────────────────────────────────────────────

class ItemCreate(BaseModel):
    name: str
    initial_stock: float = 0
    package_qty: float | None = None
    stock_unit: str = "個"
    unit_price: float | None = None
    prior_interval_days: float | None = None
    is_seasonal: bool = False


class ItemPatch(BaseModel):
    name: str | None = None
    initial_stock: float | None = None
    package_qty: float | None = None
    stock_unit: str | None = None
    unit_price: float | None = None
    prior_interval_days: float | None = None
    is_seasonal: bool | None = None


class PurchaseCreate(BaseModel):
    quantity: float = 1.0
    purchased_at: str | None = None
    source: str = "manual"


class OpeningCreate(BaseModel):
    opened_at: str | None = None
    source: str = "manual"


class SoonCheck(BaseModel):
    item_ids: list[int]


class SettingsPatch(BaseModel):
    lead_time_days: int | None = None
    safety_margin_days: int | None = None
    notify_time: str | None = None


# ── helpers ─────────────────────────────────────────────────────────────────

def _normalize_dt(value: str | None) -> str:
    """入力日時をローカル時刻の naive ISO 文字列にそろえる（未指定なら現在時刻）。"""
    if value is None:
        return datetime.now().isoformat()
    try:
        return parse_dt(value).isoformat()
    except ValueError:
        raise HTTPException(422, f"invalid datetime: {value}")


def _item_with_estimate(item_id: int) -> dict:
    with get_connection() as conn:
        item = conn.execute(
            "SELECT * FROM items WHERE id = ? AND archived = 0", (item_id,)
        ).fetchone()
        if item is None:
            raise HTTPException(404, "item not found")
        est = conn.execute(
            "SELECT * FROM estimates WHERE item_id = ?", (item_id,)
        ).fetchone()
        last_p = conn.execute(
            "SELECT purchased_at FROM purchases WHERE item_id = ? ORDER BY purchased_at DESC LIMIT 1",
            (item_id,),
        ).fetchone()
        last_o = conn.execute(
            "SELECT opened_at FROM openings WHERE item_id = ? ORDER BY opened_at DESC LIMIT 1",
            (item_id,),
        ).fetchone()

    d = dict(item)
    if est:
        d.update(dict(est))
        d["status"] = compute_status(
            datetime.fromisoformat(est["notify_date"]) if est["notify_date"] else None,
            datetime.fromisoformat(est["expected_runout"]) if est["expected_runout"] else None,
        )
    else:
        d["current_stock"] = item["initial_stock"] or 0
        d["status"] = "ok"
    d["last_purchase"] = last_p["purchased_at"] if last_p else None
    d["last_opening"] = last_o["opened_at"] if last_o else None
    return d


# ── items ────────────────────────────────────────────────────────────────────

@router.get("/items")
def list_items():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id FROM items WHERE archived = 0 ORDER BY name"
        ).fetchall()
    return [_item_with_estimate(r["id"]) for r in rows]


@router.post("/items", status_code=201)
def create_item(body: ItemCreate):
    now = datetime.now().isoformat()
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO items
               (name, initial_stock, package_qty, stock_unit, unit_price,
                prior_interval_days, is_seasonal, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.name, body.initial_stock, body.package_qty, body.stock_unit,
             body.unit_price, body.prior_interval_days, int(body.is_seasonal), now),
        )
        item_id = cur.lastrowid
    _recompute_item(item_id)
    return _item_with_estimate(item_id)


@router.patch("/items/{item_id}")
def patch_item(item_id: int, body: ItemPatch):
    # 送られた項目だけ更新する。任意項目は null を送ると解除できる
    fields = body.model_dump(exclude_unset=True)
    for required in ("name", "initial_stock", "stock_unit", "is_seasonal"):
        if required in fields and fields[required] is None:
            raise HTTPException(422, f"{required} cannot be null")
    if not fields:
        raise HTTPException(400, "no fields to update")
    if "is_seasonal" in fields:
        fields["is_seasonal"] = int(fields["is_seasonal"])
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_connection() as conn:
        cur = conn.execute(
            f"UPDATE items SET {set_clause} WHERE id = ? AND archived = 0",
            (*fields.values(), item_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "item not found")
    _recompute_item(item_id)
    return _item_with_estimate(item_id)


@router.delete("/items/{item_id}", status_code=204)
def archive_item(item_id: int):
    with get_connection() as conn:
        conn.execute("UPDATE items SET archived = 1 WHERE id = ?", (item_id,))


# ── purchases（買った）────────────────────────────────────────────────────────

@router.post("/items/{item_id}/purchases", status_code=201)
def add_purchase(item_id: int, body: PurchaseCreate):
    purchased_at = _normalize_dt(body.purchased_at)
    today = purchased_at[:10]

    with get_connection() as conn:
        item = conn.execute(
            "SELECT id, name FROM items WHERE id = ? AND archived = 0", (item_id,)
        ).fetchone()
        if item is None:
            raise HTTPException(404, "item not found")

        # 同日の手動記録があれば数量加算
        existing = conn.execute(
            """SELECT id, quantity FROM purchases
               WHERE item_id = ? AND substr(purchased_at,1,10) = ? AND source != 'import'
               ORDER BY id DESC LIMIT 1""",
            (item_id, today),
        ).fetchone()

        if existing and body.purchased_at is None:
            conn.execute(
                "UPDATE purchases SET quantity = ? WHERE id = ?",
                (existing["quantity"] + body.quantity, existing["id"]),
            )
            purchase_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO purchases (item_id, purchased_at, quantity, source) VALUES (?, ?, ?, ?)",
                (item_id, purchased_at, body.quantity, body.source),
            )
            purchase_id = cur.lastrowid

    _recompute_item(item_id)
    notion_sync.sync_purchase(
        item_id=item_id,
        item_name=item["name"],
        quantity=body.quantity,
        purchased_at=purchased_at,
        source=body.source,
    )
    return {"id": purchase_id, "item_id": item_id, "purchased_at": purchased_at}


@router.delete("/purchases/{purchase_id}", status_code=204)
def delete_purchase(purchase_id: int):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT item_id FROM purchases WHERE id = ?", (purchase_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "purchase not found")
        item_id = row["item_id"]
        conn.execute("DELETE FROM purchases WHERE id = ?", (purchase_id,))
    _recompute_item(item_id)


# ── openings（使用開始）──────────────────────────────────────────────────────

@router.post("/items/{item_id}/openings", status_code=201)
def add_opening(item_id: int, body: OpeningCreate):
    opened_at = _normalize_dt(body.opened_at)

    with get_connection() as conn:
        item = conn.execute(
            "SELECT id FROM items WHERE id = ? AND archived = 0", (item_id,)
        ).fetchone()
        if item is None:
            raise HTTPException(404, "item not found")
        cur = conn.execute(
            "INSERT INTO openings (item_id, opened_at, source) VALUES (?, ?, ?)",
            (item_id, opened_at, body.source),
        )
        opening_id = cur.lastrowid

    _recompute_item(item_id)
    return {"id": opening_id, "item_id": item_id, "opened_at": opened_at}


@router.delete("/openings/{opening_id}", status_code=204)
def delete_opening(opening_id: int):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT item_id FROM openings WHERE id = ?", (opening_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "opening not found")
        item_id = row["item_id"]
        conn.execute("DELETE FROM openings WHERE id = ?", (opening_id,))
    _recompute_item(item_id)


# ── soon list ────────────────────────────────────────────────────────────────

@router.get("/soon")
def soon_list():
    from .notify import get_soon_items
    return get_soon_items()


@router.post("/soon/check")
def check_soon(body: SoonCheck):
    now = datetime.now().isoformat()
    with get_connection() as conn:
        found = {
            r["id"] for r in conn.execute(
                f"SELECT id FROM items WHERE archived = 0 AND id IN ({','.join('?' * len(body.item_ids))})",
                body.item_ids,
            )
        } if body.item_ids else set()
    missing = [i for i in body.item_ids if i not in found]
    if missing:
        raise HTTPException(404, f"item not found: {missing}")
    results = []
    for item_id in body.item_ids:
        with get_connection() as conn:
            cur = conn.execute(
                "INSERT INTO purchases (item_id, purchased_at, quantity, source) VALUES (?, ?, 1.0, 'list')",
                (item_id, now),
            )
            purchase_id = cur.lastrowid
        _recompute_item(item_id)
        results.append({"purchase_id": purchase_id, "item_id": item_id})
    return results


# ── settings ─────────────────────────────────────────────────────────────────

@router.get("/settings")
def get_settings():
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return dict(row)


@router.patch("/settings")
def patch_settings(body: SettingsPatch):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(400, "no fields to update")
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_connection() as conn:
        conn.execute(
            f"UPDATE settings SET {set_clause} WHERE id = 1", (*fields.values(),)
        )
        row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return dict(row)


# ── export / import ──────────────────────────────────────────────────────────

@router.get("/export")
def export_data():
    with get_connection() as conn:
        items = [dict(r) for r in conn.execute("SELECT * FROM items").fetchall()]
        purchases = [dict(r) for r in conn.execute("SELECT * FROM purchases").fetchall()]
        openings = [dict(r) for r in conn.execute("SELECT * FROM openings").fetchall()]
        settings = dict(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())
    return {"items": items, "purchases": purchases, "openings": openings, "settings": settings}


@router.post("/import", status_code=204)
def import_data(body: dict):
    with get_connection() as conn:
        conn.execute("DELETE FROM estimates")
        conn.execute("DELETE FROM openings")
        conn.execute("DELETE FROM purchases")
        conn.execute("DELETE FROM items")
        for item in body.get("items", []):
            conn.execute(
                """INSERT OR REPLACE INTO items
                   (id, name, initial_stock, package_qty, stock_unit, unit_price,
                    prior_interval_days, is_seasonal, created_at, archived)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (item["id"], item["name"], item.get("initial_stock", 0),
                 item.get("package_qty"), item.get("stock_unit", "個"),
                 item.get("unit_price"), item.get("prior_interval_days"),
                 item.get("is_seasonal", 0), item.get("created_at", ""),
                 item.get("archived", 0)),
            )
        for p in body.get("purchases", []):
            conn.execute(
                "INSERT OR REPLACE INTO purchases (id, item_id, purchased_at, quantity, source) VALUES (?, ?, ?, ?, ?)",
                (p["id"], p["item_id"], p["purchased_at"],
                 p.get("quantity", 1.0), p.get("source", "import")),
            )
        for o in body.get("openings", []):
            conn.execute(
                "INSERT OR REPLACE INTO openings (id, item_id, opened_at, source) VALUES (?, ?, ?, ?)",
                (o["id"], o["item_id"], o["opened_at"], o.get("source", "import")),
            )
        s = body.get("settings", {})
        if s:
            conn.execute(
                """UPDATE settings SET lead_time_days=?, safety_margin_days=?,
                   notify_time=?, shopping_weekday=? WHERE id=1""",
                (s.get("lead_time_days", 3), s.get("safety_margin_days", 2),
                 s.get("notify_time", "08:00"), s.get("shopping_weekday")),
            )
    recompute_all()


@router.post("/recompute")
def manual_recompute():
    count = recompute_all()
    return {"recomputed": count}

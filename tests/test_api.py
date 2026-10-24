import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
_tmp.close()

import app.models as _models
_models.DB_PATH = Path(_tmp.name)

from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_db():
    _models.init_db()
    yield
    with _models.get_connection() as conn:
        conn.executescript(
            "DELETE FROM estimates; DELETE FROM openings; DELETE FROM purchases; DELETE FROM items;"
        )


# ── 品目登録（初期在庫・単位含む）────────────────────────────────────────────

def test_create_item_basic():
    r = client.post("/api/items", json={"name": "シャンプー"})
    assert r.status_code == 201
    d = r.json()
    assert d["name"] == "シャンプー"
    assert d["current_stock"] == 0
    assert d["stock_unit"] == "個"


def test_create_item_with_stock():
    r = client.post("/api/items", json={
        "name": "洗剤", "initial_stock": 3, "stock_unit": "本",
        "package_qty": 500, "prior_interval_days": 30
    })
    assert r.status_code == 201
    d = r.json()
    assert d["initial_stock"] == 3
    assert d["current_stock"] == 3
    assert d["stock_unit"] == "本"


# ── 「買った」で在庫増 ────────────────────────────────────────────────────────

def test_purchase_increases_stock():
    item = client.post("/api/items", json={"name": "コーヒー", "initial_stock": 1}).json()
    item_id = item["id"]

    r = client.post(f"/api/items/{item_id}/purchases", json={"quantity": 2})
    assert r.status_code == 201

    updated = client.get("/api/items").json()[0]
    assert updated["current_stock"] == 3  # 初期1 + 購入2


# ── 「使用開始」で在庫減・学習開始 ───────────────────────────────────────────

def test_opening_decreases_stock_and_learns():
    item = client.post("/api/items", json={"name": "薬", "initial_stock": 5}).json()
    item_id = item["id"]

    base = datetime.now() - timedelta(days=60)
    for i in range(3):
        opened_at = (base + timedelta(days=i * 30)).isoformat()
        r = client.post(f"/api/items/{item_id}/openings", json={"opened_at": opened_at})
        assert r.status_code == 201

    updated = client.get("/api/items").json()[0]
    assert updated["current_stock"] == 2   # 初期5 - 使用3
    assert updated["expected_runout"] is not None


# ── 使用開始なしは予測なし ────────────────────────────────────────────────────

def test_no_opening_no_estimate():
    item = client.post("/api/items", json={"name": "ペットフード", "initial_stock": 2}).json()
    updated = client.get("/api/items").json()[0]
    assert updated["expected_runout"] is None


# ── 在庫が多いほど枯渇日が延びる ─────────────────────────────────────────────

def test_more_stock_later_runout():
    def make_item(initial):
        item = client.post("/api/items", json={"name": f"item_{initial}", "initial_stock": initial}).json()
        base = datetime.now() - timedelta(days=60)
        for i in range(3):
            client.post(f"/api/items/{item['id']}/openings",
                        json={"opened_at": (base + timedelta(days=i * 30)).isoformat()})
        return client.get(f"/api/items").json()

    items1 = [i for i in make_item(1) if i["name"] == "item_1"]
    items3 = [i for i in make_item(3) if i["name"] == "item_3"]

    runout1 = items1[0]["expected_runout"]
    runout3 = items3[0]["expected_runout"]
    assert runout3 > runout1


# ── そろそろリスト ────────────────────────────────────────────────────────────

def test_soon_flow():
    item = client.post("/api/items", json={"name": "コンタクト", "initial_stock": 1,
                                           "prior_interval_days": 7}).json()
    item_id = item["id"]

    old = (datetime.now() - timedelta(days=14)).isoformat()
    client.post(f"/api/items/{item_id}/openings", json={"opened_at": old})

    soon = client.get("/api/soon").json()
    assert any(s["id"] == item_id for s in soon)


# ── エクスポート／インポートに openings が含まれる ────────────────────────────

def test_export_includes_openings():
    item = client.post("/api/items", json={"name": "薬", "initial_stock": 2}).json()
    client.post(f"/api/items/{item['id']}/openings", json={})
    export = client.get("/api/export").json()
    assert "openings" in export
    assert len(export["openings"]) == 1


# ── 記録の取消 ────────────────────────────────────────────────────────────────

def test_delete_purchase():
    item = client.post("/api/items", json={"name": "洗剤", "initial_stock": 1}).json()
    p = client.post(f"/api/items/{item['id']}/purchases", json={}).json()
    r = client.delete(f"/api/purchases/{p['id']}")
    assert r.status_code == 204
    updated = client.get("/api/items").json()[0]
    assert updated["current_stock"] == 1  # 購入分が消えて初期値に戻る


def test_delete_opening():
    item = client.post("/api/items", json={"name": "薬", "initial_stock": 3}).json()
    o = client.post(f"/api/items/{item['id']}/openings", json={}).json()
    r = client.delete(f"/api/openings/{o['id']}")
    assert r.status_code == 204
    updated = client.get("/api/items").json()[0]
    assert updated["current_stock"] == 3  # 使用開始が消えて戻る


# ── 通知日が今日の品目もそろそろリストに出る ──────────────────────────────────

def test_soon_includes_notify_today():
    item = client.post("/api/items", json={"name": "歯磨き粉", "prior_interval_days": 5}).json()
    now = datetime.now()
    for d in (timedelta(days=5, hours=1), timedelta(hours=1)):
        client.post(f"/api/items/{item['id']}/openings", json={"opened_at": (now - d).isoformat()})
    d = client.get("/api/items").json()[0]
    assert d["notify_date"][:10] <= now.strftime("%Y-%m-%d")
    assert any(s["id"] == item["id"] for s in client.get("/api/soon").json())


# ── タイムゾーン付き日時も受け付ける ──────────────────────────────────────────

def test_timezone_aware_datetime():
    item = client.post("/api/items", json={"name": "洗剤", "initial_stock": 3}).json()
    for ts in ("2026-01-01T01:00:00Z", "2026-01-31T10:00:00+09:00"):
        r = client.post(f"/api/items/{item['id']}/openings", json={"opened_at": ts})
        assert r.status_code == 201
    r = client.post(f"/api/items/{item['id']}/purchases", json={"purchased_at": "2026-02-01T00:00:00Z"})
    assert r.status_code == 201
    d = client.get("/api/items").json()[0]
    assert d["current_stock"] == 2
    assert d["expected_runout"] is not None


def test_invalid_datetime_rejected():
    item = client.post("/api/items", json={"name": "洗剤"}).json()
    r = client.post(f"/api/items/{item['id']}/openings", json={"opened_at": "not-a-date"})
    assert r.status_code == 422


# ── 在庫切れ後の購入は 0 から数え直す ─────────────────────────────────────────

def test_stock_resets_after_running_out_api():
    item = client.post("/api/items", json={"name": "ティッシュ", "initial_stock": 1}).json()
    base = datetime.now() - timedelta(days=30)
    for i in range(3):
        client.post(f"/api/items/{item['id']}/openings",
                    json={"opened_at": (base + timedelta(days=i * 7)).isoformat()})
    assert client.get("/api/items").json()[0]["current_stock"] == 0
    client.post(f"/api/items/{item['id']}/purchases", json={"quantity": 2})
    assert client.get("/api/items").json()[0]["current_stock"] == 2


# ── PATCH / そろそろチェックの異常系 ──────────────────────────────────────────

def test_patch_missing_item_404():
    assert client.patch("/api/items/99999", json={"name": "x"}).status_code == 404


def test_patch_can_clear_optional_field():
    item = client.post("/api/items", json={"name": "洗剤", "unit_price": 300,
                                           "prior_interval_days": 20}).json()
    r = client.patch(f"/api/items/{item['id']}", json={"unit_price": None})
    assert r.status_code == 200
    assert r.json()["unit_price"] is None
    assert r.json()["prior_interval_days"] == 20  # 送っていない項目はそのまま
    assert client.patch(f"/api/items/{item['id']}", json={"name": None}).status_code == 422


def test_check_soon_unknown_item_404():
    r = client.post("/api/soon/check", json={"item_ids": [99999]})
    assert r.status_code == 404

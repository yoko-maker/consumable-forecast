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

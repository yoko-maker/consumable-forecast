"""Notion への購入履歴転記（オプトイン）。

NOTION_TOKEN と NOTION_DATABASE_ID が設定されている場合のみ動作する。
未設定の場合は何もしない。送信に失敗してもアプリの動作は止めず、警告ログのみ出す。
"""

import logging
import os

import httpx

logger = logging.getLogger(__name__)

NOTION_API_URL = "https://api.notion.com/v1/pages"
NOTION_VERSION = "2022-06-28"


def _config() -> tuple[str, str] | None:
    token = os.environ.get("NOTION_TOKEN")
    database_id = os.environ.get("NOTION_DATABASE_ID")
    if not token or not database_id:
        return None
    return token, database_id


def sync_purchase(
    *,
    item_id: int,
    item_name: str,
    quantity: float,
    purchased_at: str,
    source: str,
) -> None:
    """購入記録を Notion の「消耗品購入履歴」DBに1件追加する。"""
    config = _config()
    if config is None:
        return
    token, database_id = config

    payload = {
        "parent": {"database_id": database_id},
        "properties": {
            "品目名": {"title": [{"text": {"content": item_name}}]},
            "数量": {"number": quantity},
            "購入日": {"date": {"start": purchased_at[:10]}},
            "記録元": {"select": {"name": source}},
            "item_id": {"number": item_id},
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    try:
        response = httpx.post(NOTION_API_URL, json=payload, headers=headers, timeout=5.0)
        response.raise_for_status()
    except Exception:
        logger.warning("Notion sync failed for item_id=%s", item_id, exc_info=True)

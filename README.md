# consumable-forecast

消耗品ストック予測ツール — **在庫を一度も数えずに、切らさず・買いすぎずに回す**個人用ツール。

「買った」という記録だけから消費速度を推定し、なくなる前に先回りして通知します。

## 特徴

- **1タップ記録**: 「買った」ボタンを押すだけ。ダイアログなし。
- **在庫カウント不要**: 購入間隔の中央値から消費速度を自動推定。
- **先回り通知**: `枯渇予測日 − リードタイム − 安全マージン` で買い物前に知らせる。
- **ローカル完結**: データは SQLite1ファイル。外部送信なし。
- **PWA対応**: スマホのホーム画面に追加して使える。

> 本ツールの予測は補助情報です。医療・在庫の正確性を保証しません。

## セットアップ

```bash
# Python 3.10+ が必要
pip install -e ".[dev]"

# 起動（ブラウザで http://localhost:8000 を開く）
python -m app.main
```

または

```bash
consumable-forecast
```

## テスト

```bash
pytest
```

## ディレクトリ構成

```
consumable-forecast/
├── app/
│   ├── main.py       # FastAPI エントリ・スケジューラ起動
│   ├── api.py        # REST API ルーティング
│   ├── models.py     # SQLite スキーマ・接続
│   ├── forecast.py   # 予測エンジン（差し替え可能）
│   ├── scheduler.py  # 日次バッチ（予測再計算）
│   └── notify.py     # そろそろリスト・買い物曜日学習
├── web/              # PWA フロントエンド
│   ├── index.html
│   ├── app.js
│   ├── sw.js
│   └── manifest.json
├── tests/
│   ├── test_forecast.py
│   └── test_api.py
└── docs/
    └── SPEC_PlanB.md
```

## ライセンス

MIT

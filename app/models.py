import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data.sqlite"


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS items (
                id                  INTEGER PRIMARY KEY,
                name                TEXT    NOT NULL,
                initial_stock       REAL    DEFAULT 0,
                package_qty         REAL,
                stock_unit          TEXT    DEFAULT '個',
                unit_price          REAL,
                prior_interval_days REAL,
                is_seasonal         INTEGER DEFAULT 0,
                created_at          TEXT    NOT NULL,
                archived            INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS purchases (
                id           INTEGER PRIMARY KEY,
                item_id      INTEGER NOT NULL REFERENCES items(id),
                purchased_at TEXT    NOT NULL,
                quantity     REAL    DEFAULT 1.0,
                source       TEXT    DEFAULT 'manual'
            );

            CREATE TABLE IF NOT EXISTS openings (
                id        INTEGER PRIMARY KEY,
                item_id   INTEGER NOT NULL REFERENCES items(id),
                opened_at TEXT    NOT NULL,
                source    TEXT    DEFAULT 'manual'
            );

            CREATE TABLE IF NOT EXISTS settings (
                id                  INTEGER PRIMARY KEY CHECK (id = 1),
                lead_time_days      INTEGER DEFAULT 3,
                safety_margin_days  INTEGER DEFAULT 2,
                notify_time         TEXT    DEFAULT '08:00',
                shopping_weekday    INTEGER
            );

            CREATE TABLE IF NOT EXISTS estimates (
                item_id          INTEGER PRIMARY KEY REFERENCES items(id),
                current_stock    REAL,
                consumption_rate REAL,
                expected_runout  TEXT,
                depletion_low    TEXT,
                depletion_high   TEXT,
                notify_date      TEXT,
                learning         INTEGER DEFAULT 0,
                updated_at       TEXT
            );

            INSERT OR IGNORE INTO settings (id) VALUES (1);
        """)
        # 旧DBからのマイグレーション: 列が存在しない場合のみ追加
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(items)")}
    migrations = [
        ("initial_stock", "ALTER TABLE items ADD COLUMN initial_stock REAL DEFAULT 0"),
        ("stock_unit",    "ALTER TABLE items ADD COLUMN stock_unit TEXT DEFAULT '個'"),
    ]
    for col, sql in migrations:
        if col not in existing:
            conn.execute(sql)

    existing_est = {row[1] for row in conn.execute("PRAGMA table_info(estimates)")}
    est_migrations = [
        ("current_stock", "ALTER TABLE estimates ADD COLUMN current_stock REAL"),
        ("learning",      "ALTER TABLE estimates ADD COLUMN learning INTEGER DEFAULT 0"),
    ]
    for col, sql in est_migrations:
        if col not in existing_est:
            conn.execute(sql)

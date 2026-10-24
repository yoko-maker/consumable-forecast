from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler

from .api import router
from .models import init_db
from .scheduler import daily_job


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()

    settings_file = Path(__file__).parent.parent / "notify_time.txt"
    notify_time = "08:00"
    if settings_file.exists():
        notify_time = settings_file.read_text().strip()

    hour, minute = map(int, notify_time.split(":"))
    scheduler = BackgroundScheduler()
    scheduler.add_job(daily_job, "cron", hour=hour, minute=minute)
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Consumable Forecast", version="0.2.0", lifespan=lifespan)
app.include_router(router)

WEB_DIR = Path(__file__).parent.parent / "web"

if WEB_DIR.exists():
    # /static/* でも /foo.js でも同じファイルを参照できるようにする
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


def run():
    import socket
    import uvicorn

    # LAN上のIPアドレスを取得して表示
    try:
        lan_ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        lan_ip = "（取得失敗）"

    print(f"\n  PC:     http://localhost:8000")
    print(f"  スマホ: http://{lan_ip}:8000\n")

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
    )


if __name__ == "__main__":
    run()

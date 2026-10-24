import re
from pathlib import Path

ROOT = Path(__file__).parent.parent


def test_versions_match():
    """pyproject / FastAPI / PWA（web/version.js）のバージョンがそろっていること。"""
    py = re.search(r'^version\s*=\s*"([^"]+)"', (ROOT / "pyproject.toml").read_text(encoding="utf-8"), re.M).group(1)
    web = re.search(r"APP_VERSION\s*=\s*'([^']+)'", (ROOT / "web/version.js").read_text(encoding="utf-8")).group(1)
    api = re.search(r'version="([^"]+)"', (ROOT / "app/main.py").read_text(encoding="utf-8")).group(1)
    assert py == web == api


def test_sw_precaches_existing_files():
    """sw.js の PRECACHE に載っているファイルが実在すること（1つでも欠けるとインストールに失敗する）。"""
    sw = (ROOT / "web/sw.js").read_text(encoding="utf-8")
    block = sw[sw.index("PRECACHE = ["):sw.index("];")]
    for path in re.findall(r"'\./([^']*)'", block):
        if path:
            assert (ROOT / "web" / path).exists(), path

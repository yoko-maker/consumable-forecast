"""web/receipt.js（レシートの読み取り）のテストを Node で実行する。Node がなければスキップ。"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js がない")
def test_receipt_parser_cases():
    r = subprocess.run(
        ["node", str(ROOT / "tests" / "receipt_cases.js")],
        capture_output=True, text=True, cwd=ROOT,
    )
    assert r.returncode == 0, r.stdout + r.stderr

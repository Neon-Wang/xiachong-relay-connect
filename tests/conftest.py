"""
pytest 配置：把 connector 主脚本作为模块导入。

由于 evopaimo-connect.py 文件名含连字符（npm 包习惯），不能直接 import。
这里用 importlib.util 把它注册为模块名 `evopaimo_connect`。
"""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "evopaimo-connect.py"


def _load_connector_module():
    spec = importlib.util.spec_from_file_location("evopaimo_connect", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot create spec for {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["evopaimo_connect"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def connector():
    """加载 connector 主模块，session 级单例"""
    return _load_connector_module()

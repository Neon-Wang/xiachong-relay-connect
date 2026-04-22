"""
detect_transport 单元测试：模式探测决策表。

覆盖 spec 7.1 的所有分支。
"""
import asyncio
from unittest.mock import MagicMock, patch

import pytest


def _patch_hooks(connector, monkeypatch, hooks_works: bool):
    """让 HooksTransport.health_check 返回指定值"""
    async def fake_check(self):
        return hooks_works
    monkeypatch.setattr(connector.HooksTransport, "health_check", fake_check)


def _patch_cli(connector, monkeypatch, cli_path: str | None):
    """让 shutil.which 返回指定路径"""
    monkeypatch.setattr(connector.shutil, "which", lambda x: cli_path)


def test_hooks_configured_and_working_with_cli_fallback(connector, tmp_path, monkeypatch):
    hooks_file = tmp_path / "hooks.json"
    hooks_file.write_text('{"version":1,"base_url":"http://127.0.0.1:18789","token":"t"}')

    _patch_hooks(connector, monkeypatch, hooks_works=True)
    _patch_cli(connector, monkeypatch, "/usr/local/bin/openclaw")

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "hooks"
    assert sup.fallback is not None
    assert sup.fallback.mode == "cli"
    assert sup.active_mode == "hooks"


def test_hooks_configured_but_endpoint_dead_falls_back_cli(connector, tmp_path, monkeypatch):
    hooks_file = tmp_path / "hooks.json"
    hooks_file.write_text('{"version":1,"base_url":"http://127.0.0.1:18789","token":"t"}')

    _patch_hooks(connector, monkeypatch, hooks_works=False)
    _patch_cli(connector, monkeypatch, "/usr/local/bin/openclaw")

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "cli"
    assert sup.fallback is None


def test_no_hooks_config_with_cli_uses_cli(connector, tmp_path, monkeypatch):
    hooks_file = tmp_path / "nonexistent.json"
    _patch_cli(connector, monkeypatch, "/usr/local/bin/openclaw")

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "cli"
    assert sup.fallback is None


def test_no_hooks_no_cli_raises(connector, tmp_path, monkeypatch):
    hooks_file = tmp_path / "nonexistent.json"
    _patch_cli(connector, monkeypatch, None)

    with pytest.raises(RuntimeError, match="OpenClaw 无可用通信通道"):
        asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))


def test_hooks_only_no_cli_works(connector, tmp_path, monkeypatch):
    """hooks 可用 + CLI 不可用：用 hooks，无 fallback"""
    hooks_file = tmp_path / "hooks.json"
    hooks_file.write_text('{"version":1,"base_url":"http://127.0.0.1:18789","token":"t"}')

    _patch_hooks(connector, monkeypatch, hooks_works=True)
    _patch_cli(connector, monkeypatch, None)

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "hooks"
    assert sup.fallback is None


def test_invalid_hooks_config_format_treated_as_no_config(connector, tmp_path, monkeypatch):
    """无 token 或缺字段的 hooks 配置应视为不存在"""
    hooks_file = tmp_path / "hooks.json"
    hooks_file.write_text('{"version":1,"base_url":"http://127.0.0.1:18789"}')  # 缺 token
    _patch_cli(connector, monkeypatch, "/usr/local/bin/openclaw")

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "cli"


def test_corrupt_hooks_config_treated_as_no_config(connector, tmp_path, monkeypatch):
    hooks_file = tmp_path / "hooks.json"
    hooks_file.write_text('not valid json {{{')
    _patch_cli(connector, monkeypatch, "/usr/local/bin/openclaw")

    sup = asyncio.run(connector.detect_transport(hooks_file=str(hooks_file), quiet=True))
    assert sup.primary.mode == "cli"

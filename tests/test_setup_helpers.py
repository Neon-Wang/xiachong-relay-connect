"""
setup 子命令辅助函数测试：版本探测 / 配置文件读写 / 跨平台路径。

setup 主流程涉及 OpenClaw CLI 子进程，集成测试在手动 checklist 中覆盖。
"""
import json
import os


# ── load_hooks_config / save_hooks_config / remove_hooks_config ──────

def test_save_and_load_hooks_config(connector, tmp_path):
    p = tmp_path / "openclaw-hooks.json"
    connector.save_hooks_config(str(p), "http://127.0.0.1:18789", "test-token-hex")

    loaded = connector.load_hooks_config(str(p))
    assert loaded is not None
    assert loaded["base_url"] == "http://127.0.0.1:18789"
    assert loaded["token"] == "test-token-hex"
    assert loaded["version"] == 1
    assert "created_at" in loaded


def test_save_hooks_config_strips_trailing_slash(connector, tmp_path):
    p = tmp_path / "openclaw-hooks.json"
    connector.save_hooks_config(str(p), "http://127.0.0.1:18789/", "tok")
    loaded = connector.load_hooks_config(str(p))
    assert loaded["base_url"] == "http://127.0.0.1:18789"


def test_save_hooks_config_records_openclaw_version(connector, tmp_path):
    p = tmp_path / "openclaw-hooks.json"
    connector.save_hooks_config(str(p), "http://127.0.0.1:18789", "tok", openclaw_version="26.4.1")
    loaded = connector.load_hooks_config(str(p))
    assert loaded["openclaw_version"] == "26.4.1"


def test_load_hooks_config_returns_none_when_missing(connector, tmp_path):
    assert connector.load_hooks_config(str(tmp_path / "nope.json")) is None


def test_load_hooks_config_returns_none_when_corrupt(connector, tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("garbage {{")
    assert connector.load_hooks_config(str(p)) is None


def test_load_hooks_config_returns_none_when_missing_token(connector, tmp_path):
    p = tmp_path / "hooks.json"
    p.write_text('{"version":1,"base_url":"http://127.0.0.1"}')
    assert connector.load_hooks_config(str(p)) is None


def test_load_hooks_config_returns_none_when_missing_base_url(connector, tmp_path):
    p = tmp_path / "hooks.json"
    p.write_text('{"version":1,"token":"t"}')
    assert connector.load_hooks_config(str(p)) is None


def test_save_hooks_config_sets_0600_permissions(connector, tmp_path):
    if os.name == "nt":
        return  # Windows 没有 unix 权限位
    p = tmp_path / "hooks.json"
    connector.save_hooks_config(str(p), "http://127.0.0.1:18789", "tok")
    mode = oct(p.stat().st_mode & 0o777)
    assert mode == "0o600"


def test_remove_hooks_config_when_exists(connector, tmp_path):
    p = tmp_path / "hooks.json"
    p.write_text("{}")
    assert connector.remove_hooks_config(str(p)) is True
    assert not p.exists()


def test_remove_hooks_config_when_missing(connector, tmp_path):
    p = tmp_path / "nope.json"
    assert connector.remove_hooks_config(str(p)) is False


# ── parse_version_major / detect_openclaw_version ────────────────────

def test_parse_version_major_valid(connector):
    assert connector.parse_version_major("26.4.1") == 26


def test_parse_version_major_with_prefix(connector):
    assert connector.parse_version_major("25.0.0") == 25


def test_parse_version_major_returns_none_for_invalid(connector):
    assert connector.parse_version_major("not-a-version") is None
    assert connector.parse_version_major(None) is None
    assert connector.parse_version_major("") is None


# ── HooksTransport endpoint construction ─────────────────────────────

def test_hooks_transport_default_endpoint(connector):
    t = connector.HooksTransport("http://127.0.0.1:18789", "tok")
    assert t.endpoint == "http://127.0.0.1:18789/hooks/agent"


def test_hooks_transport_custom_path(connector):
    t = connector.HooksTransport("http://127.0.0.1:18789", "tok", hooks_path="/api/hooks")
    assert t.endpoint == "http://127.0.0.1:18789/api/hooks/agent"


def test_hooks_transport_path_normalizes_leading_slash(connector):
    t = connector.HooksTransport("http://127.0.0.1:18789", "tok", hooks_path="custom")
    assert t.endpoint == "http://127.0.0.1:18789/custom/agent"


def test_hooks_transport_strips_base_url_trailing_slash(connector):
    t = connector.HooksTransport("http://127.0.0.1:18789/", "tok")
    assert t.endpoint == "http://127.0.0.1:18789/hooks/agent"


# ── CliTransport label lock isolation ────────────────────────────────

def test_cli_transport_per_label_lock_isolation(connector):
    """不同 label 必须各自有独立的锁实例"""
    import asyncio
    transport = connector.CliTransport()

    async def get_two_locks():
        l1 = await transport._get_lock("label-A")
        l2 = await transport._get_lock("label-B")
        l3 = await transport._get_lock("label-A")
        return l1, l2, l3

    l1, l2, l3 = asyncio.run(get_two_locks())
    assert l1 is l3, "同 label 必须返回同一个锁"
    assert l1 is not l2, "不同 label 必须返回不同锁"

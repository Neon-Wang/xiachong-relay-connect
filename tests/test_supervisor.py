"""
TransportSupervisor 单元测试：失败计数 / 降级触发 / 401 立即降级 / 429 不降级。

mock 策略：定义可控的 FakeTransport，按调用次数返回成功或抛指定异常。
"""
import asyncio

import pytest


class FakeTransport:
    """按预设 plan 顺序响应的 transport"""

    def __init__(self, mode: str, plan: list):
        self.mode = mode
        self.plan = list(plan)  # ['ok', AuthError(...), 'ok', ...]
        self.call_count = 0

    def describe(self) -> str:
        return f"fake-{self.mode}"

    async def send(self, message, label, timeout=120):
        self.call_count += 1
        if not self.plan:
            return f"{self.mode}-default-ok"
        item = self.plan.pop(0)
        if isinstance(item, Exception):
            raise item
        return f"{self.mode}-{item}"

    async def health_check(self):
        return True


def test_supervisor_normal_flow_no_downgrade(connector):
    primary = FakeTransport("hooks", ["ok", "ok", "ok"])
    fallback = FakeTransport("cli", ["ok"])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    for _ in range(3):
        result = asyncio.run(sup.send("msg", "label"))
        assert result.startswith("hooks-")
    assert sup.active_mode == "hooks"
    assert primary.call_count == 3
    assert fallback.call_count == 0


def test_supervisor_downgrades_after_threshold(connector):
    primary = FakeTransport("hooks", [
        connector.ServerError("boom1"),
        connector.ServerError("boom2"),
        connector.ServerError("boom3"),
    ])
    fallback = FakeTransport("cli", [])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    # First two failures should bubble up
    for _ in range(2):
        with pytest.raises(connector.ServerError):
            asyncio.run(sup.send("m", "l"))

    # Third failure triggers downgrade and the call uses fallback
    result = asyncio.run(sup.send("m", "l"))
    assert result.startswith("cli-")
    assert sup.active_mode == "cli"

    # Subsequent calls go straight to fallback
    result2 = asyncio.run(sup.send("m", "l"))
    assert result2.startswith("cli-")
    assert primary.call_count == 3  # primary not called after downgrade


def test_supervisor_401_immediate_downgrade(connector):
    """AuthError 不等阈值，立即降级"""
    primary = FakeTransport("hooks", [connector.AuthError("token bad")])
    fallback = FakeTransport("cli", [])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    result = asyncio.run(sup.send("m", "l"))
    assert result.startswith("cli-")
    assert sup.active_mode == "cli"


def test_supervisor_intermittent_failures_dont_downgrade(connector):
    """失败夹杂在成功之间，不应连续达阈值"""
    primary = FakeTransport("hooks", [
        "ok",
        connector.ServerError("boom"),
        "ok",
        connector.ServerError("boom"),
        "ok",
    ])
    fallback = FakeTransport("cli", [])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    asyncio.run(sup.send("m", "l"))
    with pytest.raises(connector.ServerError):
        asyncio.run(sup.send("m", "l"))
    asyncio.run(sup.send("m", "l"))
    with pytest.raises(connector.ServerError):
        asyncio.run(sup.send("m", "l"))
    asyncio.run(sup.send("m", "l"))

    assert sup.active_mode == "hooks"
    assert fallback.call_count == 0


def test_supervisor_no_fallback_propagates_failure(connector):
    primary = FakeTransport("hooks", [
        connector.ServerError("e1"),
        connector.ServerError("e2"),
        connector.ServerError("e3"),
    ])
    sup = connector.TransportSupervisor(primary, fallback=None, fail_threshold=3)

    for _ in range(3):
        with pytest.raises(connector.ServerError):
            asyncio.run(sup.send("m", "l"))


def test_supervisor_429_retries_then_succeeds(connector):
    """限流触发 retry，不计入失败计数"""
    primary = FakeTransport("hooks", [
        connector.RateLimitError(0.01, "limited"),  # 0.01s 退避，测试快
        "ok",
    ])
    fallback = FakeTransport("cli", [])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    result = asyncio.run(sup.send("m", "l"))
    assert result.startswith("hooks-")
    assert sup.active_mode == "hooks"


def test_supervisor_describe_changes_after_downgrade(connector):
    primary = FakeTransport("hooks", [connector.AuthError("bad")])
    fallback = FakeTransport("cli", [])
    sup = connector.TransportSupervisor(primary, fallback, fail_threshold=3)

    desc_before = sup.describe()
    asyncio.run(sup.send("m", "l"))
    desc_after = sup.describe()

    assert "fake-hooks" in desc_before
    assert "downgraded" in desc_after

"""
HooksTransport 单元测试：响应解析 / 错误分类 / health check。

mock 策略：用 monkeypatch 替换 requests.post 为可控的 MockResponse。
"""
import asyncio
from unittest.mock import MagicMock

import pytest


class MockResponse:
    def __init__(self, status_code: int, payload=None, headers=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = text or (str(payload) if payload else "")

    def json(self):
        if self._payload is None:
            raise ValueError("No JSON")
        return self._payload


# ── _extract_text 容错测试 ─────────────────────────────────────────────

def test_extract_text_message_content_string(connector):
    data = {"message": {"content": "hello"}}
    assert connector.HooksTransport._extract_text(data) == "hello"


def test_extract_text_message_content_list(connector):
    data = {"message": {"content": [{"text": "part1 "}, {"text": "part2"}]}}
    assert connector.HooksTransport._extract_text(data) == "part1 part2"


def test_extract_text_message_string_fallback(connector):
    data = {"message": "plain string"}
    assert connector.HooksTransport._extract_text(data) == "plain string"


def test_extract_text_top_level_text_key(connector):
    data = {"text": "fallback text"}
    assert connector.HooksTransport._extract_text(data) == "fallback text"


def test_extract_text_top_level_output_key(connector):
    data = {"output": "fallback output"}
    assert connector.HooksTransport._extract_text(data) == "fallback output"


def test_extract_text_raw_string(connector):
    assert connector.HooksTransport._extract_text("just a string") == "just a string"


def test_extract_text_unknown_format_raises(connector):
    with pytest.raises(connector.ResponseFormatError):
        connector.HooksTransport._extract_text({"unrelated": "field"})


# ── send 错误分类测试 ───────────────────────────────────────────────────

def _make_transport(connector, monkeypatch, response: MockResponse):
    transport = connector.HooksTransport("http://127.0.0.1:18789", "test-token")
    mock_post = MagicMock(return_value=response)
    monkeypatch.setattr(connector.requests, "post", mock_post)
    return transport, mock_post


def test_send_success_extracts_message(connector, monkeypatch):
    transport, _ = _make_transport(
        connector, monkeypatch,
        MockResponse(200, {"message": {"content": "hi from agent"}}),
    )
    result = asyncio.run(transport.send("hello", "test-label"))
    assert result == "hi from agent"


def test_send_401_raises_auth_error(connector, monkeypatch):
    transport, _ = _make_transport(
        connector, monkeypatch,
        MockResponse(401, text="Unauthorized"),
    )
    with pytest.raises(connector.AuthError):
        asyncio.run(transport.send("hello", "test-label"))


def test_send_429_raises_rate_limit_with_retry_after(connector, monkeypatch):
    transport, _ = _make_transport(
        connector, monkeypatch,
        MockResponse(429, text="Too Many", headers={"Retry-After": "10"}),
    )
    with pytest.raises(connector.RateLimitError) as exc_info:
        asyncio.run(transport.send("hello", "test-label"))
    assert exc_info.value.retry_after == 10


def test_send_500_raises_server_error(connector, monkeypatch):
    transport, _ = _make_transport(
        connector, monkeypatch,
        MockResponse(500, text="Internal Error"),
    )
    with pytest.raises(connector.ServerError):
        asyncio.run(transport.send("hello", "test-label"))


def test_send_too_long_message_returns_error_string(connector):
    transport = connector.HooksTransport("http://127.0.0.1:18789", "t")
    huge = "x" * (connector.MAX_MESSAGE_LENGTH + 100)
    result = asyncio.run(transport.send(huge, "test-label"))
    assert "过长" in result


def test_send_payload_includes_evopaimo_session_prefix(connector, monkeypatch):
    """sessionKey 必须加 evopaimo: 前缀避免与其他集成冲突"""
    transport, mock_post = _make_transport(
        connector, monkeypatch,
        MockResponse(200, {"message": {"content": "ok"}}),
    )
    asyncio.run(transport.send("hello", "mobile-app"))
    call_args = mock_post.call_args
    payload = call_args.kwargs["json"]
    assert payload["sessionKey"] == "evopaimo:mobile-app"
    assert payload["name"] == "EvoPaimo"
    assert payload["deliver"] is False


def test_send_uses_x_openclaw_token_header(connector, monkeypatch):
    transport, mock_post = _make_transport(
        connector, monkeypatch,
        MockResponse(200, {"message": {"content": "ok"}}),
    )
    asyncio.run(transport.send("hello", "label"))
    headers = mock_post.call_args.kwargs["headers"]
    assert headers["x-openclaw-token"] == "test-token"


# ── health_check 测试 ─────────────────────────────────────────────────

def test_health_check_passes_when_endpoint_returns_401_then_200(connector, monkeypatch):
    """端点存活的标志：错 token 返回 401，正确 token 返回 200"""
    responses = iter([
        MockResponse(401),  # 错 token
        MockResponse(200),  # 正确 token
    ])
    monkeypatch.setattr(connector.requests, "post", MagicMock(side_effect=lambda *a, **kw: next(responses)))

    transport = connector.HooksTransport("http://127.0.0.1:18789", "real-token")
    assert asyncio.run(transport.health_check()) is True


def test_health_check_fails_when_endpoint_unreachable(connector, monkeypatch):
    def raise_conn_error(*args, **kwargs):
        raise connector.requests.ConnectionError("nope")
    monkeypatch.setattr(connector.requests, "post", MagicMock(side_effect=raise_conn_error))

    transport = connector.HooksTransport("http://127.0.0.1:18789", "any")
    assert asyncio.run(transport.health_check()) is False


def test_health_check_fails_when_token_invalid(connector, monkeypatch):
    """端点存活但 token 错误：错 token 返回 401，正确 token 也返回 401"""
    responses = iter([MockResponse(401), MockResponse(401)])
    monkeypatch.setattr(connector.requests, "post", MagicMock(side_effect=lambda *a, **kw: next(responses)))

    transport = connector.HooksTransport("http://127.0.0.1:18789", "wrong-token")
    assert asyncio.run(transport.health_check()) is False


def test_health_check_fails_when_no_auth_required(connector, monkeypatch):
    """端点未启用鉴权（错 token 返回 200）—— 视为异常状态"""
    monkeypatch.setattr(connector.requests, "post", MagicMock(return_value=MockResponse(200)))

    transport = connector.HooksTransport("http://127.0.0.1:18789", "any")
    assert asyncio.run(transport.health_check()) is False

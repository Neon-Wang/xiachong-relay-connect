import asyncio

import pytest


def test_relay_content_validation_rejects_non_text_and_overlong(connector):
    assert connector.is_valid_relay_content("hello")
    assert connector.is_valid_relay_content("")
    assert connector.is_valid_relay_content("x" * connector.MAX_MESSAGE_LENGTH)
    assert not connector.is_valid_relay_content({"content": "hello"})
    assert not connector.is_valid_relay_content(None)
    assert not connector.is_valid_relay_content("x" * (connector.MAX_MESSAGE_LENGTH + 1))


def test_relay_url_validation_rejects_cleartext_and_non_http_schemes(connector):
    assert connector.validate_relay_url("https://primo.evomap.ai/") == "https://primo.evomap.ai"

    for relay_url in [
        "http://primo.evomap.ai",
        "ws://primo.evomap.ai",
        "file:///tmp/relay",
        "javascript:alert(1)",
        "not a url",
    ]:
        with pytest.raises(ValueError, match="https://"):
            connector.validate_relay_url(relay_url)


def test_init_request_validation_rejects_unsafe_agent_id(connector):
    with pytest.raises(ValueError, match="agent_id"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "../agent\nbad",
            "prompts": [{"step": 1, "prompt": "hello"}],
        })


def test_init_request_validation_rejects_prompt_flood_and_oversized_fields(connector):
    with pytest.raises(ValueError, match="too many prompts"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "agent_safe",
            "prompts": [{"step": i, "prompt": "hello"} for i in range(connector.MAX_INIT_PROMPTS_PER_REQUEST + 1)],
        })

    with pytest.raises(ValueError, match="prompt too long"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "agent_safe",
            "prompts": [{"step": 1, "prompt": "x" * (connector.MAX_INIT_PROMPT_LENGTH + 1)}],
        })

    with pytest.raises(ValueError, match="expect too long"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "agent_safe",
            "prompts": [{"step": 1, "prompt": "hello", "expect": "x" * (connector.MAX_INIT_PROMPT_LENGTH + 1)}],
        })

    with pytest.raises(ValueError, match="expect must be a string"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "agent_safe",
            "prompts": [{"step": 1, "prompt": "hello", "expect": {"shape": "bad"}}],
        })

    with pytest.raises(ValueError, match="step must be a number"):
        connector.validate_init_request_frame({
            "type": "init_request",
            "agent_id": "agent_safe",
            "prompts": [{"step": True, "prompt": "hello"}],
        })


def test_init_request_validation_accepts_valid_frame(connector):
    frame = connector.validate_init_request_frame({
        "type": "init_request",
        "agent_id": "agent_safe-1",
        "prompts": [{"step": 1, "prompt": "hello", "expect": "json"}],
    })

    assert frame["agent_id"] == "agent_safe-1"
    assert frame["prompts"][0]["prompt"] == "hello"


def test_relay_frame_parser_ignores_invalid_and_non_object_json(connector):
    assert connector.parse_relay_frame("not json{") is None
    assert connector.parse_relay_frame("[]") is None
    assert connector.parse_relay_frame("null") is None
    assert connector.parse_relay_frame('{"type":"ping"}') == {"type": "ping"}


def test_cli_transport_rejects_overlong_message_before_openclaw(connector, monkeypatch):
    async def fail_if_called(*args, **kwargs):
        raise AssertionError("OpenClaw subprocess should not be created")

    monkeypatch.setattr(connector.asyncio, "create_subprocess_exec", fail_if_called)

    transport = connector.CliTransport(cli_path="/fake/openclaw")
    result = asyncio.run(
        transport.send("x" * (connector.MAX_MESSAGE_LENGTH + 1), label="same-session"),
    )

    assert result == "[Error] 消息过长"


def test_cli_transport_serializes_calls_for_same_session_label(connector, monkeypatch):
    running = 0
    max_running = 0
    call_order = []

    class FakeProc:
        returncode = 0

        async def communicate(self):
            nonlocal running, max_running
            running += 1
            max_running = max(max_running, running)
            call_order.append("start")
            await asyncio.sleep(0.01)
            call_order.append("end")
            running -= 1
            return b'{"emotion":"neutral","full_text":"ok","tts_text":"ok"}', b""

        def kill(self):
            pass

    async def fake_create_subprocess_exec(*args, **kwargs):
        return FakeProc()

    monkeypatch.setattr(connector.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    async def run_three_calls():
        transport = connector.CliTransport(cli_path="/fake/openclaw")
        return await asyncio.gather(
            transport.send("one", label="same-session"),
            transport.send("two", label="same-session"),
            transport.send("three", label="same-session"),
        )

    results = asyncio.run(run_three_calls())

    assert len(results) == 3
    assert all("full_text" in result for result in results)
    assert max_running == 1
    assert call_order == ["start", "end", "start", "end", "start", "end"]

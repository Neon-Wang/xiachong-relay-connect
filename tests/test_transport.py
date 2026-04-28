import asyncio


def test_relay_content_validation_rejects_non_text_and_overlong(connector):
    assert connector.is_valid_relay_content("hello")
    assert connector.is_valid_relay_content("")
    assert connector.is_valid_relay_content("x" * connector.MAX_MESSAGE_LENGTH)
    assert not connector.is_valid_relay_content({"content": "hello"})
    assert not connector.is_valid_relay_content(None)
    assert not connector.is_valid_relay_content("x" * (connector.MAX_MESSAGE_LENGTH + 1))


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

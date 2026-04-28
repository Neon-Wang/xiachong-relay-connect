"""
回归测试：parse_reply / strip_thinking / _truncate 改造前后行为一致。

这些是 connector 的"输出契约层"——任何破坏都会让客户端收到错乱的 emotion / tts。
"""


def test_strip_thinking_removes_xml_tags(connector):
    raw = "<think>internal monologue</think>actual reply"
    assert connector.strip_thinking(raw) == "actual reply"


def test_strip_thinking_removes_thinking_tag(connector):
    raw = "<thinking>plan steps</thinking>final answer"
    assert connector.strip_thinking(raw) == "final answer"


def test_strip_thinking_handles_markdown_thinking_block(connector):
    raw = "> **Thinking...**\n> still thinking\nactual response"
    cleaned = connector.strip_thinking(raw)
    assert "actual response" in cleaned
    assert "Thinking" not in cleaned


def test_parse_reply_full_json_format(connector):
    raw = '{"emotion":"happy","full_text":"长篇大论","tts_text":"短"}'
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "happy"
    assert full == "长篇大论"
    assert tts == "短"


def test_parse_reply_invalid_emotion_falls_back_neutral(connector):
    raw = '{"emotion":"explosive","full_text":"text","tts_text":"t"}'
    emo, _, _ = connector.parse_reply(raw)
    assert emo == "neutral"


def test_parse_reply_only_full_text_synthesizes_tts(connector):
    raw = '{"emotion":"sad","full_text":"a long sad story"}'
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "sad"
    assert full == "a long sad story"
    assert len(tts) > 0


def test_parse_reply_legacy_text_field(connector):
    raw = '{"emotion":"happy","text":"legacy field reply"}'
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "happy"
    assert full == "legacy field reply"


def test_parse_reply_legacy_paren_format(connector):
    raw = "(happy) hello world"
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "happy"
    assert full == "hello world"


def test_parse_reply_empty_returns_neutral(connector):
    emo, full, _ = connector.parse_reply("")
    assert emo == "neutral"
    assert "Empty" in full


def test_parse_reply_strips_thinking_before_json_extraction(connector):
    raw = '<think>plan</think>{"emotion":"shy","full_text":"yo","tts_text":"yo"}'
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "shy"
    assert full == "yo"


def test_parse_reply_extracts_first_json_when_thinking_after(connector):
    """文本里只有一个 JSON 时正常解析"""
    raw = 'preamble {"emotion":"angry","full_text":"mad","tts_text":"mad"}'
    emo, full, tts = connector.parse_reply(raw)
    assert emo == "angry"
    assert full == "mad"


def test_truncate_short_text_unchanged(connector):
    assert connector._truncate("short") == "short"


def test_truncate_long_text_appends_ellipsis(connector):
    long = "你" * 100
    truncated = connector._truncate(long, limit=50)
    assert truncated.endswith("…")
    assert len(truncated) < 100


def test_wrap_user_message_preserves_literal_braces(connector):
    raw = "请解释 {foo}、单独左括号 { 和右括号 } 的含义"
    wrapped = connector.wrap_user_message(raw)

    assert raw in wrapped
    assert "USER.md里写的用户说：" in wrapped

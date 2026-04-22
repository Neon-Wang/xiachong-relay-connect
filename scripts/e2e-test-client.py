#!/usr/bin/env python3
"""
E2E test client for evopaimo-connect.

Role: simulates the EvoPaimo client (i.e. the Electron app side) so we can
verify the full loop without needing a real user/device:

  this-script  ──(POST /api/register)──▶  Workers            [get link_code+secret+client-token]
  this-script  ──(WS /ws/client)──────▶  Workers  ──────▶  connector  ──▶  OpenClaw CLI
                                        ◀──────────────     (reply)
  this-script  ◀────────────────────     Workers

It prints the link_code/secret and waits until the user starts the connector
(or a supervised subprocess) with those credentials, then sends a test message.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any

import requests
import websockets


DEFAULT_RELAY = "https://primo.evomap.ai"


def register(relay_url: str) -> dict[str, Any]:
    res = requests.post(f"{relay_url}/api/register", timeout=10)
    res.raise_for_status()
    data = res.json()
    if not data.get("ok") and "link_code" not in data:
        raise SystemExit(f"register failed: {data}")
    return data if "link_code" in data else data["data"]


async def send_and_wait(
    relay_url: str,
    client_token: str,
    message: str,
    idle_timeout: float,
) -> tuple[bool, list[dict[str, Any]]]:
    """Connect to /ws/client, send one message, collect replies until idle timeout."""
    ws_url = relay_url.replace("https://", "wss://").replace("http://", "ws://")
    url = f"{ws_url}/ws/client?token={client_token}"

    print(f"[client] connecting {url}", flush=True)
    try:
        async with websockets.connect(url, open_timeout=15, ping_interval=20) as ws:
            print(f"[client] connected", flush=True)

            async def pump_incoming():
                events: list[dict[str, Any]] = []
                reply_seen = False
                last_activity = time.monotonic()
                while time.monotonic() - last_activity < idle_timeout:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed as exc:
                        print(f"[client] ws closed: {exc}", flush=True)
                        break
                    try:
                        payload = json.loads(raw)
                    except Exception:
                        payload = {"raw": raw}
                    events.append(payload)
                    last_activity = time.monotonic()
                    print(f"[client] <-- {payload}", flush=True)
                    ptype = payload.get("type")
                    if ptype == "ping":
                        await ws.send(json.dumps({"type": "pong", "ts": payload.get("ts")}))
                        continue
                    if ptype == "message" and payload.get("from") == "openclaw":
                        reply_seen = True
                        break
                return reply_seen, events

            pump_task = asyncio.create_task(pump_incoming())

            await asyncio.sleep(0.5)
            out = {"type": "message", "content": message, "content_type": "text"}
            print(f"[client] --> {out}", flush=True)
            await ws.send(json.dumps(out))

            reply_seen, events = await pump_task
            return reply_seen, events
    except Exception as exc:
        print(f"[client] ws error: {exc}", flush=True)
        return False, []


def main() -> int:
    ap = argparse.ArgumentParser(description="E2E test client simulator for evopaimo-connect")
    ap.add_argument("--relay", default=DEFAULT_RELAY)
    ap.add_argument("--message", default="ping from e2e-test-client", help="test message to send")
    ap.add_argument("--idle-timeout", type=float, default=60.0, help="seconds without activity before giving up")
    ap.add_argument("--reuse", nargs=3, metavar=("LINK_CODE", "SECRET", "CLIENT_TOKEN"),
                    help="skip /api/register and reuse existing credentials")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("register", help="only register + print credentials, do not send message")
    args = ap.parse_args()

    if args.reuse:
        link_code, secret, client_token = args.reuse
        app_id = "reused"
        print(f"[client] reusing credentials link_code={link_code}", flush=True)
    else:
        reg = register(args.relay)
        link_code = reg["link_code"]
        secret = reg["secret"]
        client_token = reg["token"]
        app_id = reg["app_id"]
        print(f"[client] registered app_id={app_id}", flush=True)
        print(f"[client] link_code={link_code}", flush=True)
        print(f"[client] secret={secret}", flush=True)
        print(f"[client] client_token={client_token}", flush=True)
        print(f"[client] ---", flush=True)
        print(f"[client] START CONNECTOR:", flush=True)
        print(f"[client]   evopaimo-connect --relay {args.relay} --link-code {link_code} --secret {secret}", flush=True)
        print(f"[client] ---", flush=True)

    if args.cmd == "register":
        return 0

    reply_seen, events = asyncio.run(
        send_and_wait(args.relay, client_token, args.message, args.idle_timeout)
    )
    print(f"[client] reply_seen={reply_seen} total_events={len(events)}", flush=True)
    return 0 if reply_seen else 2


if __name__ == "__main__":
    sys.exit(main())

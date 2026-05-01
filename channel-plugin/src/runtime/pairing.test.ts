import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __internal,
  buildDeviceInfo,
  forgetStoredAgentToken,
  pairWithRelay,
  type StoredAgentCredentials,
} from "./pairing.js";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "evopaimo-pair-"));
}

describe("pairWithRelay", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("calls /api/link on first run and persists agent_token", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(
        JSON.stringify({ token: "T1", app_id: "app-x", agent_id: "agent-x" }),
        { status: 200 },
      );
    };

    const res = await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example/",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(res.token).toBe("T1");
    expect(res.via).toBe("link");
    expect(res.agentToken).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://relay.example/api/link");
    expect(calls[0].body).toMatchObject({
      link_code: "CODE",
      secret: "SECRET",
      agent_token: res.agentToken,
    });

    const stored = await __internal.readStoredCredentials(stateDir, "default");
    expect(stored?.agentToken).toBe(res.agentToken);
    expect(stored?.appId).toBe("app-x");
  });

  it("reuses stored agent_token via /api/agent-auth on subsequent runs", async () => {
    const seed: StoredAgentCredentials = {
      agentToken: "a".repeat(64),
      agentId: "agent-seed",
      appId: "app-seed",
      updatedAt: 1,
    };
    await __internal.writeStoredCredentials(stateDir, "default", seed);

    const seen: string[] = [];
    const fakeFetch = async (url: string | URL): Promise<Response> => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ token: "T2", app_id: "app-seed" }),
        { status: 200 },
      );
    };

    const res = await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(res.token).toBe("T2");
    expect(res.via).toBe("agent-auth");
    expect(res.agentToken).toBe(seed.agentToken);
    expect(res.agentId).toBe(seed.agentId);
    expect(seen).toEqual(["https://relay.example/api/agent-auth"]);
  });

  it("falls back to /api/link when /api/agent-auth is rejected", async () => {
    await __internal.writeStoredCredentials(stateDir, "default", {
      agentToken: "b".repeat(64),
      agentId: "stale-agent",
      updatedAt: 1,
    });

    const seen: string[] = [];
    const fakeFetch = async (url: string | URL): Promise<Response> => {
      const s = String(url);
      seen.push(s);
      if (s.endsWith("/api/agent-auth")) {
        return new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({ token: "T3", app_id: "app-new", agent_id: "agent-new" }),
        { status: 200 },
      );
    };

    const res = await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(res.token).toBe("T3");
    expect(res.via).toBe("link");
    expect(res.agentId).toBe("agent-new");
    expect(res.agentToken).not.toBe("b".repeat(64));
    expect(seen).toEqual([
      "https://relay.example/api/agent-auth",
      "https://relay.example/api/link",
    ]);

    const stored = await __internal.readStoredCredentials(stateDir, "default");
    expect(stored?.agentToken).toBe(res.agentToken);
    expect(stored?.agentId).toBe("agent-new");
  });

  it("surfaces an error when /api/link itself fails", async () => {
    const fakeFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "code expired" }), { status: 400 });

    await expect(
      pairWithRelay({
        accountId: "default",
        relayUrl: "https://relay.example",
        linkCode: "CODE",
        secret: "SECRET",
        stateDir,
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/relay \/api\/link failed \(status=400\)/);
  });

  it("clears stored agent_token when relay reports the link is unbound", async () => {
    await __internal.writeStoredCredentials(stateDir, "default", {
      agentToken: "d".repeat(64),
      agentId: "stale-agent",
      updatedAt: 1,
    });
    const fakeFetch = async (url: string | URL): Promise<Response> => {
      if (String(url).endsWith("/api/agent-auth")) {
        return new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "Device unbound" }), { status: 410 });
    };

    await expect(
      pairWithRelay({
        accountId: "default",
        relayUrl: "https://relay.example",
        linkCode: "CODE",
        secret: "SECRET",
        stateDir,
        fetchImpl: fakeFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/relay \/api\/link failed \(status=410\)/);

    expect(await __internal.readStoredCredentials(stateDir, "default")).toBeNull();
  });

  it("forgetStoredAgentToken removes the state file", async () => {
    await __internal.writeStoredCredentials(stateDir, "default", {
      agentToken: "c".repeat(64),
      agentId: "x",
      updatedAt: 1,
    });
    await forgetStoredAgentToken({ accountId: "default", stateDir });
    expect(await __internal.readStoredCredentials(stateDir, "default")).toBeNull();
  });

  it("forwards deviceInfo to both /api/link and /api/agent-auth", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ token: "T1", app_id: "app-x", agent_id: "agent-x" }),
        { status: 200 },
      );
    };

    const deviceInfo = {
      hostname: "macbook-pro-16.local",
      platform: "darwin",
      os_release: "24.3.0",
      arch: "arm64",
      plugin_version: "0.1.2",
    };

    // First run → /api/link
    await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      deviceInfo,
    });

    // Second run → /api/agent-auth (reuses the persisted agent_token)
    await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      deviceInfo,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe("https://relay.example/api/link");
    expect(seen[0].body.openclaw_device_info).toEqual(deviceInfo);
    expect(seen[1].url).toBe("https://relay.example/api/agent-auth");
    expect(seen[1].body.openclaw_device_info).toEqual(deviceInfo);
  });

  it("omits openclaw_device_info when deviceInfo is not provided", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fakeFetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ token: "T1", app_id: "app-x", agent_id: "agent-x" }),
        { status: 200 },
      );
    };

    await pairWithRelay({
      accountId: "default",
      relayUrl: "https://relay.example",
      linkCode: "CODE",
      secret: "SECRET",
      stateDir,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("openclaw_device_info");
  });
});

describe("buildDeviceInfo", () => {
  it("populates hostname/platform/arch and drops unset fields", () => {
    const info = buildDeviceInfo();
    // platform is always present on a live Node runtime.
    expect(info.platform).toEqual(process.platform);
    // arch is typically present; tolerate edge cases where os.arch throws.
    if ("arch" in info) {
      expect(info.arch).toMatch(/^[a-z0-9_-]+$/i);
    }
    // plugin_version not passed → absent
    expect(info).not.toHaveProperty("plugin_version");
  });

  it("includes plugin_version when provided", () => {
    const info = buildDeviceInfo("9.9.9");
    expect(info.plugin_version).toBe("9.9.9");
  });

  it("drops empty string plugin_version", () => {
    const info = buildDeviceInfo("");
    expect(info).not.toHaveProperty("plugin_version");
  });

  it("clamps absurdly long values to 128 chars", () => {
    const huge = "A".repeat(500);
    const info = buildDeviceInfo(huge);
    expect(info.plugin_version?.length).toBe(128);
  });
});

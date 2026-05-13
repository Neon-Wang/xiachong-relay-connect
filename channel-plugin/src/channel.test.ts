import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pinitPlugin, resolveAccount } from "./channel.js";

describe("pinit channel plugin — M1 skeleton", () => {
  const validConfig = {
    channels: {
      pinit: {
        relayUrl: "https://pinit-api-staging.aged-sea-ee35.workers.dev",
        linkCode: "abc123",
        secret: "deadbeefcafebabe",
      },
    },
  } as const;

  it("exposes the expected channel id", () => {
    expect(pinitPlugin.id).toBe("pinit");
  });

  it("resolveAccount returns normalized credentials", () => {
    const account = resolveAccount(validConfig as any, null);
    expect(account.relayUrl).toBe("https://pinit-api-staging.aged-sea-ee35.workers.dev");
    expect(account.linkCode).toBe("abc123");
    expect(account.secret).toBe("deadbeefcafebabe");
    expect(account.sessionLabel).toBe("mobile-app");
    expect(account.emotionWrapperEnabled).toBe(true);
    expect(account.allowFrom).toEqual([]);
  });

  it("resolveAccount throws when relayUrl is missing", () => {
    expect(() =>
      resolveAccount(
        { channels: { pinit: { linkCode: "a", secret: "b" } } } as any,
        null,
      ),
    ).toThrowError(/relayUrl is required/);
  });

  it("resolveAccount throws when credentials are missing", () => {
    expect(() =>
      resolveAccount(
        {
          channels: { pinit: { relayUrl: "https://example.com" } },
        } as any,
        null,
      ),
    ).toThrowError(/linkCode and channels.pinit.secret are required/);
  });

  it("inspectAccount reports configured only when all 3 fields are set", () => {
    const inspect = pinitPlugin.config.inspectAccount!;
    expect((inspect(validConfig as any, null) as any).configured).toBe(true);
    expect(
      (inspect({ channels: { pinit: {} } } as any, null) as any).configured,
    ).toBe(false);
    expect(
      (
        inspect(
          {
            channels: { pinit: { relayUrl: "https://example.com" } },
          } as any,
          null,
        ) as any
      ).configured,
    ).toBe(false);
  });

  it("listAccountIds returns default when no accounts are configured", () => {
    expect(pinitPlugin.config.listAccountIds(validConfig as any)).toEqual([
      "default",
    ]);
  });

  it("security.resolveDmPolicy returns 'open' + allowFrom=['*'] by default (defers to Workers)", () => {
    const account = resolveAccount(validConfig as any, null);
    const policy = pinitPlugin.security!.resolveDmPolicy!({
      cfg: validConfig as any,
      accountId: null,
      account,
    });
    expect(policy?.policy).toBe("open");
    expect(policy?.allowFrom).toEqual(["*"]);
    expect(policy?.allowFromPath).toBe("channels.pinit.allowFrom");
  });

  it("security.resolveDmPolicy preserves user-configured allowFrom when set", () => {
    const cfg = {
      channels: {
        pinit: {
          ...validConfig.channels.pinit,
          allowFrom: ["alice@example.com"],
        },
      },
    };
    const account = resolveAccount(cfg as any, null);
    const policy = pinitPlugin.security!.resolveDmPolicy!({
      cfg: cfg as any,
      accountId: null,
      account,
    });
    expect(policy?.allowFrom).toEqual(["alice@example.com"]);
  });

  it("outbound.deliveryMode is 'direct'", () => {
    expect(pinitPlugin.outbound?.deliveryMode).toBe("direct");
  });

  it("reads plugin version from the package.json next to installed dist", () => {
    const runtimeSource = readFileSync(
      fileURLToPath(new URL("./runtime/account-runtime.ts", import.meta.url)),
      "utf8",
    );
    expect(runtimeSource).toContain('req("../package.json")');
  });
});

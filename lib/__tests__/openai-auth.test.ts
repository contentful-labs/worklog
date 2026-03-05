import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Mock filesystem before importing the module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe("resolveOpenAIAuth", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it("returns env source when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result).toEqual({ apiKey: "sk-test-key", source: "env" });
  });

  it("returns env source with trimmed key", async () => {
    process.env.OPENAI_API_KEY = "  sk-test-key  ";
    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result).toEqual({ apiKey: "sk-test-key", source: "env" });
  });

  it("returns codex-subscription when auth.json has valid token", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        tokens: {
          access_token: "codex-token",
          account_id: "acct-123",
          refresh_token: "refresh-token",
        },
      })
    );

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result).toEqual({
      apiKey: "codex-token",
      source: "codex-subscription",
      accountId: "acct-123",
    });
  });

  it("returns none when auth.json does not exist", async () => {
    mockedExistsSync.mockReturnValue(false);

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result.source).toBe("none");
    expect((result as { reason: string }).reason).toContain("not found");
  });

  it("returns none when auth.json is malformed JSON", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("not json");

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result.source).toBe("none");
    expect((result as { reason: string }).reason).toContain("not valid JSON");
  });

  it("returns none when auth.json has no access_token", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({ tokens: {} }));

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result.source).toBe("none");
    expect((result as { reason: string }).reason).toContain("no tokens.access_token");
  });

  it("returns none when auth.json has unexpected format", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify("just a string"));

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result.source).toBe("none");
  });

  it("env var takes priority over codex auth.json", async () => {
    process.env.OPENAI_API_KEY = "sk-env-key";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ tokens: { access_token: "codex-token" } })
    );

    const { resolveOpenAIAuth } = await import("../openai-auth");
    const result = resolveOpenAIAuth();
    expect(result).toEqual({ apiKey: "sk-env-key", source: "env" });
  });
});

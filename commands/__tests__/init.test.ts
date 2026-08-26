import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as p from "@clack/prompts";

// The init prompts are clack inputs; mock the module so the tests can answer them.
vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  select: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
}));

import { promptAtlassian, promptGitHub } from "../init";

type TextOptions = Parameters<typeof p.text>[0];

const seen: TextOptions[] = [];

/** Answer each prompt by its message text; anything unanswered comes back as an empty input. */
function answer(answers: Record<string, string>): void {
  vi.mocked(p.text).mockImplementation(async (opts) => {
    seen.push(opts);
    return answers[opts.message] ?? "";
  });
}

function optionsFor(message: string): TextOptions {
  const opts = seen.find((o) => o.message === message);
  if (!opts) throw new Error(`prompt not shown: ${message}`);
  return opts;
}

const server = setupServer(
  http.get("https://acme.atlassian.net/rest/api/3/myself", () => HttpResponse.json({ accountId: "acct-1" })),
  http.get("https://existing.atlassian.net/rest/api/3/myself", () => HttpResponse.json({ accountId: "acct-1" })),
  http.get("https://api.github.com/user", () => HttpResponse.json({ login: "testuser" })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  process.env.ATLASSIAN_API_TOKEN = "test-atlassian-token";
  process.env.GITHUB_TOKEN = "test-github-token";
});
beforeEach(() => {
  seen.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  delete process.env.ATLASSIAN_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("promptAtlassian", () => {
  it("saves what the user types, not the placeholder", async () => {
    answer({
      "Atlassian instance URL:": "https://acme.atlassian.net",
      "Your Atlassian email:": "user@example.com",
    });

    const result = await promptAtlassian();

    expect(result).toEqual({ url: "https://acme.atlassian.net", email: "user@example.com" });
    expect(optionsFor("Atlassian instance URL:").placeholder).toBe("https://your-company.atlassian.net");
  });

  it("stores the origin when the user pastes a URL with a path", async () => {
    answer({
      "Atlassian instance URL:": "https://acme.atlassian.net/wiki/spaces/ENG/",
      "Your Atlassian email:": "user@example.com",
    });

    const result = await promptAtlassian();

    expect(result.url).toBe("https://acme.atlassian.net");
  });

  it("rejects http and embedded credentials", async () => {
    answer({ "Atlassian instance URL:": "https://acme.atlassian.net", "Your Atlassian email:": "user@example.com" });
    await promptAtlassian();

    const validate = optionsFor("Atlassian instance URL:").validate;
    expect(validate?.("http://acme.atlassian.net")).toBe("URL must use https (your API token is sent with every request)");
    expect(validate?.("https://user:pass@acme.atlassian.net")).toBe("Remove the username and password from the URL");
  });

  it("rejects an empty URL on a fresh setup so the placeholder cannot be saved", async () => {
    answer({ "Atlassian instance URL:": "https://acme.atlassian.net", "Your Atlassian email:": "user@example.com" });
    await promptAtlassian();

    const validate = optionsFor("Atlassian instance URL:").validate;
    expect(validate?.("")).toBeTruthy();
    expect(validate?.("https://acme.atlassian.net")).toBeUndefined();
  });

  it("keeps the configured URL when the user accepts it with an empty input", async () => {
    answer({ "Your Atlassian email:": "user@example.com" });

    const result = await promptAtlassian({ url: "https://existing.atlassian.net", email: "user@example.com" });

    expect(result.url).toBe("https://existing.atlassian.net");
    expect(optionsFor("Atlassian instance URL:").validate?.("")).toBeUndefined();
  });
});

describe("promptGitHub", () => {
  it("saves the orgs the user types, not the placeholder", async () => {
    answer({ "GitHub orgs to track (comma-separated):": "acme, acme-labs" });

    const orgs = await promptGitHub();

    expect(orgs).toEqual(["acme", "acme-labs"]);
    expect(optionsFor("GitHub orgs to track (comma-separated):").placeholder).toBe("your-org");
  });

  it("rejects empty orgs on a fresh setup so the placeholder cannot be saved", async () => {
    answer({ "GitHub orgs to track (comma-separated):": "acme" });
    await promptGitHub();

    const validate = optionsFor("GitHub orgs to track (comma-separated):").validate;
    expect(validate?.("")).toBe("At least one org required");
    expect(validate?.("acme")).toBeUndefined();
  });

  it("keeps the configured orgs when the user accepts them with an empty input", async () => {
    answer({});

    const orgs = await promptGitHub(["acme", "acme-labs"]);

    expect(orgs).toEqual(["acme", "acme-labs"]);
  });
});

describe("runInit", () => {
  it("writes the Atlassian instance and GitHub orgs the user entered", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "worklog-init-"));
    const configHome = join(tmp, "config");
    const vault = join(tmp, "vault");
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    // init writes vault docs through Bun.write; vitest runs on node, so stand it in.
    vi.stubGlobal("Bun", { write: async (path: string, content: string) => writeFileSync(path, content) });

    try {
      // CONFIG_DIR is read at module load, so re-import both modules under the temp config home.
      vi.resetModules();
      const clack = await import("@clack/prompts");
      const textAnswers = new Map([
        ["Vault path (where to save brag books and docs):", vault],
        ["Full name:", "Test User"],
        ["Atlassian instance URL:", "https://acme.atlassian.net"],
        ["Your Atlassian email:", "user@example.com"],
        ["Model override (leave blank for default):", ""],
        ["GitHub orgs to track (comma-separated):", "acme, acme-labs"],
      ]);
      vi.mocked(clack.text).mockImplementation(async (opts) => textAnswers.get(opts.message) ?? "");
      vi.mocked(clack.select).mockImplementation(async () => "anthropic");

      const { runInit } = await import("../init");
      await runInit();

      const written = JSON.parse(readFileSync(join(configHome, "worklog", "config.json"), "utf8"));
      expect(written.atlassian).toEqual({ url: "https://acme.atlassian.net", email: "user@example.com" });
      expect(written.githubOrgs).toEqual(["acme", "acme-labs"]);
      expect(written.vault).toBe(vault);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      vi.unstubAllGlobals();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

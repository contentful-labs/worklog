import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import * as p from "@clack/prompts";

// The init prompts are clack text inputs; mock the module so the tests can answer them.
vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), message: vi.fn() },
}));

import { promptAtlassian, promptGitHub } from "../init";

type TextOptions = {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string | undefined) => string | undefined;
};

const mockedText = vi.mocked(p.text) as unknown as {
  mockImplementation: (fn: (opts: TextOptions) => Promise<string>) => void;
};

const seen: TextOptions[] = [];

/** Answer each prompt by its message text; anything unanswered comes back as an empty input. */
function answer(answers: Record<string, string>): void {
  mockedText.mockImplementation(async (opts: TextOptions) => {
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

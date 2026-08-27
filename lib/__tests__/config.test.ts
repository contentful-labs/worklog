import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  expandHome,
  contractHome,
  expandConfigPaths,
  contractConfigPaths,
  validateAtlassianUrl,
  canonicalizeAtlassianUrl,
  validateEmail,
  validateISODate,
  parseCommaSeparated,
  parseTicketPrefixes,
  normalizeTicketPrefix,
  parseReviewCycleDates,
} from "../config";

describe("expandHome / contractHome", () => {
  const home = homedir();

  it("expands a leading tilde", () => {
    expect(expandHome("~/Documents/vault")).toBe(join(home, "Documents/vault"));
    expect(expandHome("~")).toBe(home);
  });

  it("expands $HOME and braced HOME", () => {
    expect(expandHome("$HOME/vault")).toBe(join(home, "vault"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax, not a template
    expect(expandHome("${HOME}/vault")).toBe(join(home, "vault"));
  });

  it("leaves other paths alone, including another user's home", () => {
    expect(expandHome("/opt/vault")).toBe("/opt/vault");
    expect(expandHome("relative/vault")).toBe("relative/vault");
    expect(expandHome("~someoneelse/vault")).toBe("~someoneelse/vault");
  });

  it("only touches a leading tilde, not one inside the path", () => {
    // Real case: iCloud vault paths look like ~/Library/Mobile Documents/iCloud~md~obsidian/...
    const icloud = "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/pkm";
    expect(expandHome(icloud)).toBe(join(home, "Library/Mobile Documents/iCloud~md~obsidian/Documents/pkm"));
    expect(contractHome(expandHome(icloud))).toBe(icloud);
  });

  it("contracts a path inside the home directory", () => {
    expect(contractHome(join(home, "Documents/vault"))).toBe("~/Documents/vault");
    expect(contractHome(home)).toBe("~");
  });

  it("leaves paths outside the home directory absolute", () => {
    expect(contractHome("/opt/vault")).toBe("/opt/vault");
    expect(contractHome(`${home}-other/vault`)).toBe(`${home}-other/vault`);
  });

  it("round trips", () => {
    const original = join(home, "Library/Mobile Documents/vault");
    expect(expandHome(contractHome(original))).toBe(original);
  });
});

describe("expandConfigPaths / contractConfigPaths", () => {
  const home = homedir();
  const base = {
    vault: "~/vault",
    career: { careerDocPaths: ["~/docs/framework.md", "/opt/shared/ladder.md"] },
    profile: { fullName: "Test" },
  } as unknown as Parameters<typeof expandConfigPaths>[0];

  it("expands only the path fields", () => {
    const expanded = expandConfigPaths(base);
    expect(expanded.vault).toBe(join(home, "vault"));
    expect(expanded.career.careerDocPaths).toEqual([join(home, "docs/framework.md"), "/opt/shared/ladder.md"]);
    expect(expanded.profile.fullName).toBe("Test");
  });

  it("does not mutate the input", () => {
    expandConfigPaths(base);
    expect(base.vault).toBe("~/vault");
  });

  it("contracting an expanded config restores the stored form", () => {
    expect(contractConfigPaths(expandConfigPaths(base))).toEqual(base);
  });
});

describe("normalizeTicketPrefix", () => {
  it("strips trailing dashes so the value is a valid JQL project key", () => {
    expect(normalizeTicketPrefix("TEAM-")).toBe("TEAM");
    expect(normalizeTicketPrefix("team--")).toBe("TEAM");
    expect(normalizeTicketPrefix(" ops ")).toBe("OPS");
  });

  it("parseTicketPrefixes normalizes every entry and drops empties", () => {
    expect(parseTicketPrefixes("TEAM-, core, -")).toEqual(["TEAM", "CORE"]);
  });
});

describe("validateAtlassianUrl", () => {
  it("accepts valid atlassian.net URL", () => {
    expect(validateAtlassianUrl("https://company.atlassian.net")).toBeNull();
  });

  it("accepts URL with path", () => {
    expect(validateAtlassianUrl("https://company.atlassian.net/wiki")).toBeNull();
  });

  it("rejects non-atlassian.net domain", () => {
    expect(validateAtlassianUrl("https://example.com")).toBe(
      "URL should end with .atlassian.net (e.g. https://company.atlassian.net)"
    );
  });

  it("rejects invalid URL", () => {
    expect(validateAtlassianUrl("not-a-url")).toBe("Invalid URL");
  });

  it("rejects empty string", () => {
    expect(validateAtlassianUrl("")).toBe("Invalid URL");
  });
});

describe("validateAtlassianUrl rejections", () => {
  it("rejects plain http", () => {
    expect(validateAtlassianUrl("http://company.atlassian.net")).toBe(
      "URL must use https (your API token is sent with every request)"
    );
  });

  it("rejects embedded credentials", () => {
    expect(validateAtlassianUrl("https://user:pass@company.atlassian.net")).toBe(
      "Remove the username and password from the URL"
    );
  });
});

describe("canonicalizeAtlassianUrl", () => {
  it("reduces a site URL to its origin", () => {
    expect(canonicalizeAtlassianUrl("https://company.atlassian.net")).toEqual({
      ok: true, url: "https://company.atlassian.net",
    });
  });

  it("drops a trailing slash", () => {
    expect(canonicalizeAtlassianUrl("https://company.atlassian.net/")).toEqual({
      ok: true, url: "https://company.atlassian.net",
    });
  });

  it("drops a path such as /wiki", () => {
    expect(canonicalizeAtlassianUrl("https://company.atlassian.net/wiki")).toEqual({
      ok: true, url: "https://company.atlassian.net",
    });
  });

  it("drops a query string and fragment", () => {
    expect(canonicalizeAtlassianUrl("https://company.atlassian.net/jira/software?tab=1#top")).toEqual({
      ok: true, url: "https://company.atlassian.net",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeAtlassianUrl("  https://company.atlassian.net  ")).toEqual({
      ok: true, url: "https://company.atlassian.net",
    });
  });

  it("rejects plain http", () => {
    expect(canonicalizeAtlassianUrl("http://company.atlassian.net")).toEqual({
      ok: false, error: "URL must use https (your API token is sent with every request)",
    });
  });

  it("rejects embedded credentials", () => {
    expect(canonicalizeAtlassianUrl("https://user:pass@company.atlassian.net")).toEqual({
      ok: false, error: "Remove the username and password from the URL",
    });
  });

  it("rejects a non-atlassian.net host", () => {
    expect(canonicalizeAtlassianUrl("https://example.com")).toEqual({
      ok: false, error: "URL should end with .atlassian.net (e.g. https://company.atlassian.net)",
    });
  });

  it("rejects something that is not a URL", () => {
    expect(canonicalizeAtlassianUrl("company.atlassian.net")).toEqual({ ok: false, error: "Invalid URL" });
  });
});

describe("validateEmail", () => {
  it("accepts valid email", () => {
    expect(validateEmail("user@example.com")).toBeNull();
  });

  it("rejects missing @", () => {
    expect(validateEmail("userexample.com")).toBe("Invalid email address");
  });

  it("rejects empty string", () => {
    expect(validateEmail("")).toBe("Invalid email address");
  });

  it("rejects email with spaces", () => {
    expect(validateEmail("user @example.com")).toBe("Invalid email address");
  });
});

describe("validateISODate", () => {
  it("accepts valid date", () => {
    expect(validateISODate("2026-01-15")).toBeNull();
  });

  it("rejects wrong format", () => {
    expect(validateISODate("01-15-2026")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects invalid date values", () => {
    expect(validateISODate("2026-13-45")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects empty string", () => {
    expect(validateISODate("")).toBe("Must be YYYY-MM-DD format");
  });

  it("rejects partial date", () => {
    expect(validateISODate("2026-01")).toBe("Must be YYYY-MM-DD format");
  });
});

describe("parseCommaSeparated", () => {
  it("parses normal comma-separated values", () => {
    expect(parseCommaSeparated("a, b, c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace", () => {
    expect(parseCommaSeparated("  a ,  b  , c  ")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCommaSeparated("")).toEqual([]);
  });

  it("handles trailing comma", () => {
    expect(parseCommaSeparated("a, b,")).toEqual(["a", "b"]);
  });

  it("handles single value", () => {
    expect(parseCommaSeparated("single")).toEqual(["single"]);
  });
});

describe("parseReviewCycleDates", () => {
  it("parses valid entries", () => {
    const result = parseReviewCycleDates("Self-review: 2026-06-01, Manager review: 2026-07-01");
    expect(result).toEqual([
      { type: "Self-review", date: "2026-06-01" },
      { type: "Manager review", date: "2026-07-01" },
    ]);
  });

  it("skips entries missing colon", () => {
    const result = parseReviewCycleDates("Self-review 2026-06-01");
    expect(result).toEqual([]);
  });

  it("skips entries with bad dates", () => {
    const result = parseReviewCycleDates("Review: not-a-date");
    expect(result).toEqual([]);
  });

  it("handles mixed valid and invalid entries", () => {
    const result = parseReviewCycleDates("Good: 2026-06-01, bad entry, Also good: 2026-07-01");
    expect(result).toEqual([
      { type: "Good", date: "2026-06-01" },
      { type: "Also good", date: "2026-07-01" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseReviewCycleDates("")).toEqual([]);
  });
});

describe("readConfig / requireConfig", () => {
  /**
   * CONFIG_DIR is computed at module load from XDG_CONFIG_HOME, so the env var has to be
   * set before the import. Returns the temp home plus a teardown.
   */
  function withConfigHome(contents?: string) {
    const tmp = mkdtempSync(join(tmpdir(), "worklog-config-"));
    const configHome = join(tmp, "config");
    mkdirSync(join(configHome, "worklog"), { recursive: true });
    if (contents !== undefined) {
      writeFileSync(join(configHome, "worklog", "config.json"), contents);
    }

    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;

    return {
      configHome,
      cleanup: () => {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous;
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  async function loadUnder(contents?: string) {
    const harness = withConfigHome(contents);
    vi.resetModules();
    const config = await import("../config");
    return { ...harness, config };
  }

  const VALID = JSON.stringify({
    version: 1,
    vault: "/tmp/vault",
    atlassian: { url: "https://acme.atlassian.net", email: "user@example.com" },
    githubOrgs: [],
    ai: { provider: "openai" },
    profile: {
      fullName: "Test User", displayName: "Test", jobTitle: "Engineer", level: "IC-5",
      company: "Acme", location: "Remote", startDate: "2024-01-01", domain: "Platform",
      team: "Search", teamDomain: "Search", ticketPrefixes: ["TEAM"],
    },
    career: {
      framework: "example", currentLevel: "IC-5", targetLevel: "IC-6",
      companyValues: [], reviewCycleDates: [], skills: [], growthAreas: [], careerDocPaths: [],
    },
    coaching: { tone: "direct", focusAreas: [] },
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reads a config that is there", async () => {
    const { config, cleanup } = await loadUnder(VALID);
    try {
      const result = config.readConfig();
      expect(result.status).toBe("ok");
      expect(config.loadConfig()?.vault).toBe("/tmp/vault");
    } finally {
      cleanup();
    }
  });

  it("reports an absent config as missing", async () => {
    const { config, cleanup } = await loadUnder();
    try {
      expect(config.readConfig()).toEqual({ status: "missing" });
      expect(config.loadConfig()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("reports a malformed config as unreadable, with the parse error", async () => {
    // The distinction is the point: this used to look identical to "missing".
    const { config, cleanup } = await loadUnder('{ "vault": "/tmp/vault", }');
    try {
      const result = config.readConfig();
      expect(result.status).toBe("unreadable");
      expect(result.status === "unreadable" && result.error).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it("still flattens both failures for loadConfig, so init can offer a fresh start", async () => {
    // worklog init calls loadConfig to prefill, and a broken config is exactly when init
    // is most needed. Throwing here would make the fix unreachable.
    const { config, cleanup } = await loadUnder("not json at all");
    try {
      expect(() => config.loadConfig()).not.toThrow();
      expect(config.loadConfig()).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("sends a user with no config to init", async () => {
    const { config, cleanup } = await loadUnder();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));

    try {
      expect(() => config.requireConfig()).toThrow();
      expect(errors.join("\n")).toContain("Run `worklog init`");
    } finally {
      cleanup();
    }
  });

  it("does not send a user with a broken config to init, and names the file", async () => {
    // Re-running init over a config with one stray comma is how the settings get lost.
    const { config, cleanup } = await loadUnder('{ "vault": "/tmp/vault", }');
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));

    try {
      expect(() => config.requireConfig()).toThrow();
      const reported = errors.join("\n");
      expect(reported).toContain("config.json at");
      expect(reported).toContain("could not be parsed");
      expect(reported).not.toContain("worklog init");
      expect(reported).not.toContain("No worklog configuration found");
    } finally {
      cleanup();
    }
  });

  it("exits non-zero either way", async () => {
    for (const contents of [undefined, "{ broken"]) {
      const { config, cleanup } = await loadUnder(contents);
      vi.spyOn(console, "error").mockImplementation(() => {});
      // SAFETY: process.exit is typed as returning never, so a stand-in has to be one
      // too. Throwing is how a test observes the call without ending the run.
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exited");
      }) as never);

      try {
        expect(() => config.requireConfig()).toThrow("exited");
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        vi.restoreAllMocks();
        cleanup();
      }
    }
  });
});

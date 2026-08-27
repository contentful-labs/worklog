/**
 * A temp home for the test run.
 *
 * The CLI resolves its config and cache from `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and,
 * failing those, `homedir()`. A test that sets none of them therefore reads and writes the
 * developer's own `~/.config/worklog` and `~/.cache/worklog`. That has happened three
 * times now, so the defaults are set here rather than remembered in each test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Captured before anything below moves HOME, so the guard knows what it is protecting. */
const REAL_HOME = homedir();

/** The directories a run must never touch. */
const PROTECTED = [join(REAL_HOME, ".config", "worklog"), join(REAL_HOME, ".cache", "worklog")];

let root: string | undefined;

/** This run's temp home, created on first use. */
export function testHomeRoot(): string {
  if (!root) root = mkdtempSync(join(tmpdir(), "worklog-test-home-"));
  return root;
}

function isInside(parent: string, path: string): boolean {
  const from = resolve(parent);
  const to = resolve(path);
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep);
}

/**
 * Point the config and cache lookups at the temp home.
 *
 * Defaults only: a test that sets its own value afterwards, as several do around
 * `vi.resetModules()`, still wins. HOME moves too, so code that reaches for `homedir()`
 * without consulting XDG lands in the temp tree as well.
 */
export function installTestHome(): string {
  const home = testHomeRoot();
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  return home;
}

/** Remove the temp home. Safe to call more than once. */
export function removeTestHome(): void {
  if (!root) return;
  rmSync(root, { recursive: true, force: true });
  root = undefined;
}

/**
 * Fail if `path` would land in the developer's real worklog config or cache.
 *
 * Exported so a test that computes a path itself can say so out loud rather than
 * discovering it later in a diff of someone's actual vault.
 */
export function assertOutsideRealHome(path: string, what = "path"): void {
  for (const guarded of PROTECTED) {
    if (isInside(guarded, path)) {
      throw new Error(
        `${what} resolved to ${path}, inside the real ${guarded}. ` +
        `Set XDG_CONFIG_HOME / XDG_CACHE_HOME to a temp directory in this test.`,
      );
    }
  }
}

/** Fail if `path` is not inside this run's temp home. */
export function assertInsideTestHome(path: string, what = "path"): void {
  const home = testHomeRoot();
  if (!isInside(home, path)) {
    throw new Error(`${what} resolved to ${path}, which is outside the test home ${home}.`);
  }
}

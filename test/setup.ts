/**
 * Runs before the modules of every test file.
 *
 * Its whole job is that a test which forgets to redirect the config and cache directories
 * writes into a temp tree instead of the developer's own. `lib/config.ts` reads
 * XDG_CONFIG_HOME at module load, so this has to happen before any import of it, which is
 * what `setupFiles` guarantees and a `beforeAll` would not.
 */

import { afterAll } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertInsideTestHome, installTestHome, removeTestHome } from "./home";

installTestHome();

// The same expressions lib/config.ts and the ledger use, checked rather than assumed:
// a typo in a variable name here would silently leave the real directories exposed.
assertInsideTestHome(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "worklog"), "config dir");
assertInsideTestHome(join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "worklog"), "cache dir");
assertInsideTestHome(homedir(), "home dir");

afterAll(() => {
  // Only the file that created the root removes it; the rest find it already gone.
  removeTestHome();
});

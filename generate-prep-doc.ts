#!/usr/bin/env bun

import { runPrep } from "./commands/prep";

runPrep().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

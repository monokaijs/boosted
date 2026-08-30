#!/usr/bin/env node

import { run } from "../npm/launcher.mjs";

run().catch((error) => {
  console.error(`boosted-cli: ${error.message}`);
  process.exitCode = 1;
});

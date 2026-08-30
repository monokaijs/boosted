import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { cacheRoot, releaseAsset, version } from "../npm/launcher.mjs";

test("maps supported npm platforms to versioned release assets", () => {
  assert.equal(releaseAsset("linux", "x64"), `boosted-${version}-linux-x86_64`);
  assert.equal(releaseAsset("darwin", "arm64"), `boosted-${version}-darwin-aarch64`);
  assert.equal(releaseAsset("darwin", "x64"), `boosted-${version}-darwin-x86_64`);
  assert.equal(releaseAsset("win32", "x64"), `boosted-${version}-windows-x86_64.exe`);
});

test("rejects unsupported npm platforms clearly", () => {
  assert.throws(() => releaseAsset("linux", "arm64"), /unsupported platform linux\/arm64/);
});

test("honors an explicit binary cache without treating it as app data", () => {
  assert.equal(
    cacheRoot("linux", { BOOSTED_CLI_CACHE_DIR: join("tmp", "boosted-cache") }),
    join("tmp", "boosted-cache"),
  );
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activeReleaseVersion,
  cacheRoot,
  compareVersions,
  managedEnvironment,
  releaseAsset,
  resolveBinary,
  spawnOptions,
  updateRestartExitCode,
  version,
} from "../npm/launcher.mjs";

test("maps supported npm platforms to versioned release assets", () => {
  assert.equal(releaseAsset("linux", "x64"), `boosted-${version}-linux-x86_64`);
  assert.equal(releaseAsset("darwin", "arm64"), `boosted-${version}-darwin-aarch64`);
  assert.equal(releaseAsset("darwin", "x64"), `boosted-${version}-darwin-x86_64`);
  assert.equal(releaseAsset("win32", "x64"), `boosted-${version}-windows-x86_64.exe`);
});

test("rejects unsupported npm platforms clearly", () => {
  assert.throws(() => releaseAsset("linux", "arm64"), /unsupported platform linux\/arm64/);
});

test("maps assets for a newer server release", () => {
  assert.equal(releaseAsset("linux", "x64", "9.8.7"), "boosted-9.8.7-linux-x86_64");
});

test("compares stable versions for managed update selection", () => {
  assert.ok(compareVersions("1.2.4", "1.2.3") > 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.ok(compareVersions("1.2.3", "1.2.3-beta.1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("honors an explicit binary cache without treating it as app data", () => {
  assert.equal(
    cacheRoot("linux", { BOOSTED_CLI_CACHE_DIR: join("tmp", "boosted-cache") }),
    join("tmp", "boosted-cache"),
  );
});

test("hides the native subprocess console window", () => {
  const env = { BOOSTED_TEST: "1" };
  assert.deepEqual(spawnOptions(env), {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
});

test("marks launched servers as managed with an absolute cache and restart code", () => {
  const env = managedEnvironment("linux", { BOOSTED_CLI_CACHE_DIR: join("tmp", "boosted-cache") });
  assert.equal(env.BOOSTED_MANAGED_INSTALL, "1");
  assert.equal(env.BOOSTED_UPDATE_EXIT_CODE, String(updateRestartExitCode));
  assert.ok(env.BOOSTED_CLI_CACHE_DIR_RESOLVED.startsWith("/"));
});

test("selects a verified newer binary staged by the web updater", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boosted-cli-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const nextVersion = "99.0.0";
  const binary = join(root, nextVersion, "boosted-cli");
  await mkdir(join(root, nextVersion), { recursive: true });
  await writeFile(binary, "test", { mode: 0o755 });
  await writeFile(join(root, "active.json"), JSON.stringify({ version: nextVersion }));

  assert.equal(await activeReleaseVersion(root), nextVersion);
  assert.equal(
    await resolveBinary({ platform: "linux", arch: "x64", env: { BOOSTED_CLI_CACHE_DIR: root } }),
    binary,
  );
});

test("ignores stale and malformed active release pointers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boosted-cli-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "active.json"), JSON.stringify({ version: "0.0.1" }));
  assert.equal(await activeReleaseVersion(root), version);
  await writeFile(join(root, "active.json"), "not json");
  assert.equal(await activeReleaseVersion(root), version);
});

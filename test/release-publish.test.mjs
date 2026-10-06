import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { expectedArtifacts, publishRelease } from "../.github/scripts/publish-release.mjs";

const fixtures = {
  "release-Linux": ["Boosted_1.2.3_amd64.AppImage", "Boosted_1.2.3_amd64.deb"],
  "release-Windows": ["Boosted_1.2.3_x64-setup.exe", "Boosted_1.2.3_x64_en-US.msi"],
  "release-macOS": ["Boosted.app.tar.gz", "Boosted_1.2.3_universal.dmg"],
  "release-headless-linux-x86_64": ["boosted-1.2.3-linux-x86_64"],
  "release-headless-windows-x86_64.exe": ["boosted-1.2.3-windows-x86_64.exe"],
  "release-headless-darwin-aarch64": ["boosted-1.2.3-darwin-aarch64"],
  "release-headless-darwin-x86_64": ["boosted-1.2.3-darwin-x86_64"],
};

async function harness(context, available) {
  const directory = await mkdtemp(join(tmpdir(), "boosted-release-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const state = { available, finished: false, published: false, edits: 0, uploads: [], assets: new Map() };
  const gh = (args) => {
    if (args[0] === "api") {
      if (args[1].endsWith("/artifacts")) {
        return JSON.stringify([{ artifacts: state.available.map((name) => ({ name, expired: false })) }]);
      }
      if (args[1].endsWith("/jobs?filter=all")) {
        return JSON.stringify([{ jobs: Array.from({ length: 9 }, (_, i) => ({
          name: `Build platform ${i}`,
          status: state.finished ? "completed" : "in_progress",
        })) }]);
      }
    }
    if (args[0] === "run" && args[1] === "download") {
      const name = args[args.indexOf("--name") + 1];
      const path = args[args.indexOf("--dir") + 1];
      mkdirSync(path, { recursive: true });
      for (const filename of fixtures[name]) {
        writeFileSync(join(path, filename), `binary contents: ${filename}`);
        if (name.startsWith("release-") && !name.startsWith("release-headless-") && !filename.endsWith(".dmg")) {
          writeFileSync(join(path, `${filename}.sig`), `signature: ${filename}`);
        }
      }
      return "";
    }
    if (args[0] === "release") {
      if (args[1] === "view") return JSON.stringify({ isDraft: !state.published });
      if (args[1] === "upload") {
        const paths = args.slice(3, args.indexOf("--repo"));
        for (const path of paths) {
          const filename = path.split(/[\\/]/).at(-1);
          state.assets.set(filename, readFileSync(path));
          state.uploads.push(filename);
        }
        return "";
      }
      if (args[1] === "edit") {
        assert.ok(state.assets.has("SHA256SUMS.txt"));
        assert.ok(args.includes("--draft=false"));
        assert.ok(args.includes("--latest"));
        state.published = true;
        state.edits += 1;
        return "";
      }
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const options = { repository: "owner/repo", runId: 123, tag: "v1.2.3", version: "1.2.3", directory, gh, log() {} };
  return { state, options, directory };
}

function assertChecksums(state) {
  const entries = state.assets.get("SHA256SUMS.txt").toString().trim().split("\n");
  assert.equal(entries.length, state.assets.size - 1);
  for (const entry of entries) {
    const [hash, filename] = entry.split("  ");
    assert.equal(hash, createHash("sha256").update(state.assets.get(filename)).digest("hex"));
  }
}

test("publishes Windows before other builds finish and preserves it in the final manifest", async (context) => {
  const { state, options } = await harness(context, ["release-Windows"]);
  let waits = 0;
  await publishRelease({ ...options, wait: async (interval) => {
    assert.equal(interval, 10_000);
    waits += 1;
    assert.equal(state.published, true);
    const manifest = JSON.parse(state.assets.get("latest.json"));
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ["windows-x86_64", "windows-x86_64-msi", "windows-x86_64-nsis"]);
    assert.match(manifest.platforms["windows-x86_64"].url, /v1\.2\.3\/Boosted_1\.2\.3_x64-setup\.exe$/);
    assertChecksums(state);
    state.available = expectedArtifacts;
    state.finished = true;
  } });
  assert.equal(waits, 1);
  assert.equal(state.edits, 1);
  const manifest = JSON.parse(state.assets.get("latest.json"));
  assert.equal(Object.keys(manifest.platforms).length, 11);
  assert.ok(manifest.platforms["windows-x86_64"]);
  assert.deepEqual(manifest.platforms["darwin-aarch64"], manifest.platforms["darwin-x86_64"]);
  assert.equal(state.uploads.filter((name) => name === "Boosted_1.2.3_x64-setup.exe").length, 1);
  assertChecksums(state);
});

test("publishes a ready headless binary with its checksum before desktop installers", async (context) => {
  const { state, options } = await harness(context, ["release-headless-linux-x86_64"]);
  await publishRelease({ ...options, wait: async () => {
    assert.equal(state.published, true);
    assert.ok(state.assets.has("boosted-1.2.3-linux-x86_64"));
    assert.equal(state.assets.has("latest.json"), false);
    assertChecksums(state);
    state.available = expectedArtifacts;
    state.finished = true;
  } });
  assertChecksums(state);
});

test("a failed platform leaves ready Windows assets published and reports missing builds", async (context) => {
  const { state, options } = await harness(context, ["release-Windows"]);
  state.finished = true;
  await assert.rejects(publishRelease(options), /Builds finished without these artifacts:.*release-macOS/);
  assert.equal(state.published, true);
  assert.ok(JSON.parse(state.assets.get("latest.json")).platforms["windows-x86_64"]);
  assertChecksums(state);
});

test("an artifact uploaded between artifact discovery and job completion is still published", async (context) => {
  const { state, options } = await harness(context, []);
  state.finished = true;
  const gh = (args) => {
    const result = options.gh(args);
    if (args[0] === "api" && args[1].endsWith("/jobs?filter=all")) state.available = expectedArtifacts;
    return result;
  };
  await publishRelease({ ...options, gh, wait: async () => assert.fail("Should repoll immediately") });
  assert.equal(state.published, true);
  assertChecksums(state);
});

test("an incomplete installer group fails before exposing updater metadata", async (context) => {
  const { state, options } = await harness(context, ["release-Windows"]);
  const gh = (args) => {
    const result = options.gh(args);
    if (args[0] === "run" && args[1] === "download") {
      const path = args[args.indexOf("--dir") + 1];
      // Simulate an installer artifact missing its MSI signature.
      unlinkSync(join(path, "Boosted_1.2.3_x64_en-US.msi.sig"));
    }
    return result;
  };
  await assert.rejects(publishRelease({ ...options, gh }), /Command failed/);
  assert.equal(state.published, false);
  assert.equal(state.assets.size, 0);
});

test("strict manifest generation still rejects missing platforms", async (context) => {
  const { options, directory } = await harness(context, ["release-Windows"]);
  options.gh(["run", "download", "123", "--name", "release-Windows", "--dir", directory]);
  const generator = fileURLToPath(new URL("../.github/scripts/generate-update-manifest.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [generator, directory, "1.2.3", "v1.2.3", "owner/repo", join(directory, "latest.json")], { stdio: "pipe" }), /Command failed/);
});

test("rerunning the publisher reconstructs a complete release from existing artifacts", async (context) => {
  const { state, options } = await harness(context, expectedArtifacts);
  state.published = true;
  state.finished = true;
  await publishRelease({ ...options, wait: async () => assert.fail("All artifacts are ready") });
  assert.equal(state.edits, 0);
  assert.equal(Object.keys(JSON.parse(state.assets.get("latest.json")).platforms).length, 11);
  assertChecksums(state);
});

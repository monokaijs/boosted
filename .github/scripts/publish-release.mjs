#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { describeJob } from "./wait-for-macos-binaries.mjs";

export const expectedArtifacts = [
  "release-Linux",
  "release-Windows",
  "release-macOS",
  "release-headless-linux-x86_64",
  "release-headless-windows-x86_64.exe",
  "release-headless-darwin-aarch64",
  "release-headless-darwin-x86_64",
];

function runGh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

async function filesWithin(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesWithin(path) : [path];
  }));
  return nested.flat();
}

async function checksum(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// One publisher owns the shared manifest and checksum assets. Platform jobs
// upload immutable workflow artifacts, so simultaneous completions cannot
// overwrite each other's updater entries.
export async function publishRelease({
  repository,
  runId,
  tag,
  version,
  expectedBuildJobs = 9,
  directory = "release-artifacts",
  gh = runGh,
  wait = sleep,
  log = console.log,
  now = Date.now,
  pollInterval = 10_000,
  timeout = 80 * 60_000,
}) {
  if (!repository || !runId || !tag || !version || !Number.isInteger(expectedBuildJobs) || expectedBuildJobs < 1) {
    throw new Error("Repository, run ID, tag, version, and a positive build job count are required");
  }

  directory = resolve(directory);
  const downloads = join(directory, "downloads");
  await mkdir(downloads, { recursive: true });
  const uploaded = new Set();
  const assets = new Map();
  const deadline = now() + timeout;
  let nextLog = 0;
  let published = !JSON.parse(gh(["release", "view", tag, "--repo", repository, "--json", "isDraft"])).isDraft;

  function apiPages(endpoint, property) {
    return JSON.parse(gh(["api", endpoint, "--paginate", "--slurp"]))
      .flatMap((page) => page[property]);
  }

  while (now() < deadline) {
    const available = new Set(apiPages(`repos/${repository}/actions/runs/${runId}/artifacts`, "artifacts")
      .filter((artifact) => !artifact.expired)
      .map((artifact) => artifact.name));
    const ready = expectedArtifacts.filter((name) => available.has(name) && !uploaded.has(name));

    if (ready.length) {
      const newAssets = [];
      for (const name of ready) {
        const artifactDirectory = join(downloads, name);
        gh(["run", "download", String(runId), "--repo", repository, "--name", name, "--dir", artifactDirectory]);
        const files = await filesWithin(artifactDirectory);
        if (!files.length) throw new Error(`Artifact ${name} is empty`);
        for (const path of files) {
          const filename = basename(path);
          if (assets.has(filename)) throw new Error(`Duplicate release asset: ${filename}`);
          assets.set(filename, path);
          newAssets.push(path);
        }
        uploaded.add(name);
      }

      const manifestPath = join(directory, "latest.json");
      const hasDesktop = ["release-Linux", "release-Windows", "release-macOS"].some((name) => uploaded.has(name));
      if (hasDesktop) {
        const generator = fileURLToPath(new URL("./generate-update-manifest.mjs", import.meta.url));
        execFileSync(process.execPath, [generator, downloads, version, tag, repository, manifestPath, "--partial"], {
          stdio: "pipe",
        });
        assets.set("latest.json", manifestPath);
      }

      const checksumPath = join(directory, "SHA256SUMS.txt");
      const checksums = [];
      for (const [filename, path] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
        checksums.push(`${await checksum(path)}  ${filename}`);
      }
      await writeFile(checksumPath, `${checksums.join("\n")}\n`);

      // Assets must exist before checksums or updater entries advertise them.
      gh(["release", "upload", tag, ...newAssets, "--repo", repository, "--clobber"]);
      gh(["release", "upload", tag, checksumPath, "--repo", repository, "--clobber"]);
      if (hasDesktop) gh(["release", "upload", tag, manifestPath, "--repo", repository, "--clobber"]);
      if (!published) {
        gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
        published = true;
      }
      log(`Published: ${ready.join(", ")} (${uploaded.size}/${expectedArtifacts.length} artifacts)`);
    }

    if (uploaded.size === expectedArtifacts.length) return;

    // Include previous attempts when only failed jobs are rerun: successful
    // platform jobs may not be present in the latest attempt's job list.
    const jobs = apiPages(`repos/${repository}/actions/runs/${runId}/jobs?filter=all`, "jobs")
      .filter((job) => /^(Build |Compile macOS |Sign and package macOS universal$)/.test(job.name));
    if (jobs.length >= expectedBuildJobs && jobs.every((job) => job.status === "completed")) {
      // A just-finished upload may not appear in the preceding API response.
      // Poll once more before treating missing artifacts as a failed build.
      const finalArtifacts = new Set(apiPages(`repos/${repository}/actions/runs/${runId}/artifacts`, "artifacts")
        .filter((artifact) => !artifact.expired)
        .map((artifact) => artifact.name));
      if (expectedArtifacts.some((name) => finalArtifacts.has(name) && !uploaded.has(name))) continue;
      const missing = expectedArtifacts.filter((name) => !uploaded.has(name));
      throw new Error(`Builds finished without these artifacts: ${missing.join(", ")}. Available platforms remain published.`);
    }
    if (now() >= nextLog) {
      const missing = expectedArtifacts.filter((name) => !uploaded.has(name));
      const active = jobs.filter((job) => job.status !== "completed");
      log(`Waiting for: ${missing.join(", ")} (${uploaded.size}/${expectedArtifacts.length} published). ${active.map((job) => `${job.name} [${describeJob(job)}]`).join("; ")}`);
      nextLog = now() + 60_000;
    }
    await wait(Math.max(0, Math.min(pollInterval, deadline - now())));
  }
  throw new Error(`Timed out waiting for release artifacts: ${expectedArtifacts.filter((name) => !uploaded.has(name)).join(", ")}. Available platforms remain published.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishRelease({
    repository: process.env.REPOSITORY,
    runId: process.env.RUN_ID,
    tag: process.env.TAG,
    version: process.env.VERSION,
    expectedBuildJobs: Number(process.env.EXPECTED_BUILD_JOBS ?? 9),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

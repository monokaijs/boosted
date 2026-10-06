#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const binaryArtifacts = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
  .map((target) => ({ name: `macos-binary-${target}`, job: `Compile macOS ${target}` }));

export function describeJob(job) {
  if (!job) return "not scheduled yet";
  const step = job.steps?.find((step) => step.status === "in_progress");
  return `${job.status}${job.conclusion ? ` (${job.conclusion})` : ""}${step ? `: ${step.name}` : ""}`;
}

// Artifacts become downloadable before the producer's post-job cleanup finishes.
// Do not make packaging depend on the producer job's final status.
export async function waitForMacosBinaries({
  repository,
  runId,
  gh = (args) => execFileSync("gh", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 60_000,
  }),
  wait = sleep,
  log = console.log,
  now = Date.now,
  pollInterval = 10_000,
  timeout = 30 * 60_000,
}) {
  if (!repository || !runId) throw new Error("Repository and run ID are required");
  const deadline = now() + timeout;
  let nextLog = 0;
  let missing = binaryArtifacts;
  const pages = (endpoint, property) => JSON.parse(gh(["api", endpoint, "--paginate", "--slurp"]))
    .flatMap((page) => page[property]);

  while (now() < deadline) {
    const available = new Set(pages(`repos/${repository}/actions/runs/${runId}/artifacts`, "artifacts")
      .filter((artifact) => !artifact.expired).map((artifact) => artifact.name));
    missing = binaryArtifacts.filter((artifact) => !available.has(artifact.name));
    if (!missing.length) {
      log("Both macOS binaries are uploaded; packaging can start immediately.");
      return;
    }
    // On a rerun, consider the latest attempt of each producer rather than
    // treating an earlier failed attempt as a failure of the current build.
    const jobs = new Map(pages(`repos/${repository}/actions/runs/${runId}/jobs?filter=all`, "jobs")
      .sort((a, b) => a.id - b.id).map((job) => [job.name, job]));
    const failed = missing.find((artifact) => {
      const job = jobs.get(artifact.job);
      return job?.status === "completed" && ["failure", "cancelled", "timed_out", "skipped", "action_required", "startup_failure"].includes(job.conclusion);
    });
    if (failed) throw new Error(`${failed.job} ${describeJob(jobs.get(failed.job))}; missing ${failed.name}`);
    if (now() >= nextLog) {
      log(`Waiting for macOS binaries: ${missing.map((artifact) => `${artifact.name} [${describeJob(jobs.get(artifact.job))}]`).join(", ")}`);
      nextLog = now() + 60_000;
    }
    await wait(Math.max(0, Math.min(pollInterval, deadline - now())));
  }
  throw new Error(`Timed out waiting for macOS binaries: ${missing.map((artifact) => artifact.name).join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  waitForMacosBinaries({ repository: process.env.REPOSITORY, runId: process.env.RUN_ID }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

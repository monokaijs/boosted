import assert from "node:assert/strict";
import test from "node:test";
import { binaryArtifacts, waitForMacosBinaries } from "../.github/scripts/wait-for-macos-binaries.mjs";

function harness() {
  const state = { artifacts: [], jobs: [], logs: [], time: 0, waits: 0 };
  const options = {
    repository: "owner/repo", runId: 123,
    gh(args) {
      assert.ok(args.includes("--paginate"));
      assert.ok(args.includes("--slurp"));
      if (args[1].endsWith("/artifacts")) return JSON.stringify([{ artifacts: state.artifacts }]);
      if (args[1].endsWith("/jobs?filter=all")) return JSON.stringify([{ jobs: state.jobs }]);
      assert.fail(`Unexpected command: ${args}`);
    },
    now: () => state.time,
    log: (message) => state.logs.push(message),
    wait: async (duration) => { state.time += duration; state.waits++; },
  };
  return { state, options };
}

const uploaded = () => binaryArtifacts.map(({ name }) => ({ name, expired: false }));

test("packaging proceeds while a compiler is stuck in Complete job", async () => {
  const { state, options } = harness();
  state.artifacts = uploaded();
  state.jobs = binaryArtifacts.map(({ job }, id) => ({
    id, name: job, status: "in_progress", steps: [{ name: "Complete job", status: "in_progress" }],
  }));
  await waitForMacosBinaries(options);
  assert.equal(state.waits, 0);
  assert.match(state.logs[0], /packaging can start immediately/);
});

test("waits only for the missing binary and logs its current compiler step", async () => {
  const { state, options } = harness();
  state.artifacts = uploaded().slice(0, 1);
  state.jobs = [{ id: 1, name: binaryArtifacts[1].job, status: "in_progress", steps: [{ name: "Compile desktop without bundling", status: "in_progress" }] }];
  await waitForMacosBinaries({ ...options, wait: async () => {
    assert.match(state.logs[0], /x86_64-apple-darwin \[in_progress: Compile desktop without bundling\]/);
    assert.doesNotMatch(state.logs[0], /aarch64/);
    state.artifacts = uploaded();
  } });
});

test("fails promptly when the missing binary's compiler fails", async () => {
  const { state, options } = harness();
  state.jobs = [{ id: 1, name: binaryArtifacts[0].job, status: "completed", conclusion: "failure" }];
  await assert.rejects(waitForMacosBinaries(options), /completed \(failure\); missing macos-binary-aarch64/);
  assert.equal(state.waits, 0);
});

test("a failed compiler finalization does not invalidate an uploaded binary", async () => {
  const { state, options } = harness();
  state.artifacts = uploaded();
  state.jobs = [{ id: 1, name: binaryArtifacts[0].job, status: "completed", conclusion: "timed_out" }];
  await waitForMacosBinaries(options);
  assert.equal(state.waits, 0);
});

test("a rerun uses the latest producer attempt instead of an old failure", async () => {
  const { state, options } = harness();
  state.jobs = [
    { id: 2, name: binaryArtifacts[0].job, status: "in_progress" },
    { id: 1, name: binaryArtifacts[0].job, status: "completed", conclusion: "failure" },
  ];
  await waitForMacosBinaries({ ...options, wait: async () => { state.artifacts = uploaded(); } });
});

test("expired artifacts cannot unblock packaging; waiting times out with missing names", async () => {
  const { state, options } = harness();
  state.artifacts = uploaded().map((artifact) => ({ ...artifact, expired: true }));
  await assert.rejects(waitForMacosBinaries({ ...options, timeout: 65_000 }), /Timed out.*aarch64.*x86_64/);
  assert.equal(state.time, 65_000);
  assert.equal(state.logs.length, 2); // Immediate status, then the minute heartbeat.
});

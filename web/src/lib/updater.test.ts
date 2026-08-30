import { describe, expect, it } from "vitest";
import { formatUpdateProgress, type AppUpdateState } from "./updater";

function downloading(downloadedBytes: number, totalBytes?: number): AppUpdateState {
  return { phase: "downloading", downloadedBytes, totalBytes };
}

describe("formatUpdateProgress", () => {
  it("calculates and rounds download progress", () => {
    expect(formatUpdateProgress(downloading(51, 100))).toBe(51);
    expect(formatUpdateProgress(downloading(1, 3))).toBe(33);
  });

  it("clamps over-reported progress and handles an unknown total", () => {
    expect(formatUpdateProgress(downloading(120, 100))).toBe(100);
    expect(formatUpdateProgress(downloading(20))).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { chatProject } from "./chat-project";
import type { Project } from "./types";

const projects: Project[] = [
  { id: "parent", name: "Parent", repoPath: "/repos/app/", defaultBranch: "main", createdAt: "" },
  { id: "nested", name: "Nested", repoPath: "/repos/app/nested", defaultBranch: "main", createdAt: "" },
];

describe("chat project matching", () => {
  it("uses the closest repository for nested directories and rejects prefix-only matches", () => {
    expect(chatProject(projects, "/repos/app/nested/src/")?.id).toBe("nested");
    expect(chatProject(projects, "\\repos\\app\\src")?.id).toBe("parent");
    expect(chatProject(projects, "/repos/application")).toBeUndefined();
  });
});

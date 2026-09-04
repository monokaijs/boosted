import { describe, expect, it } from "vitest";
import { localWorkspacePath, workspaceFileName, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";

describe("workspace file markdown", () => {
  it("recognizes local file references on Unix and Windows", () => {
    expect(localWorkspacePath("/srv/project/output/report.pdf")).toBe("/srv/project/output/report.pdf");
    expect(localWorkspacePath("file:///srv/project/image%20one.png")).toBe("/srv/project/image one.png");
    expect(localWorkspacePath("C:\\project\\report.pdf")).toBe("C:\\project\\report.pdf");
    expect(localWorkspacePath("artifacts/result.csv")).toBe("artifacts/result.csv");
  });

  it("leaves remote and in-page links to the normal markdown renderer", () => {
    expect(localWorkspacePath("https://example.com/report.pdf")).toBeUndefined();
    expect(localWorkspacePath("//cdn.example.com/image.png")).toBeUndefined();
    expect(localWorkspacePath("#results")).toBeUndefined();
    expect(localWorkspacePath("javascript%3Aalert(1)")).toBeUndefined();
    expect(workspaceMarkdownUrlTransform("javascript:alert(1)")).toBe("");
  });

  it("derives useful download names from source links", () => {
    expect(workspaceFileName("/srv/project/report.pdf:42")).toBe("report.pdf");
    expect(workspaceFileName("/srv/project/image.png#L8-L12")).toBe("image.png");
  });
});

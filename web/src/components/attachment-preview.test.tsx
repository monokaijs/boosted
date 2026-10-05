import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreview } from "./attachment-preview";

const createObjectURL = vi.fn(() => "blob:preview");
const revokeObjectURL = vi.fn();
beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("attachment previews", () => {
  it("shows an inline image, opens a zoomable dialog, fits it, and downloads the original", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const load = vi.fn(async () => ({ blob }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AttachmentPreview name="photo.png" mimeType="image/png" load={load} />);
    expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute("src", "blob:preview");
    fireEvent.click(screen.getByRole("button", { name: "View photo.png" }));
    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(click.mock.instances[0]).toHaveAttribute("download", "photo.png");
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("loads other files on demand and previews text without executing markup", async () => {
    const blob = new Blob([], { type: "text/plain" });
    blob.text = async () => "<script>unsafe()</script>\nNotes";
    const load = vi.fn(async () => ({ blob }));
    const { container } = render(<AttachmentPreview name="notes.txt" mimeType="text/plain" load={load} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View notes.txt" }));
    expect(await screen.findByText("<script>unsafe()</script> Notes")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it.each([
    ["application/pdf", "report.pdf", "iframe"],
    ["audio/mpeg", "recording.mp3", "audio"],
    ["video/mp4", "clip.mp4", "video"],
  ])("previews %s files in the dialog", async (mimeType, name, tag) => {
    render(<AttachmentPreview name={name} mimeType={mimeType} load={async () => ({ blob: new Blob(["content"], { type: mimeType }) })} />);
    fireEvent.click(screen.getByRole("button", { name: `View ${name}` }));
    await waitFor(() => expect(screen.getByRole("dialog").querySelector(tag)).toHaveAttribute("src", "blob:preview"));
  });

  it("offers download for unsupported files and releases preview URLs on unmount", async () => {
    const { unmount } = render(<AttachmentPreview name="archive.zip" load={async () => ({ blob: new Blob(["zip"], { type: "application/zip" }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "View archive.zip" }));
    expect(await screen.findByText("Preview is unavailable for this file type.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("handles failed loads without leaving a loading indicator stuck", async () => {
    render(<AttachmentPreview name="missing.pdf" load={async () => { throw new Error("File not found"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "View missing.pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File not found");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

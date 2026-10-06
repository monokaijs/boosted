import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreview } from "./attachment-preview";
import { AttachmentPreviewLayout, AttachmentPreviewSplitGuard } from "./attachment-preview-layout";

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

  it("retries a failed remote file load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ blob: new Blob(["pdf"], { type: "application/pdf" }) });
    render(<AttachmentPreview name="report.pdf" load={load} />);
    fireEvent.click(screen.getByRole("button", { name: "View report.pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to fetch");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTitle("Preview report.pdf")).toHaveAttribute("src", "blob:preview"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("chat preview layout", () => {
  function width(value: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: value } as DOMRect);
  }

  it("splits a wide chat, keeps the composer available, and detaches without reloading", async () => {
    width(1000);
    const load = vi.fn(async () => ({ blob: new Blob(["image"], { type: "image/png" }) }));
    render(<AttachmentPreviewLayout><textarea aria-label="Chat composer" /><AttachmentPreview name="photo.png" load={load} /></AttachmentPreviewLayout>);
    fireEvent.click(screen.getByRole("button", { name: "View photo.png" }));
    const pane = screen.getByRole("complementary", { name: "File preview" });
    expect(await within(pane).findByRole("img", { name: "photo.png" })).toHaveAttribute("src", "blob:preview");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Chat composer" }), { target: { value: "Continue chatting" } });
    expect(screen.getByRole("textbox")).toHaveValue("Continue chatting");
    fireEvent.click(within(pane).getByRole("button", { name: "Zoom in" }));
    fireEvent.click(within(pane).getByRole("button", { name: "Detach" }));
    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");
    expect(screen.queryByRole("complementary", { name: "File preview" })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "View photo.png" }));
    expect(screen.getByRole("complementary", { name: "File preview" })).toBeInTheDocument();
  });

  it.each([
    { width: 700, alreadySplit: false, guarded: false },
    { width: 1000, alreadySplit: true, guarded: false },
    { width: 1000, alreadySplit: false, guarded: true },
  ])("uses a dialog when there is insufficient room or an existing split (%j)", async (options) => {
    width(options.width);
    render(<AttachmentPreviewLayout alreadySplit={options.alreadySplit}><AttachmentPreviewSplitGuard blocked={options.guarded}><AttachmentPreview name="report.pdf" load={async () => ({ blob: new Blob(["pdf"], { type: "application/pdf" }) })} /></AttachmentPreviewSplitGuard></AttachmentPreviewLayout>);
    fireEvent.click(screen.getByRole("button", { name: "View report.pdf" }));
    expect(screen.getByRole("dialog", { name: "report.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "File preview" })).not.toBeInTheDocument();
    await screen.findByTitle("Preview report.pdf");
  });

  it("moves an open pane into a dialog when the chat becomes narrow", async () => {
    width(1000);
    const load = vi.fn(async () => ({ blob: new Blob(["pdf"], { type: "application/pdf" }) }));
    render(<AttachmentPreviewLayout><AttachmentPreview name="report.pdf" load={load} /></AttachmentPreviewLayout>);
    fireEvent.click(screen.getByRole("button", { name: "View report.pdf" }));
    await screen.findByTitle("Preview report.pdf");
    width(700);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByRole("dialog", { name: "report.pdf" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens a second preview in a dialog while keeping the existing pane", async () => {
    width(1000);
    const load = async () => ({ blob: new Blob(["pdf"], { type: "application/pdf" }) });
    render(<AttachmentPreviewLayout><AttachmentPreview name="first.pdf" load={load} /><AttachmentPreview name="second.pdf" load={load} /></AttachmentPreviewLayout>);
    fireEvent.click(screen.getByRole("button", { name: "View first.pdf" }));
    await screen.findByTitle("Preview first.pdf");
    fireEvent.click(screen.getByRole("button", { name: "View second.pdf" }));
    expect(screen.getByRole("dialog", { name: "second.pdf" })).toBeInTheDocument();
    expect(screen.getByTitle("Preview first.pdf")).toBeInTheDocument();
    await screen.findByTitle("Preview second.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("complementary", { name: "File preview" })).not.toBeInTheDocument();
  });
});

it("renders Markdown documents and saves through the supplied backing-file writer", async () => {
  const blob = new Blob([], { type: "application/octet-stream" });
  blob.arrayBuffer = async () => new TextEncoder().encode("\uFEFF- [ ] File task\r\n").buffer;
  const save = vi.fn(async () => {});
  render(<AttachmentPreview name="tasks.md" load={async () => ({ blob })} saveCheckbox={save} />);
  fireEvent.click(screen.getByRole("button", { name: "View tasks.md" }));
  const checkbox = await screen.findByRole("checkbox", { name: "File task" });
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(save).toHaveBeenCalledWith({ expected: "\uFEFF- [ ] File task\r\n", offset: 4, checked: true });
});

it("renders Markdown documents and saves through the supplied backing-file writer", async () => {
  const blob = new Blob([], { type: "application/octet-stream" });
  blob.arrayBuffer = async () => new TextEncoder().encode("\uFEFF- [ ] File task\r\n").buffer;
  const save = vi.fn(async () => {});
  render(<AttachmentPreview name="tasks.md" load={async () => ({ blob })} saveCheckbox={save} />);
  fireEvent.click(screen.getByRole("button", { name: "View tasks.md" }));
  const checkbox = await screen.findByRole("checkbox", { name: "File task" });
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(save).toHaveBeenCalledWith({ expected: "\uFEFF- [ ] File task\r\n", offset: 4, checked: true });
});

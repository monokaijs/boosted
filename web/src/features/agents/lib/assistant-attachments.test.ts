import { describe, expect, it } from "vitest"
import { checkAssistantAttachmentLimits, pastedImages } from "./assistant-attachments"

describe("attachment composer", () => {
  it("extracts image files from paste without changing text-only pastes", () => {
    const file = new File(["png"], "image.png", { type: "image/png" })
    const clipboard = { items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => file },
      { kind: "file", type: "text/plain", getAsFile: () => new File(["text"], "file.txt") },
    ] } as unknown as DataTransfer
    expect(pastedImages(clipboard)).toEqual([file])
    expect(pastedImages({ items: Array.from(clipboard.items).slice(0, 1) } as unknown as DataTransfer)).toEqual([])
  })

  it("enforces limits when new files are combined with the existing selection", () => {
    expect(() => checkAssistantAttachmentLimits([{ size: 5 * 1024 * 1024 }])).not.toThrow()
    expect(() => checkAssistantAttachmentLimits([{ size: 5 * 1024 * 1024 + 1 }])).toThrow("5 MB")
    expect(() => checkAssistantAttachmentLimits(Array(11).fill({ size: 1 }))).toThrow("10 files")
    expect(() => checkAssistantAttachmentLimits(Array(3).fill({ size: 4 * 1024 * 1024 }))).toThrow("10 MB")
  })
})

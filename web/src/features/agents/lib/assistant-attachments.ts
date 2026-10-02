import { assistantAttachmentLimits, type AssistantAttachment } from "@/features/agents/types/assistant"
import { createClientId, readFileAsDataUrl } from "@/features/agents/lib/session"

export function checkAssistantAttachmentLimits(attachments: Pick<AssistantAttachment, "size">[]): void {
  if (attachments.length > assistantAttachmentLimits.count) throw new Error("Attach up to 10 files per message.")
  if (attachments.some((file) => file.size > assistantAttachmentLimits.fileBytes)) throw new Error("Choose files smaller than 5 MB each.")
  if (attachments.reduce((total, file) => total + file.size, 0) > assistantAttachmentLimits.totalBytes) throw new Error("Attachments must total less than 10 MB.")
}

export async function assistantAttachmentsFromFiles(files: File[]): Promise<AssistantAttachment[]> {
  checkAssistantAttachmentLimits(files)
  return Promise.all(files.map(async (file) => {
    const mimeType = file.type || "application/octet-stream"
    if (mimeType.startsWith("image/") && !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(mimeType)) throw new Error("Use PNG, JPEG, WebP, or GIF images.")
    return {
      id: createClientId(), kind: mimeType.startsWith("image/") && mimeType !== "image/svg+xml" ? "image" : "file",
      name: file.name || "Pasted image.png", mimeType, size: file.size,
      dataUrl: await readFileAsDataUrl(file),
    }
  }))
}

export function pastedImages(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file" && item.type.startsWith("image/"))
  return items.flatMap((item) => { const file = item.getAsFile(); return file ? [file] : [] })
}

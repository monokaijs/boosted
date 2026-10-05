import { X } from "lucide-react"
import { AttachmentPreview } from "@/components/attachment-preview"
import type { AssistantAttachment } from "@/features/agents/types/assistant"
import { cn } from "@/lib/utils"

export function AssistantAttachmentList({ attachments, onRemove }: { attachments?: AssistantAttachment[]; onRemove?: (id: string) => void }) {
  if (!attachments?.length) return null
  return <div aria-label={onRemove ? "Attachments to send" : "Message attachments"} className="flex flex-wrap gap-2">
    {attachments.map((file) => <div className={cn("relative min-w-0", file.kind === "image" ? "max-w-60" : "max-w-64")} key={file.id}>
      <AttachmentPreview name={file.name} mimeType={file.mimeType} src={file.dataUrl} compact={Boolean(onRemove)} className={onRemove ? "pr-6" : undefined} />
      {onRemove ? <button aria-label={`Remove attachment ${file.name}`} className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-background text-muted-foreground hover:text-foreground" type="button" onClick={() => onRemove(file.id)}><X className="size-3" /></button> : null}
    </div>)}
  </div>
}

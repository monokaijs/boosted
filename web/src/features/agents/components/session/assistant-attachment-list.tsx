import { FileText, X } from "lucide-react"
import type { AssistantAttachment } from "@/features/agents/types/assistant"
import { cn } from "@/lib/utils"

export function AssistantAttachmentList({ attachments, onRemove }: { attachments?: AssistantAttachment[]; onRemove?: (id: string) => void }) {
  if (!attachments?.length) return null
  return <div aria-label={onRemove ? "Attachments to send" : "Message attachments"} className="flex flex-wrap gap-2">
    {attachments.map((file) => <div className={cn("relative min-w-0", file.kind === "image" ? "max-w-60" : "max-w-64")} key={file.id}>
      <a download={file.name} href={file.dataUrl} title={file.name} className={cn("block overflow-hidden rounded-xl border border-border bg-secondary", onRemove && "pr-6")}>
        {file.kind === "image" ? <img alt={file.name} className={onRemove ? "h-16 w-20 object-cover" : "max-h-64 w-auto max-w-full object-contain"} src={file.dataUrl} /> : <span className="flex min-w-0 items-center gap-2 px-3 py-2 text-[12px]"><FileText className="size-4 shrink-0" /><span className="truncate">{file.name}</span></span>}
      </a>
      {onRemove ? <button aria-label={`Remove attachment ${file.name}`} className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-background text-muted-foreground hover:text-foreground" type="button" onClick={() => onRemove(file.id)}><X className="size-3" /></button> : null}
    </div>)}
  </div>
}

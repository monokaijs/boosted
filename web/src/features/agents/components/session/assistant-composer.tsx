import { useEffect, useImperativeHandle, useRef, useState, type Dispatch, type Ref, type SetStateAction } from "react"
import { ArrowUp, LoaderCircle, Plus, Square } from "lucide-react"
import { machinePreferenceKey } from "@/lib/store"
import type { AssistantAttachment } from "@/features/agents/types/assistant"
import { assistantAttachmentsFromFiles, checkAssistantAttachmentLimits, pastedImages } from "@/features/agents/lib/assistant-attachments"
import { AssistantAttachmentList } from "./assistant-attachment-list"

export type AssistantComposerHandle = {
  focus: () => void
  setDraft: Dispatch<SetStateAction<string>>
}

type AssistantComposerProps = {
  ref?: Ref<AssistantComposerHandle>
  agentId: string
  assistantName: string
  canSend: boolean
  showStop: boolean
  stopping: boolean
  onSend: (content: string, attachments: AssistantAttachment[]) => boolean
  onStop: () => void
  onError: (error: string | null) => void
}

export function AssistantComposer({ ref, agentId, assistantName, canSend, showStop, stopping, onSend, onStop, onError }: AssistantComposerProps) {
  const [storageKey] = useState(() => machinePreferenceKey(`boosted-agent-draft-${agentId}`))
  const [draft, setDraft] = useState(() => {
    try { return window.sessionStorage.getItem(storageKey) ?? "" }
    catch { return "" }
  })
  const draftRef = useRef(draft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const [readingAttachments, setReadingAttachments] = useState(false)
  const attachmentsRef = useRef<AssistantAttachment[]>([])
  const attachmentQueue = useRef(Promise.resolve())

  const focus = () => textareaRef.current?.focus({ preventScroll: true })
  useImperativeHandle(ref, () => ({ focus, setDraft }), [])

  // Typing stays local to the composer, and synchronous storage writes wait for a pause.
  useEffect(() => {
    draftRef.current = draft
    const timer = setTimeout(() => saveDraft(storageKey, draft), 250)
    return () => clearTimeout(timer)
  }, [storageKey, draft])
  useEffect(() => {
    const flush = () => saveDraft(storageKey, draftRef.current)
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") flush() }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      flush()
    }
  }, [storageKey])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    textarea.style.height = `${Math.max(28, Math.min(textarea.scrollHeight, 160))}px`
  }, [draft])

  const send = () => {
    if (!canSend || stopping || readingAttachments || !onSend(draft, attachmentsRef.current)) return
    setDraft("")
    draftRef.current = ""
    saveDraft(storageKey, "")
    attachmentsRef.current = []
    setAttachments([])
    focus()
  }

  const addFiles = (files: File[]) => {
    if (!files.length) return
    setReadingAttachments(true)
    onError(null)
    attachmentQueue.current = attachmentQueue.current.then(async () => {
      checkAssistantAttachmentLimits([...attachmentsRef.current, ...files])
      const additions = await assistantAttachmentsFromFiles(files)
      const next = [...attachmentsRef.current, ...additions]
      attachmentsRef.current = next
      setAttachments(next)
    }).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to attach files."))
    const queued = attachmentQueue.current
    void queued.finally(() => { if (attachmentQueue.current === queued) setReadingAttachments(false) })
  }

  const removeAttachment = (id: string) => {
    attachmentsRef.current = attachmentsRef.current.filter((file) => file.id !== id)
    setAttachments(attachmentsRef.current)
  }

  return <>
    {attachments.length ? <div className="mb-2"><AssistantAttachmentList attachments={attachments} onRemove={removeAttachment} /></div> : null}
    {readingAttachments ? <p role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Attaching files…</p> : null}
    <form className="assistant-message-composer flex min-h-11 items-end gap-2 rounded-[24px] border border-border/40 bg-secondary px-3 py-[7px]" onSubmit={(event) => { event.preventDefault(); send() }}>
      <button aria-label="Attach files or images" className="session-icon-button disabled:opacity-40" disabled={readingAttachments} type="button" onClick={() => fileInputRef.current?.click()}><Plus className="size-4" /></button>
      <input aria-label="Select attachments" className="hidden" multiple ref={fileInputRef} type="file" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; addFiles(files) }} />
      <textarea aria-label={`Message ${assistantName}`} className="block max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-[14px] leading-5 outline-none placeholder:text-muted-foreground" maxLength={32_000} placeholder="Send a message" ref={textareaRef} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => {
        const images = pastedImages(event.clipboardData)
        if (images.length) { event.preventDefault(); addFiles(images) }
      }} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
      }} />
      {showStop ? <button aria-label="Stop assistant" title="Stop work and cancel waiting messages" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent disabled:opacity-40" disabled={stopping} type="button" onClick={onStop}>{stopping ? <LoaderCircle className="size-3 animate-spin" /> : <Square className="size-3 fill-current" />}</button> : null}
      <button aria-label="Send message" className="assistant-message-send grid size-7 shrink-0 place-items-center rounded-full text-white disabled:opacity-40" disabled={(!draft.trim() && !attachments.length) || stopping || readingAttachments || !canSend} type="submit"><ArrowUp className="size-4" /></button>
    </form>
  </>
}

function saveDraft(key: string, draft: string) {
  try { window.sessionStorage.setItem(key, draft) }
  catch { /* The composer remains usable when browser storage is unavailable. */ }
}

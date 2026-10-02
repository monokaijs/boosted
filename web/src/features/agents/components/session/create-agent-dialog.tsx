import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/features/agents/components/ui/label"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { SessionShellState } from "@/features/agents/components/session/session-shell"

export function CreateAgentDialog({ shell, open, onOpenChange }: { shell: SessionShellState; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("")
  const [personality, setPersonality] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!creating) onOpenChange(next) }}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim() || creating) return
          setCreating(true)
          setError(null)
          try {
            await shell.createAgent({ name: name.trim(), personality: personality.trim() || undefined })
            setName("")
            setPersonality("")
            onOpenChange(false)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not create agent.")
          } finally { setCreating(false) }
        }}>
          <DialogHeader>
            <DialogTitle>New agent</DialogTitle>
            <DialogDescription>Give your agent its own name, personality, and conversation. Every agent can work across all your projects.</DialogDescription>
          </DialogHeader>
          <Label className="grid gap-2 text-sm">
            Name
            <Input autoFocus required maxLength={80} disabled={creating} className="h-9 rounded-lg border border-border bg-background px-3 outline-none focus:border-ring" placeholder="Nova" value={name} onChange={(event) => setName(event.target.value)} />
          </Label>
          <Label className="grid gap-2 text-sm">
            Personality <span className="text-xs text-muted-foreground">Optional · you can change this during chat.</span>
            <Textarea maxLength={2000} disabled={creating} className="min-h-24 resize-y rounded-lg border border-border bg-background p-3 outline-none focus:border-ring" placeholder="Warm, concise, and direct." value={personality} onChange={(event) => setPersonality(event.target.value)} />
          </Label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" type="button" disabled={creating} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={creating || !name.trim()}>{creating ? "Creating…" : "Create agent"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

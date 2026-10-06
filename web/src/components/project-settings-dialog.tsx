import { lazy, Suspense, useState } from "react"
import { Tabs } from "@base-ui/react/tabs"
import { Bot, Settings2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { CodexSettings } from "@/components/settings-codex"
import type { Project } from "@/lib/types"

const ProjectSettingsContent = lazy(() => import("@/components/settings-page").then((module) => ({ default: module.ProjectSettingsContent })))

export function ProjectSettingsDialog({ project, open, onOpenChange }: { project: Project | undefined; open: boolean; onOpenChange(open: boolean): void }) {
  const [tab, setTab] = useState("general")
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="settings-page flex h-[min(760px,calc(100dvh-32px))] max-w-4xl flex-col gap-0 overflow-hidden p-0">
      <div className="shrink-0 border-b border-border px-6 py-5 pr-12">
        <DialogTitle>{project?.name ?? "Project"} settings</DialogTitle>
        <DialogDescription className="mt-1">Repository-specific configuration, integrations, and Codex instructions.</DialogDescription>
      </div>
      <Tabs.Root className="flex min-h-0 flex-1" value={tab} onValueChange={setTab}>
        <Tabs.List className="flex w-44 shrink-0 flex-col gap-1 border-r border-border p-3" aria-label="Project settings sections">
          <Tabs.Tab className="settings-nav-item inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground data-active:bg-accent data-active:text-foreground" value="general"><Settings2 className="size-4" />General</Tabs.Tab>
          <Tabs.Tab className="settings-nav-item inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground data-active:bg-accent data-active:text-foreground" value="codex"><Bot className="size-4" />Codex</Tabs.Tab>
        </Tabs.List>
        <div className="min-h-0 flex-1 overflow-y-auto bg-background">
          <Tabs.Panel value="general"><Suspense fallback={<div className="settings-content"><p className="settings-note">Loading project settings…</p></div>}><ProjectSettingsContent /></Suspense></Tabs.Panel>
          <Tabs.Panel value="codex">{project ? <CodexSettings key={project.id} /> : null}</Tabs.Panel>
        </div>
      </Tabs.Root>
    </DialogContent>
  </Dialog>
}

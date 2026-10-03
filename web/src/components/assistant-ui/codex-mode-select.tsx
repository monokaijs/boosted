import { ChevronDown, ListChecks, MessageSquareText } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CodexCollaborationMode } from "@/lib/types";

export function CodexModeSelect({ value, onChange, disabled }: { value: CodexCollaborationMode; onChange(value: CodexCollaborationMode): void; disabled?: boolean }) {
  const Icon = value === "plan" ? ListChecks : MessageSquareText;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" className="new-task-option codex-mode-option shrink-0" aria-label="Chat mode" disabled={disabled}><Icon className="size-3.5" /><span>{value === "plan" ? "Plan" : "Chat"}</span><ChevronDown /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-64">
      <DropdownMenuLabel>Chat mode</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={value} onValueChange={(mode) => onChange(mode as CodexCollaborationMode)}>
        <DropdownMenuRadioItem value="default"><span><span className="block font-medium">Chat</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Work on requests and implement plans.</span></span></DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="plan"><span><span className="block font-medium">Plan</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Explore, ask questions, and plan before making changes.</span></span></DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}

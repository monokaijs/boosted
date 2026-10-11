import { CircleAlert, CircleCheck, CircleDashed, CircleDotDashed, ListTodo, LoaderCircle, MessageCircleQuestion, ScanLine } from "lucide-react";
import type { TaskStatus } from "@/lib/types";

export const taskStatusMeta: Record<TaskStatus, { label: string; boardLabel: string; color: string; icon: typeof CircleCheck }> = {
  queued: { label: "To do", boardLabel: "To do", color: "text-muted-foreground", icon: ListTodo },
  planning: { label: "Planning", boardLabel: "Planning", color: "text-primary", icon: CircleDotDashed },
  ready: { label: "Planned", boardLabel: "Planned", color: "text-primary", icon: ScanLine },
  running: { label: "Running", boardLabel: "Running", color: "text-primary", icon: LoaderCircle },
  needs_input: { label: "Input required", boardLabel: "Needs input", color: "text-warning", icon: MessageCircleQuestion },
  review: { label: "Review required", boardLabel: "Review", color: "text-success", icon: CircleDashed },
  done: { label: "Done", boardLabel: "Done", color: "text-success", icon: CircleCheck },
  failed: { label: "Failed", boardLabel: "Failed", color: "text-destructive", icon: CircleAlert },
};

export const boardColumns = [
  { id: "todo", label: "To do", statuses: ["queued", "planning", "ready"], targetStatus: "queued", color: "text-muted-foreground", icon: ListTodo },
  { id: "in-progress", label: "In progress", statuses: ["running"], targetStatus: "running", color: "text-chat-accent", icon: LoaderCircle },
  { id: "attention", label: "Needs attention", statuses: ["needs_input", "review", "failed"], targetStatus: "review", color: "text-warning", icon: MessageCircleQuestion },
  { id: "done", label: "Done", statuses: ["done"], targetStatus: "done", color: "text-success", icon: CircleCheck },
] satisfies { id: string; label: string; statuses: TaskStatus[]; targetStatus: TaskStatus; color: string; icon: typeof CircleCheck }[];

import { CircleAlert, CircleCheck, CircleDashed, CircleDotDashed, ListTodo, LoaderCircle, MessageCircleQuestion, ScanLine } from "lucide-react";
import type { TaskStatus } from "@/lib/types";

export const taskStatusMeta: Record<TaskStatus, { label: string; boardLabel: string; color: string; icon: typeof CircleCheck }> = {
  queued: { label: "To do", boardLabel: "To do", color: "text-muted-foreground", icon: ListTodo },
  planning: { label: "Planning", boardLabel: "Planning", color: "text-primary", icon: CircleDotDashed },
  ready: { label: "Ready to run", boardLabel: "Ready", color: "text-primary", icon: ScanLine },
  running: { label: "Running", boardLabel: "Running", color: "text-primary", icon: LoaderCircle },
  needs_input: { label: "Input required", boardLabel: "Needs input", color: "text-warning", icon: MessageCircleQuestion },
  review: { label: "Review required", boardLabel: "Review", color: "text-success", icon: CircleDashed },
  done: { label: "Done", boardLabel: "Done", color: "text-success", icon: CircleCheck },
  failed: { label: "Failed", boardLabel: "Failed", color: "text-destructive", icon: CircleAlert },
};

export const boardStatuses: TaskStatus[] = ["queued", "planning", "ready", "running", "needs_input", "review", "done", "failed"];

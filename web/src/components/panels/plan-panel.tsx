import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, ListChecks, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function PlanPanel() {
  const taskId = useAppStore((state) => state.selectedTaskId);
  const queryClient = useQueryClient();
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId!), enabled: Boolean(taskId), refetchInterval: 1_500 });
  const approve = useMutation({ mutationFn: () => api.approvePlan(taskId!, task.data!.plan!.revision), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["task", taskId] }); void queryClient.invalidateQueries({ queryKey: ["tasks"] }); } });
  if (!taskId) return <div className="panel-root tool-panel"><div className="panel-header"><div className="panel-title"><ClipboardCheck className="size-3.5" />Plan</div></div><div className="empty-state min-h-0 flex-1"><ListChecks className="size-8" /><p>Select a task to inspect its plan.</p></div></div>;
  const plan = task.data?.plan;
  const planning = task.data?.status === "planning";
  return (
    <div className="panel-root tool-panel">
      <div className="panel-header"><div className="panel-title"><ClipboardCheck className="size-3.5" />Plan</div>{plan && <Badge variant="outline">Revision {plan.revision}</Badge>}</div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {!plan && planning && <div className="grid justify-items-center gap-3 py-16 text-center text-xs text-muted-foreground"><LoaderCircle className="size-6 animate-spin text-primary" /><div><p className="font-medium text-foreground">Building the plan</p><p className="mt-1">Codex is inspecting the worktree and defining the execution steps.</p></div></div>}
          {!plan && !planning && <div className="empty-state min-h-64"><ListChecks className="size-7" /><p>No plan is available yet.</p></div>}
          {plan && <>
            {plan.explanation && <p className="mb-4 text-xs leading-5 text-muted-foreground">{plan.explanation}</p>}
            {plan.markdown && <div className="mb-4 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{plan.markdown}</div>}
            <ol className="grid gap-1.5">
              {plan.steps.map((item, index) => (
                <li key={`${item.step}-${index}`} className="grid grid-cols-[22px_1fr] gap-2 rounded-md border border-border/70 bg-background/25 px-3 py-2.5">
                  <span className={cn("mt-px flex size-5 items-center justify-center rounded-full border text-[10px]", item.status === "completed" ? "border-success/30 bg-success/10 text-success" : item.status === "in_progress" ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{item.status === "completed" ? <Check className="size-3" /> : index + 1}</span>
                  <span className={cn("text-xs leading-5", item.status === "completed" && "text-muted-foreground line-through")}>{item.step}</span>
                </li>
              ))}
            </ol>
          </>}
        </div>
      </ScrollArea>
      {plan && task.data?.status === "ready" && <div className="border-t border-border p-3"><Button className="w-full" onClick={() => approve.mutate()} disabled={approve.isPending}>{approve.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}Approve and run</Button><p className="mt-2 text-center text-[10px] leading-4 text-warning">Execution has full access to the host machine.</p>{approve.error && <p className="mt-2 text-xs text-destructive">{approve.error.message}</p>}</div>}
      {plan?.approvedAt && task.data?.status !== "ready" && <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[11px] text-success"><Check className="size-3.5" />Plan approved</div>}
      {task.data?.status === "failed" && <div className="border-t border-border p-3"><Button className="w-full" variant="outline" onClick={() => window.dispatchEvent(new CustomEvent("boosted:open-panel", { detail: "task" }))}><RotateCcw />Open task chat to retry</Button></div>}
    </div>
  );
}

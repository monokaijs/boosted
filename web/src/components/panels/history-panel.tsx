import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitCommitHorizontal, GitFork, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { graphLaneColors, palette } from "@/lib/palette";
import { useAppStore } from "@/lib/store";
import { relativeTime, shortId } from "@/lib/utils";
import type { GitCommit } from "@/lib/types";

const laneColors = graphLaneColors;

type GraphRow = { commit: GitCommit; before: string[]; after: string[]; lane: number };

function buildGraph(commits: GitCommit[]): GraphRow[] {
  const active: string[] = [];
  return commits.map((commit) => {
    let lane = active.indexOf(commit.id);
    if (lane < 0) { lane = active.length; active.push(commit.id); }
    const before = [...active];
    const firstParent = commit.parents[0];
    if (firstParent) active[lane] = firstParent;
    else active.splice(lane, 1);
    commit.parents.slice(1).forEach((parent, offset) => {
      if (!active.includes(parent)) active.splice(lane + 1 + offset, 0, parent);
    });
    return { commit, before, after: [...active], lane };
  });
}

function GraphCell({ row }: { row: GraphRow }) {
  const lanes = Math.max(row.before.length, row.after.length, 1);
  const width = Math.min(86, lanes * 16 + 10);
  const x = (lane: number) => 9 + lane * 16;
  const color = (lane: number) => laneColors[lane % laneColors.length];
  const paths: React.ReactNode[] = [];

  row.before.forEach((id, topLane) => {
    if (topLane === row.lane) return;
    const bottomLane = row.after.indexOf(id);
    if (bottomLane >= 0) paths.push(<path key={`pass-${id}-${topLane}`} d={`M ${x(topLane)} 0 C ${x(topLane)} 18, ${x(bottomLane)} 22, ${x(bottomLane)} 40`} stroke={color(topLane)} />);
  });
  paths.push(<path key="incoming" d={`M ${x(row.lane)} 0 L ${x(row.lane)} 20`} stroke={color(row.lane)} />);
  row.commit.parents.forEach((parent, parentIndex) => {
    const parentLane = row.after.indexOf(parent);
    if (parentLane >= 0) paths.push(<path key={`parent-${parent}`} d={`M ${x(row.lane)} 20 C ${x(row.lane)} 28, ${x(parentLane)} 30, ${x(parentLane)} 40`} stroke={color(parentIndex === 0 ? row.lane : parentLane)} />);
  });

  return (
    <svg width={width} height="40" viewBox={`0 0 ${width} 40`} className="overflow-visible" aria-label={`${row.commit.parents.length} parent commit${row.commit.parents.length === 1 ? "" : "s"}`}>
      <g fill="none" strokeWidth="1.5">{paths}</g>
      <circle cx={x(row.lane)} cy="20" r="4.25" fill={palette.surface} stroke={color(row.lane)} strokeWidth="2.25" />
    </svg>
  );
}

export function HistoryPanel() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const history = useQuery({ queryKey: ["project", projectId, "git", "history"], queryFn: () => api.projectGitHistory(projectId!), enabled: Boolean(projectId), refetchInterval: 10_000 });
  const graph = useMemo(() => buildGraph(history.data ?? []), [history.data]);
  if (!projectId) return <div className="panel-root tool-panel history-panel"><div className="panel-header"><div className="panel-title"><GitCommitHorizontal className="size-3.5" />Git history</div></div><div className="empty-state min-h-0 flex-1"><GitFork className="size-8" /><p>Open a project to inspect its commit graph.</p></div></div>;
  return (
    <div className="panel-root tool-panel history-panel">
      <div className="panel-header"><div className="panel-title"><GitCommitHorizontal className="size-3.5" />Git history</div><span className="text-[10px] text-muted-foreground">{history.data?.length ?? 0} commits</span></div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="history-table py-1">
          {graph.map((row) => {
            const commit = row.commit;
            return (
            <button key={commit.id} className="history-row group grid h-10 w-full items-center text-left text-[11px] hover:bg-accent/50">
              <span className="flex h-full items-center overflow-hidden pl-1"><GraphCell row={row} /></span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{commit.subject}</span>
                  {!!commit.refs.length && (
                    <span className="history-refs flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">
                      {commit.refs.map((ref) => (
                        <Badge key={ref} variant="outline" className="history-ref h-4 shrink-0 px-1.5 text-[9px]" title={ref}>
                          <Tag className="size-2.5 shrink-0" />
                          <span className="truncate">{ref}</span>
                        </Badge>
                      ))}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[9px] text-muted-foreground">{commit.body}</span>
              </span>
              <span className="history-author truncate text-muted-foreground">{commit.author}</span>
              <span className="history-identity pr-3 text-right font-mono text-[9px] text-muted-foreground" title={commit.id}>{shortId(commit.id)} · {relativeTime(commit.authoredAt)}</span>
            </button>
          )})}
          {history.isLoading && <div className="p-6 text-center text-xs text-muted-foreground">Loading history…</div>}
          {history.error && <div className="p-4 text-xs text-destructive">{history.error.message}</div>}
        </div>
      </ScrollArea>
    </div>
  );
}

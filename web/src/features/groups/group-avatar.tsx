import { useQuery } from '@tanstack/react-query';
import { GradientAvatar } from '@/components/gradient-avatar';
import { ProjectAvatar } from '@/components/project-avatar';
import { useBoostedApiClient } from '@/lib/api-context';
import type { GroupSummary } from './types';

export function GroupAvatar({ group, className }: {
  group: Pick<GroupSummary, 'id' | 'name' | 'projectId'>;
  className?: string;
}) {
  const client = useBoostedApiClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: client.projects, enabled: Boolean(group.projectId) });
  const project = projects.data?.find((entry) => entry.id === group.projectId);
  if (project) return <ProjectAvatar project={project} className={className} slot="group-avatar" />;
  return <GradientAvatar seed={group.id || group.name} className={className} slot="group-avatar" />;
}

import { GradientAvatar } from '@/components/gradient-avatar';
import type { GroupSummary } from './types';

export function GroupAvatar({ group, className }: {
  group: Pick<GroupSummary, 'id' | 'name'>;
  className?: string;
}) {
  return <GradientAvatar seed={group.id || group.name} className={className} slot="group-avatar" />;
}

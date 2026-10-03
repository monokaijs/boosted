import type { GroupMemberRole, GroupRole } from './types';

export const groupRoleLabels: Record<GroupRole, string> = {
  coordinator: 'Leader', developer: 'Developer', reviewer: 'Reviewer', researcher: 'Researcher', designer: 'Designer',
};
export const groupRoleDescriptions: Record<GroupRole, string> = {
  coordinator: 'Your main contact. Delegates tasks, manages the team, and reports results.',
  developer: 'Implements assigned changes and verifies the result.',
  reviewer: 'Checks results, tests behavior, and requests fixes.',
  researcher: 'Investigates questions and provides evidence for decisions.',
  designer: 'Owns user experience, interface design, and visual details.',
};

export const memberRoleNames = (member: GroupMemberRole): GroupRole[] => member.roles ?? [member.role];
export const memberRoleLabel = (member: GroupMemberRole) => memberRoleNames(member).map((role) => groupRoleLabels[role]).join(', ');
export function withMemberRoles(member: GroupMemberRole, roles: GroupRole[]): GroupMemberRole {
  return { ...member, role: roles.includes('coordinator') ? 'coordinator' : roles[0], roles };
}

export function defaultGroupRoles(memberIds: string[], previous: Record<string, GroupMemberRole> = {}) {
  const roles = Object.fromEntries(memberIds.map((id, index) => {
    const member: GroupMemberRole = previous[id] ?? {
    role: (['developer', 'developer', 'reviewer', 'researcher', 'designer'][index] ?? 'developer') as GroupRole,
    responsibilities: '',
    };
    return [id, withMemberRoles(member, memberRoleNames(member))];
  }));
  if (memberIds.length && !Object.values(roles).some((role) => memberRoleNames(role).includes('coordinator'))) {
    const first = memberIds[0];
    roles[first] = withMemberRoles(roles[first], previous[first] ? ['coordinator', ...memberRoleNames(roles[first])] : ['coordinator']);
  }
  return roles;
}

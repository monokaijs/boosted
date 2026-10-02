import { cn } from "@/lib/utils"

const colors = ["#a06875", "#537d92", "#78709b", "#527e6b", "#9c7951", "#6a78a0"]

export function AgentAvatar({ name, avatar, className }: { name: string; avatar?: string; className?: string }) {
  const hash = Array.from(name).reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0)
  const initials = name.trim().split(/\s+/u).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "A"
  return <span aria-hidden="true" className={cn("agent-avatar grid size-14 shrink-0 place-items-center overflow-hidden rounded-full text-lg font-medium text-white", className)} style={{ backgroundColor: colors[hash % colors.length] }}>
    {avatar ? <img alt="" className="size-full object-cover" src={avatar} /> : initials}
  </span>
}

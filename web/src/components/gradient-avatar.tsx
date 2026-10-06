import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

function avatarGradient(seed: string) {
  // Hash the whole ID so similar IDs still produce distinct gradients.
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  const accentHue = (hue + 45 + ((hash >>> 8) % 75)) % 360;
  const angle = (hash >>> 16) % 360;
  const x = 15 + ((hash >>> 4) % 70);
  const y = 15 + ((hash >>> 12) % 70);

  return [
    `radial-gradient(ellipse at ${x}% ${y}%, hsl(${accentHue} 90% 80% / .9), transparent 65%)`,
    `radial-gradient(ellipse at ${100 - x}% ${100 - y}%, hsl(${hue} 85% 65% / .8), transparent 70%)`,
    `linear-gradient(${angle}deg, hsl(${hue} 70% 32%), hsl(${accentHue} 80% 56%))`,
  ].join(", ");
}

export function GradientAvatar({ seed, className, slot = "gradient-avatar", children }: {
  seed: string;
  className?: string;
  slot?: string;
  children?: ReactNode;
}) {
  return <span
    aria-hidden="true"
    data-slot={slot}
    className={cn("inline-block size-4 shrink-0 rounded-[4px] ring-1 ring-inset ring-white/10", className)}
    style={{ backgroundImage: avatarGradient(seed) }}
  >{children}</span>;
}

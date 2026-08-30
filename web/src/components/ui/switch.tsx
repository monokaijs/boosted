import * as React from "react";
import { cn } from "@/lib/utils";

type SwitchProps = Omit<React.ComponentProps<"button">, "onChange"> & {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

function Switch({ checked, className, disabled, onCheckedChange, onClick, ...props }: SwitchProps) {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    data-state={checked ? "checked" : "unchecked"}
    disabled={disabled}
    className={cn(
      "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
      checked ? "bg-primary" : "bg-input",
      className,
    )}
    onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) onCheckedChange?.(!checked);
    }}
    {...props}
  >
    <span className={cn("block size-4 rounded-full bg-background shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
  </button>;
}

export { Switch };

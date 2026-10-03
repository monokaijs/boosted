import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "./dropdown-menu";

const selectTriggerStyles = "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 py-1 text-xs shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&>span]:truncate";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger className={cn(selectTriggerStyles, className)} {...props}>{children}<SelectPrimitive.Icon asChild><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}

function MultiSelect({ value, onValueChange, options, ariaLabel, disabled, className, minSelected = 0 }: {
  value: string[]; onValueChange(value: string[]): void; options: { value: string; label: string }[];
  ariaLabel: string; disabled?: boolean; className?: string; minSelected?: number;
}) {
  const labels = value.map((selected) => options.find((option) => option.value === selected)?.label ?? selected).join(', ');
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label={ariaLabel} disabled={disabled} className={cn(selectTriggerStyles, className)} title={labels}>
    <span>{labels || 'Select roles'}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
  </button></DropdownMenuTrigger><DropdownMenuContent className="z-[70]" align="end">
    {options.map((option) => <DropdownMenuCheckboxItem key={option.value} checked={value.includes(option.value)} disabled={value.includes(option.value) && value.length <= minSelected} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onValueChange(checked ? [...value, option.value] : value.filter((selected) => selected !== option.value))}>{option.label}</DropdownMenuCheckboxItem>)}
  </DropdownMenuContent></DropdownMenu>;
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return <SelectPrimitive.ScrollUpButton className={cn("flex h-6 cursor-default items-center justify-center", className)} {...props}><ChevronUp className="size-3.5" /></SelectPrimitive.ScrollUpButton>;
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return <SelectPrimitive.ScrollDownButton className={cn("flex h-6 cursor-default items-center justify-center", className)} {...props}><ChevronDown className="size-3.5" /></SelectPrimitive.ScrollDownButton>;
}

function SelectContent({ className, children, position = "popper", sideOffset = 4, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content position={position} sideOffset={sideOffset} className={cn("relative z-[70] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out", position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1", className)} {...props}><SelectScrollUpButton /><SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport><SelectScrollDownButton /></SelectPrimitive.Content></SelectPrimitive.Portal>;
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground", className)} {...props} />;
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-7 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45", className)} {...props}><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText><span className="absolute right-2 flex size-3.5 items-center justify-center"><SelectPrimitive.ItemIndicator><Check className="size-3.5" /></SelectPrimitive.ItemIndicator></span></SelectPrimitive.Item>;
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export { MultiSelect, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };

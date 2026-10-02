import { cloneElement, isValidElement, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type SettingsSelectProps = Omit<ComponentProps<typeof SelectTrigger>, "children" | "onChange"> & {
  value: string;
  onValueChange(value: string): void;
  options: readonly { value: string; label: string }[];
};

export function SettingsSelect({ value, onValueChange, options, disabled, className, ...props }: SettingsSelectProps) {
  // Radix reserves an empty value for clearing; keep the saved automatic default empty.
  const automatic = "__boosted_automatic__";
  return <Select value={value || automatic} onValueChange={(next) => onValueChange(next === automatic ? "" : next)} disabled={disabled}>
    <SelectTrigger className={cn("settings-select", className)} {...props}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value || automatic}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}

export function SettingsSection({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="settings-section">
    <div className="settings-section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="settings-actions">{actions}</div>}</div>
    {children}
  </section>;
}

export function SettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("settings-group", className)}>{children}</div>;
}

export function SettingsRow({ label, description, children, stacked = false, className }: { label: string; description?: ReactNode; children: ReactNode; stacked?: boolean; className?: string }) {
  const id = useId();
  const isControl = isValidElement(children) && [Input, Switch, Textarea, SettingsSelect, "input", "select", "textarea"].some((type) => children.type === type);
  const control = isControl && isValidElement<{ id?: string; "aria-labelledby"?: string; "aria-describedby"?: string }>(children)
    ? cloneElement(children, { id, "aria-labelledby": `${id}-label`, "aria-describedby": description ? `${id}-description` : undefined })
    : children;
  return <div className={cn("settings-row", stacked && "settings-row-stacked", className)}>
    <div className="settings-row-copy"><label id={`${id}-label`} htmlFor={isControl ? id : undefined}>{label}</label>{description && <p id={`${id}-description`}>{description}</p>}</div>
    <div className="settings-row-control">{control}</div>
  </div>;
}

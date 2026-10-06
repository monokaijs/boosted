import { CalendarClock, FolderOpen, House, ListTodo, Settings } from "lucide-react";

export const destinations = [
  { id: "home", label: "Home", icon: House },
  { id: "scheduled", label: "Scheduled", icon: CalendarClock },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
export type AppPage = typeof destinations[number]["id"];

export const settingsSections = ["providers", "connections", "appearance", "notifications", "web", "application", "team", "usage", "integrations"] as const;
export type SettingsSectionId = typeof settingsSections[number] | "workspace" | "codex";

export function settingsSectionFromHash(): SettingsSectionId | undefined {
  if (window.location.hash === "#usage") return "usage";
  const id = window.location.hash.replace(/^#settings\//, "");
  return settingsSections.find((section): section is typeof settingsSections[number] => section === id);
}

export function navigateSettings(section?: SettingsSectionId) {
  const hash = section ? `#settings/${section}` : "#settings";
  if (window.location.hash === hash) return;
  window.history.pushState({ ...window.history.state, boostedSettingsIndex: window.location.hash === "#settings" }, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function backToSettings() {
  if (window.history.state?.boostedSettingsIndex) window.history.back();
  else {
    window.history.replaceState(window.history.state, "", "#settings");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

export function pageFromHash(): AppPage {
  const id = window.location.hash.slice(1).split("/")[0];
  if (id === "usage") return "settings";
  if (id === "chats") return "home";
  return destinations.find((page) => page.id === id)?.id ?? "home";
}

export function navigate(page: AppPage) {
  window.location.hash = page;
}

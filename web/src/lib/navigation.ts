import { CalendarClock, ChartNoAxesCombined, FolderOpen, House, ListTodo, Settings } from "lucide-react";

export const destinations = [
  { id: "home", label: "Home", icon: House },
  { id: "scheduled", label: "Scheduled", icon: CalendarClock },
  { id: "projects", label: "Projects", icon: FolderOpen },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "usage", label: "Usage", icon: ChartNoAxesCombined },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
export type AppPage = typeof destinations[number]["id"];

export function pageFromHash(): AppPage {
  const id = window.location.hash.slice(1);
  if (id === "chats") return "home";
  return destinations.find((page) => page.id === id)?.id ?? "home";
}

export function navigate(page: AppPage) {
  window.location.hash = page;
}

import {
  Bot,
  FlaskConical,
  FolderKanban,
  Library,
  type LucideIcon,
  Search,
  Settings,
  Shapes,
  SquarePen,
} from "lucide-react";

export type NavItem = {
  id: string;
  label: string;
  /** Route to navigate to. `null` means the item performs an action instead (e.g. open search). */
  href: string | null;
  icon: LucideIcon;
  description: string;
  /** Extra words the command palette matches on. */
  keywords?: string[];
};

/** Main sidebar, in the order defined by the product spec. Single source for sidebar, palette and tests. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "new-chat",
    label: "New chat",
    href: "/",
    icon: SquarePen,
    description: "Start a new conversation",
    keywords: ["conversation", "message", "home"],
  },
  {
    id: "search",
    label: "Search",
    href: null,
    icon: Search,
    description: "Search and jump anywhere",
    keywords: ["find", "command", "palette"],
  },
  {
    id: "projects",
    label: "Projects",
    href: "/projects",
    icon: FolderKanban,
    description: "Workspaces with their own instructions and knowledge",
    keywords: ["workspace", "knowledge", "documents"],
  },
  {
    id: "artifacts",
    label: "Artifacts",
    href: "/artifacts",
    icon: Shapes,
    description: "Interactive documents, code and previews",
    keywords: ["html", "react", "svg", "mermaid", "preview"],
  },
  {
    id: "agents",
    label: "Agents",
    href: "/agents",
    icon: Bot,
    description: "Multi-step tasks with tools and approvals",
    keywords: ["tools", "automation", "tasks"],
  },
  {
    id: "research",
    label: "Research Studio",
    href: "/research",
    icon: FlaskConical,
    description: "Datasets, training runs and evaluations",
    keywords: ["training", "fine-tune", "lora", "dataset", "benchmark"],
  },
  {
    id: "models",
    label: "Model Library",
    href: "/models",
    icon: Library,
    description: "Local models, downloads and settings",
    keywords: ["ollama", "gguf", "llama", "hugging face"],
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Appearance, privacy and shortcuts",
    keywords: ["preferences", "appearance", "privacy", "shortcuts"],
  },
] as const;

/** True when `pathname` is inside the section that `href` points to. */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type Shortcut = {
  id: string;
  keys: string[];
  description: string;
};

/** Displayed in Settings and the command palette. Handlers live in the app shell. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", keys: ["Ctrl", "K"], description: "Open search and commands" },
  { id: "sidebar", keys: ["Ctrl", "."], description: "Collapse or expand the sidebar" },
  { id: "close", keys: ["Esc"], description: "Close dialogs and menus" },
];

/** Matches Ctrl (Windows/Linux) or Cmd (macOS) plus a key, without Alt/Shift. */
export function isModKey(e: KeyboardEvent, key: string): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key;
}

"use client";

import Link from "next/link";

import { useApiHealth } from "@/hooks/use-api-health";
import { useConversations } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";

export function RecentConversations({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  const health = useApiHealth();
  const list = useConversations(health.isSuccess);

  let content: React.ReactNode;
  if (!health.isSuccess) {
    content = (
      <p className="mt-2 text-sm text-muted-foreground/80">
        {health.isPending ? "Connecting…" : "Start the local API to see conversations."}
      </p>
    );
  } else if (list.isPending) {
    content = <p className="mt-2 text-sm text-muted-foreground/80">Loading…</p>;
  } else if (list.isError) {
    content = <p className="mt-2 text-sm text-destructive">Couldn&apos;t load conversations.</p>;
  } else if (list.data.length === 0) {
    content = <p className="mt-2 text-sm text-muted-foreground/80">No conversations yet.</p>;
  } else {
    content = (
      <ul className="-mx-2 mt-1 flex flex-col gap-0.5">
        {list.data.map((c) => {
          const href = `/chat/${c.id}`;
          const active = pathname === href;
          return (
            <li key={c.id}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                title={c.title}
                className={cn(
                  "block truncate rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                {c.title}
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }
  return content;
}

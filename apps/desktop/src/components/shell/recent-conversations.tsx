"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { ConversationMenu } from "@/components/conversation/conversation-menu";
import { useApiHealth } from "@/hooks/use-api-health";
import { useConversations } from "@/hooks/use-chat";
import type { ConversationSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Pinned and recent conversations in the sidebar. The full history lives at /chats. */
export function RecentConversations({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  const health = useApiHealth();
  const list = useConversations({ limit: 30 }, health.isSuccess);

  if (!health.isSuccess) {
    return (
      <Section title="Recents">
        <Hint>{health.isPending ? "Connecting…" : "Start the local API to see conversations."}</Hint>
      </Section>
    );
  }
  if (list.isPending) {
    return (
      <Section title="Recents">
        <Hint>Loading…</Hint>
      </Section>
    );
  }
  if (list.isError) {
    return (
      <Section title="Recents">
        <p className="mt-2 text-sm text-destructive">Couldn&apos;t load conversations.</p>
      </Section>
    );
  }
  const pinned = list.data.filter((c) => c.pinned);
  const recent = list.data.filter((c) => !c.pinned);
  return (
    <>
      {pinned.length > 0 && (
        <Section title="Pinned">
          <ConversationLinks items={pinned} pathname={pathname} onNavigate={onNavigate} />
        </Section>
      )}
      <Section title="Recents">
        {recent.length === 0 && pinned.length === 0 ? (
          <Hint>No conversations yet.</Hint>
        ) : (
          <ConversationLinks items={recent} pathname={pathname} onNavigate={onNavigate} />
        )}
        <Link
          href="/chats"
          onClick={onNavigate}
          aria-current={pathname === "/chats" ? "page" : undefined}
          className="mt-1 -ml-2 block rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          All chats →
        </Link>
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm text-muted-foreground/80">{children}</p>;
}

function ConversationLinks({
  items,
  pathname,
  onNavigate,
}: {
  items: ConversationSummary[];
  pathname: string | null;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  return (
    <ul className="-mx-2 mt-1 flex flex-col gap-0.5">
      {items.map((c) => {
        const href = `/chat/${c.id}`;
        const active = pathname === href;
        return (
          <li
            key={c.id}
            className={cn(
              "group/item relative flex items-center rounded-md hover:bg-sidebar-accent",
              active && "bg-sidebar-accent",
            )}
          >
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              title={c.title}
              className={cn(
                "block min-w-0 flex-1 truncate rounded-md py-1.5 pr-8 pl-2 text-sm text-sidebar-foreground/80 outline-none hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                active && "text-sidebar-accent-foreground",
              )}
            >
              {c.title}
            </Link>
            <ConversationMenu
              conversation={c}
              onDeleted={() => {
                if (active) router.push("/");
              }}
              triggerClassName="absolute right-0.5 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            />
          </li>
        );
      })}
    </ul>
  );
}

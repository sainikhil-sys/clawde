import Link from "next/link";
import { Suspense } from "react";

import { RunView } from "@/components/agents/run-view";
import { Page } from "@/components/page/page";

export const metadata = { title: "Agent run" };

export default function AgentRunPage({ params }: PageProps<"/agents/[id]">) {
  return (
    <Page className="max-w-4xl">
      <nav className="mb-4 text-sm">
        <Link href="/agents" className="text-muted-foreground hover:text-foreground hover:underline">
          ← All agent runs
        </Link>
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading run…</p>}>
        {params.then(({ id }) => (
          <RunView key={id} runId={id} />
        ))}
      </Suspense>
    </Page>
  );
}

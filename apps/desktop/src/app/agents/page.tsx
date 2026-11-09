import type { Metadata } from "next";

import { AgentsIndex } from "@/components/agents/agents-index";
import { Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <Page className="max-w-6xl">
      <PageHeader
        title="Agents"
        description="Hand off multi-step tasks. An agent plans, uses the tools you allow, and pauses for your approval before writing files or running code. Every run keeps a full step-by-step history."
      />
      <AgentsIndex />
    </Page>
  );
}

import type { Metadata } from "next";
import { Bot } from "lucide-react";

import { EmptyState, Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <Page>
      <PageHeader
        title="Agents"
        description="Hand off multi-step tasks. An agent plans, uses permitted tools and pauses for your approval before anything sensitive, such as writing files or running code."
      />
      <EmptyState icon={Bot} title="No agent runs yet" milestone={10}>
        Agents need the tool registry, permission system and code sandbox. Every run will keep a full step-by-step
        history you can inspect.
      </EmptyState>
    </Page>
  );
}

import type { Metadata } from "next";

import { MemoryView } from "@/components/memory/memory-view";
import { Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Memory" };

export default function MemoryPage() {
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title="Memory"
        description="Everything Clawde can recall across conversations: your preferences, conversation summaries, project notes, knowledge and temporary context. It is stored only on this computer, and you can edit or delete any of it."
      />
      <MemoryView />
    </Page>
  );
}

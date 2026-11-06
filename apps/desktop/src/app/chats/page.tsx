import type { Metadata } from "next";

import { ConversationHistory } from "@/components/conversation/history";
import { Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "All chats" };

export default function ChatsPage() {
  return (
    <Page className="max-w-5xl">
      <PageHeader
        title="All chats"
        description="Search, organise and manage every conversation. Everything here is stored only on this computer."
      />
      <ConversationHistory />
    </Page>
  );
}

import { Suspense } from "react";

import { ChatView } from "@/components/chat/chat-view";

export const metadata = { title: "New project chat" };

/** A new chat inside a project: the conversation is created in the project on first send. */
export default function NewProjectChatPage({ params }: PageProps<"/projects/[id]/new">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>}>
      {params.then(({ id }) => (
        <ChatView key={id} conversationId={null} projectId={id} />
      ))}
    </Suspense>
  );
}

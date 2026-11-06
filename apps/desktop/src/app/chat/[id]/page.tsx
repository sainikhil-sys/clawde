import { Suspense } from "react";

import { ChatView } from "@/components/chat/chat-view";

export const metadata = { title: "Chat" };

/** Params are runtime data under Cache Components, so they are read inside a Suspense boundary. */
export default function ChatPage({ params }: PageProps<"/chat/[id]">) {
  return (
    <Suspense fallback={<p className="p-8 text-center text-sm text-muted-foreground">Loading conversation…</p>}>
      {params.then(({ id }) => (
        <ChatView key={id} conversationId={id} />
      ))}
    </Suspense>
  );
}

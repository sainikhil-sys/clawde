import type { Metadata } from "next";
import { Library } from "lucide-react";

import { EmptyState, Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Model Library" };

export default function ModelsPage() {
  return (
    <Page>
      <PageHeader
        title="Model Library"
        description="Every local model in one place, whether from Ollama, llama.cpp GGUF files or Hugging Face, with licence, size, context length, memory needs and evaluated behaviour."
      />
      <EmptyState icon={Library} title="Not connected to a model runtime" milestone={11}>
        Basic model listing and switching arrive with streaming in Milestone 4. The full library, with downloads,
        imports, behaviour profiles and automatic routing, follows in Milestone 11.
      </EmptyState>
    </Page>
  );
}

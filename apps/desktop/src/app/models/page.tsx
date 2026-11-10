import type { Metadata } from "next";

import { ModelLibrary } from "@/components/models/model-library";
import { Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Model Library" };

export default function ModelsPage() {
  return (
    <Page className="max-w-6xl">
      <PageHeader
        title="Model Library"
        description="Every local model in one place, from Ollama, llama.cpp or Hugging Face, with its licence, size, memory needs and evaluated behaviour. Add models, route messages to the right one, and set behaviour profiles."
      />
      <ModelLibrary />
    </Page>
  );
}

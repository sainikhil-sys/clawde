import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";

import { EmptyState, Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Research Studio" };

export default function ResearchPage() {
  return (
    <Page>
      <PageHeader
        title="Research Studio"
        description="Manage datasets, experiment with tokenizers, train small models and fine-tune with LoRA. Training runs, logs, checkpoints and evaluations are tracked so results are reproducible."
      />
      <EmptyState icon={FlaskConical} title="No experiments yet" milestone={12}>
        This computer has no CUDA GPU, so training runs on the CPU. Small models (up to about 20M parameters) and LoRA
        on base models around 0.5B parameters are practical here.
      </EmptyState>
    </Page>
  );
}

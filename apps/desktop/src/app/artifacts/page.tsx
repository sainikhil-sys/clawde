import type { Metadata } from "next";
import { Shapes } from "lucide-react";

import { EmptyState, Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Artifacts" };

export default function ArtifactsPage() {
  return (
    <Page>
      <PageHeader
        title="Artifacts"
        description="HTML, React, SVG, Markdown, Mermaid diagrams and charts created in conversations, with live preview, a source editor and version history."
      />
      <EmptyState icon={Shapes} title="No artifacts yet" milestone={9}>
        Artifacts are created from conversations. Previews will run in an isolated sandbox on a separate origin, so
        generated code can never reach your data or this app.
      </EmptyState>
    </Page>
  );
}

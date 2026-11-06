import type { Metadata } from "next";

import { ArtifactsIndex } from "@/components/artifacts/artifacts-index";
import { Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Artifacts" };

export default function ArtifactsPage() {
  return (
    <Page className="max-w-5xl">
      <PageHeader
        title="Artifacts"
        description="Web pages, React components, SVG, Markdown, Mermaid diagrams, charts and code from your conversations, with live preview, a source editor and version history. Previews run in an isolated sandbox on a separate origin, with no network access."
      />
      <ArtifactsIndex />
    </Page>
  );
}

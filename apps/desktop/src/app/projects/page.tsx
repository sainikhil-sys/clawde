import type { Metadata } from "next";
import { FolderKanban } from "lucide-react";

import { EmptyState, Page, PageHeader } from "@/components/page/page";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Group conversations around a goal, with their own instructions, uploaded knowledge and memory. Each project's documents and retrieval index stay isolated from the others."
      />
      <EmptyState icon={FolderKanban} title="No projects yet" milestone={7}>
        Creating projects needs the local API and document processing. You&apos;ll be able to add instructions, upload
        files and search across a project&apos;s knowledge.
      </EmptyState>
    </Page>
  );
}

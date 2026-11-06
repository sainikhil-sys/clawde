import type { Metadata } from "next";

import { Page, PageHeader } from "@/components/page/page";
import { ProjectsIndex } from "@/components/projects/projects-index";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <Page className="max-w-5xl">
      <PageHeader
        title="Projects"
        description="Group chats around a goal, with shared instructions and knowledge files. Each project's files and search index are kept separate from every other project."
      />
      <ProjectsIndex />
    </Page>
  );
}

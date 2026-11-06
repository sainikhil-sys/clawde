import { Suspense } from "react";

import { Page } from "@/components/page/page";
import { ProjectView } from "@/components/projects/project-view";

export const metadata = { title: "Project" };

export default function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  return (
    <Page className="max-w-6xl">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading project…</p>}>
        {params.then(({ id }) => (
          <ProjectView key={id} projectId={id} />
        ))}
      </Suspense>
    </Page>
  );
}

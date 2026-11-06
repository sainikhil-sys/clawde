import Link from "next/link";
import { Suspense } from "react";

import { ArtifactViewer } from "@/components/artifacts/artifact-viewer";

export const metadata = { title: "Artifact" };

export default function ArtifactPage({ params }: PageProps<"/artifacts/[id]">) {
  return (
    <div className="flex h-full flex-col">
      <nav className="shrink-0 border-b px-4 py-2 text-sm">
        <Link href="/artifacts" className="text-muted-foreground hover:text-foreground hover:underline">
          ← All artifacts
        </Link>
      </nav>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading artifact…</p>}>
          {params.then(({ id }) => (
            <ArtifactViewer key={id} artifactId={id} variant="page" />
          ))}
        </Suspense>
      </div>
    </div>
  );
}

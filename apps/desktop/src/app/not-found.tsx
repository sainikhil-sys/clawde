import Link from "next/link";

import { Page } from "@/components/page/page";

export default function NotFound() {
  return (
    <Page className="max-w-xl">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-2 font-heading text-3xl font-medium tracking-tight">This page doesn&apos;t exist</h1>
      <p className="mt-3 text-muted-foreground">The address may be mistyped, or the page may have been removed.</p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to new chat
      </Link>
    </Page>
  );
}

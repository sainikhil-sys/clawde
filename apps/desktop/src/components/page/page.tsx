import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export { Page } from "./page-motion";

export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-8">
      <h1 className="font-heading text-3xl font-medium tracking-tight text-balance sm:text-[2.1rem]">{title}</h1>
      <p className="mt-2 max-w-2xl text-[0.95rem] leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

/**
 * Shown when a section has no data. `milestone` states plainly when the capability is built,
 * so the UI never implies a feature exists before it does.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  milestone,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  milestone?: number;
}) {
  return (
    <section className="rounded-lg border border-dashed px-6 py-12 text-center sm:px-12">
      <Icon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
      <h2 className="mt-4 text-base font-medium">{title}</h2>
      <div className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{children}</div>
      {milestone !== undefined && (
        <p className="mt-5 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">
          Planned for Milestone {milestone}
        </p>
      )}
    </section>
  );
}

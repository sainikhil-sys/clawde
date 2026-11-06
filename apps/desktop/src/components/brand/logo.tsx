import { cn } from "@/lib/utils";

/** Clawde mark: three offset arcs. Uses currentColor so it follows the surrounding text color. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      aria-hidden="true"
      className={cn("size-5", className)}
    >
      <path d="M6.5 18.5C4.6 14.6 5.4 9.2 9 5.5" />
      <path d="M11 19.5C9.2 15.4 10 9.6 13.6 5.8" />
      <path d="M15.6 18.8C13.9 15 14.6 10.2 17.8 7" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("font-serif text-[1.15rem] font-medium tracking-tight", className)}>Clawde</span>;
}

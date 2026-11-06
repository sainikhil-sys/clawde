import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { LogoMark } from "@/components/brand/logo";
import { Page } from "@/components/page/page";
import { ApiStatusLine } from "@/components/status/api-status";

const NEXT_STEPS = [
  { milestone: 4, text: "Streaming responses from the models already installed in Ollama." },
  { milestone: 5, text: "Full conversation view: history, editing, regenerating and export." },
  { milestone: 6, text: "Attach PDFs, documents, spreadsheets, code and images to a conversation." },
];

export default function NewChatPage() {
  return (
    <Page className="flex min-h-full max-w-2xl flex-col justify-center">
      <LogoMark className="size-8 text-primary" />
      <h1 className="mt-6 font-heading text-4xl font-medium tracking-tight text-balance">
        What would you like to work on?
      </h1>
      <p className="mt-4 leading-relaxed text-muted-foreground">
        Clawde runs entirely on this computer. The conversation composer appears here once model streaming is connected
        in the next milestone. Until then, there is no chat to send to.
      </p>
      <ApiStatusLine className="mt-4" />

      <section aria-labelledby="next-heading" className="mt-10 rounded-lg border bg-card p-5">
        <h2 id="next-heading" className="text-sm font-medium">
          Coming next
        </h2>
        <ol className="mt-3 space-y-2.5">
          {NEXT_STEPS.map((step) => (
            <li key={step.milestone} className="flex gap-3 text-sm">
              <span className="w-6 shrink-0 font-mono text-xs leading-5 text-muted-foreground">M{step.milestone}</span>
              <span className="leading-5">{step.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <Link
        href="/models"
        className="mt-6 inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        See how models will be managed
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </Page>
  );
}

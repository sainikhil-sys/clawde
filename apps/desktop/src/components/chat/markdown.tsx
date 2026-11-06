"use client";

import { memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { CopyButton } from "./copy-button";

/** Plain text of a React node tree (used to copy highlighted code, which arrives as nested spans). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const code = Array.isArray(children) ? children[0] : children;
  const className = (code as { props?: { className?: string } } | undefined)?.props?.className ?? "";
  const language = /language-([\w+#-]+)/.exec(className)?.[1];
  const text = textOf(children).replace(/\n$/, "");
  return (
    <div className="group/code my-4 overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex h-9 items-center justify-between border-b bg-muted/60 pr-1 pl-3 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? "text"}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre {...props} className="overflow-x-auto p-3 font-mono text-[0.85rem] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  code({ className, children, ...props }) {
    // Fenced blocks are wrapped by `pre` above; inline code gets a subtle chip.
    const isBlock = /language-|hljs/.test(className ?? "");
    return (
      <code
        {...props}
        className={cn(isBlock ? className : "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]", className)}
      >
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th: ({ children }) => <th className="border-b px-3 py-2 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
  // Images in model output are not loaded: they could point anywhere and leak that the page was viewed.
  img: ({ alt, src }) => (
    <span className="text-sm text-muted-foreground">
      [image{alt ? `: ${alt}` : ""}
      {typeof src === "string" ? ` (${src})` : ""}]
    </span>
  ),
};

/**
 * Renders model output as Markdown (GitHub-flavoured) with highlighted code.
 * Raw HTML in the source is not rendered (react-markdown escapes it), so model output can't inject markup.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="prose-clawde">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

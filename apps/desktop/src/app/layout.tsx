import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@fontsource-variable/newsreader";
import "./globals.css";

import { AppShell } from "@/components/shell/app-shell";
import { preferenceBootScript } from "@/lib/preferences";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { default: "Clawde", template: "%s · Clawde" },
  description: "Local-first AI assistant running on your own open-weight models.",
  applicationName: "Clawde",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1a18" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Theme class and sidebar attribute are set by the boot script before hydration.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(GeistSans.variable, GeistMono.variable, "h-full antialiased")}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: preferenceBootScript }} />
      </head>
      <body className="h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

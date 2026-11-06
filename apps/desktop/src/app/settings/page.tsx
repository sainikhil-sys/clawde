import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Page, PageHeader } from "@/components/page/page";
import { ThemeSetting } from "@/components/settings/theme-setting";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { APP_VERSION } from "@/lib/app";
import { SHORTCUTS } from "@/lib/shortcuts";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" description="Preferences for this device." />

      <div className="divide-y border-y">
        <SettingsSection title="Appearance" description="Saved in this browser only.">
          <ThemeSetting />
        </SettingsSection>

        <SettingsSection title="Keyboard shortcuts" description="On macOS, use Cmd instead of Ctrl.">
          <dl className="space-y-3">
            {SHORTCUTS.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-4 text-sm">
                <dt>{s.description}</dt>
                <dd>
                  <KbdGroup>
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </KbdGroup>
                </dd>
              </div>
            ))}
          </dl>
        </SettingsSection>

        <SettingsSection title="Privacy" description="How this build handles your data.">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
            <li>The interface loads no external resources. Fonts and icons are bundled with the app.</li>
            <li>No analytics or telemetry is collected. Next.js framework telemetry is disabled in the scripts.</li>
            <li>
              Only your theme and sidebar preferences are stored, in this browser&apos;s local storage. Conversations
              and other data will live in a local database once the API arrives in Milestone 3.
            </li>
          </ul>
        </SettingsSection>

        <SettingsSection title="About">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono">{APP_VERSION}</dd>
            <dt className="text-muted-foreground">Build stage</dt>
            <dd>Milestone 2: interface foundation</dd>
          </dl>
        </SettingsSection>
      </div>
    </Page>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-8">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div>{children}</div>
    </section>
  );
}

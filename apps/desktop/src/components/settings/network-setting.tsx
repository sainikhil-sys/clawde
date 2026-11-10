"use client";

import Link from "next/link";

import { useAppSettings, useUpdateSettings } from "@/hooks/use-chat";

/** The single switch for internet access. Off by default; every download is checked against it and audited. */
export function NetworkSetting() {
  const settings = useAppSettings();
  const update = useUpdateSettings();
  const enabled = settings.data?.network_access_enabled ?? false;
  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={enabled}
          disabled={!settings.data || update.isPending}
          onChange={(e) => update.mutate({ network_access_enabled: e.target.checked })}
        />
        <span>
          <span className="block font-medium">Allow internet access for downloads</span>
          <span className="block text-muted-foreground">
            Needed only to download models (Ollama library, Hugging Face) and the Docker image for the Python sandbox.
            Chats, files, memory, artifacts and agents never use the internet. Each download is recorded in the activity
            log below.
          </span>
        </span>
      </label>
      <p className="text-xs text-muted-foreground">
        {enabled ? (
          <>
            On. Downloads are started from the{" "}
            <Link href="/models" className="underline">
              Model Library
            </Link>{" "}
            and the{" "}
            <Link href="/agents" className="underline">
              Agents
            </Link>{" "}
            page.
          </>
        ) : (
          "Off: nothing in the app can reach the internet."
        )}
      </p>
    </div>
  );
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/models",
}));

import { GenerationSettings } from "@/components/chat/generation-settings";
import { DEFAULT_PARAMS } from "@/hooks/use-chat";
import { resetSession } from "@/lib/api";

import { EvalSummaryView } from "./evaluations";
import { ModelLibrary } from "./model-library";

const GB = 1024 ** 3;
const MODEL = {
  id: "ollama:llama3.2:latest",
  provider: "ollama",
  provider_ref: "llama3.2:latest",
  display_name: "llama3.2:latest",
  family: "llama",
  parameter_size: "3.2B",
  quantization: "Q4_K_M",
  format: "gguf",
  size_bytes: 2 * GB,
  context_length: 131072,
  capabilities: ["completion", "tools"],
  available: true,
  chat: true,
  last_synced_at: "",
  architecture: "llama",
  parameter_count: 3_212_749_888,
  license: "LLAMA 3.2 COMMUNITY LICENSE AGREEMENT",
  estimated_ram_bytes: 2.5 * GB,
  estimate_exact: true,
  fit_now: "fits",
  fit_total: "fits",
  loaded: true,
  evaluation: {
    run_id: "e1",
    instruction: { title: "Instruction following", kind: "capability", passed: 5, total: 6, errors: 0, score: 0.833 },
    refusal: {
      title: "Refusal behaviour",
      kind: "behaviour",
      passed: 9,
      total: 10,
      errors: 0,
      score: 0.9,
      over_refusal: 0.167,
      under_refusal: 0,
      method: "refusal-phrase heuristic",
    },
    speed: { tokens_per_s: 12.5, first_token_ms: 400 },
  },
};
const BIG = {
  ...MODEL,
  id: "ollama:big:70b",
  display_name: "big:70b",
  loaded: false,
  fit_now: "wont_fit",
  fit_total: "wont_fit",
  evaluation: null,
  license: null,
};

let settings = { network_access_enabled: false, default_model: null };
const calls: { path: string; method: string; body: unknown }[] = [];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ path: u.pathname, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      if (u.pathname === "/api/health")
        return Response.json({ status: "ok", version: "0.1.0", database: { status: "ok" } });
      if (u.pathname === "/api/session") return Response.json({ csrf_token: "tok", created_at: "", expires_at: "" });
      if (u.pathname === "/api/settings") return Response.json(settings);
      if (u.pathname === "/api/models")
        return Response.json({
          models: [MODEL, BIG],
          providers: [
            { name: "ollama", status: "ok", message: null, model_count: 2 },
            { name: "transformers", status: "ok", message: null, model_count: 0 },
          ],
        });
      if (u.pathname === "/api/models/system/hardware")
        return Response.json({
          ram_total: 16 * GB,
          ram_available: 4 * GB,
          ram_used_percent: 75,
          cpu_percent: 12,
          cpu_count: 18,
          gpu_percent: null,
          gpu_note: "GPU counters aren't available.",
          loaded: [{ model_id: MODEL.id, bytes: 2.7 * GB }],
        });
      if (u.pathname === "/api/models/system/routing")
        return Response.json({ tasks: ["chat", "code"], assignments: {}, keep_one_model_loaded: true });
      if (u.pathname === "/api/models/system/routing/preview")
        return Response.json({
          mode: "auto",
          task: "code",
          model_id: MODEL.id,
          reason: "the message looks like a programming question; the largest capable model that fits in free memory",
          considered: [
            { model_id: MODEL.id, fit: "fits", estimate_bytes: 2.5 * GB },
            { model_id: BIG.id, fit: "wont_fit", estimate_bytes: 40 * GB },
          ],
        });
      if (u.pathname.endsWith("/detail"))
        return Response.json({
          ...MODEL,
          license_text: "LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\nfull terms",
          details: { layers: 28, head_count: 24, head_count_kv: 8 },
        });
      if (u.pathname === "/api/profiles" && method === "POST")
        return Response.json(
          {
            id: "p1",
            ...(JSON.parse(init.body as string) as object),
            created_at: "",
            updated_at: "",
            used_by: { models: 0, projects: 0, conversations: 0 },
          },
          { status: 201 },
        );
      if (u.pathname === "/api/profiles") return Response.json([]);
      return new Response(null, { status: 404 });
    }),
  );
}

function renderWith(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("model library", () => {
  beforeEach(() => {
    calls.length = 0;
    settings = { network_access_enabled: false, default_model: null };
    resetSession();
    stub();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists models with licence, memory fit and evaluation, and shows hardware", async () => {
    const user = userEvent.setup();
    renderWith(<ModelLibrary />);
    const list = await screen.findByRole("list", { name: "Installed models" });
    const [small, big] = within(list).getAllByRole("listitem");
    expect(small).toHaveTextContent("LLAMA 3.2 COMMUNITY LICENSE AGREEMENT");
    expect(small).toHaveTextContent("2.5 GB");
    expect(small).toHaveTextContent("Fits");
    expect(small).toHaveTextContent("Loaded");
    expect(small).toHaveTextContent("Instruction following 83%");
    expect(small).toHaveTextContent("Over-refusal 17%, under-refusal 0%");
    expect(big).toHaveTextContent("Won't fit");
    expect(big).toHaveTextContent("Too large for this computer's memory.");
    expect(big).toHaveTextContent("Not stated");
    expect(big).toHaveTextContent("Not evaluated yet");
    expect(screen.getByRole("region", { name: "Hardware" })).toHaveTextContent("4.0 GB free of 16.0 GB");
    expect(screen.getByRole("region", { name: "Hardware" })).toHaveTextContent("Not measured");

    await user.click(within(small).getByRole("button"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("LLAMA 3.2 COMMUNITY LICENSE AGREEMENT")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Show full licence" }));
    expect(within(dialog).getByText(/full terms/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/unrestricted|uncensored/i);
  });

  it("disables downloads while network access is off", async () => {
    const user = userEvent.setup();
    renderWith(<ModelLibrary />);
    await user.click(await screen.findByRole("tab", { name: "Add models" }));
    expect(await screen.findByText(/Downloading needs internet access, which is off/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Ollama model name"), "qwen2.5:0.5b");
    const pull = within(screen.getByRole("region", { name: "From the Ollama library" })).getByRole("button", {
      name: "Download",
    });
    expect(pull).toBeDisabled();
    expect(calls.some((c) => c.path === "/api/models/pull")).toBe(false);
  });

  it("previews which model Auto would choose, and why", async () => {
    const user = userEvent.setup();
    renderWith(<ModelLibrary />);
    await user.click(await screen.findByRole("tab", { name: "Routing" }));
    await user.type(await screen.findByLabelText("Message to route"), "fix my python bug");
    await user.click(screen.getByRole("button", { name: "Show choice" }));
    const decision = await screen.findByLabelText("Routing decision");
    expect(decision).toHaveTextContent("llama3.2 for a code message");
    expect(decision).toHaveTextContent("largest capable model that fits");
    expect(decision).toHaveTextContent("Won't fit");
  });

  it("creates a behaviour profile", async () => {
    const user = userEvent.setup();
    renderWith(<ModelLibrary />);
    await user.click(await screen.findByRole("tab", { name: "Behaviour profiles" }));
    await user.click(await screen.findByRole("button", { name: "New profile" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Terse");
    await user.type(within(dialog).getByLabelText("Instructions"), "One sentence answers.");
    await user.type(within(dialog).getByLabelText("Temperature"), "0.2");
    await user.click(within(dialog).getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.path === "/api/profiles")).toBeDefined());
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/profiles")?.body).toMatchObject({
      name: "Terse",
      system_prompt: "One sentence answers.",
      temperature: 0.2,
      max_tokens: null,
    });
  });

  it("reports capabilities and behaviour separately, without safety claims", () => {
    renderWith(<EvalSummaryView summary={MODEL.evaluation} />);
    expect(screen.getByLabelText("Capabilities")).toHaveTextContent("Instruction following5/6");
    const behaviour = screen.getByLabelText("Behaviour");
    expect(behaviour).toHaveTextContent("Declined reasonable requests17%");
    expect(behaviour).toHaveTextContent("Went along with clearly harmful requests0%");
    expect(behaviour).toHaveTextContent("not a safety rating");
  });

  it("generation settings explain defaults versus custom settings", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const onProfileChange = vi.fn();
    const { rerender } = renderWith(
      <GenerationSettings
        params={DEFAULT_PARAMS}
        onChange={vi.fn()}
        maxContext={null}
        custom={false}
        onReset={onReset}
        profiles={[{ id: "p1", name: "Terse" } as never]}
        profileId={null}
        onProfileChange={onProfileChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Generation settings" }));
    expect(screen.getByText(/Using the chat's behaviour profile, or the app defaults/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use defaults" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Behaviour profile for this chat"), "p1");
    expect(onProfileChange).toHaveBeenCalledWith("p1");
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <GenerationSettings params={DEFAULT_PARAMS} onChange={vi.fn()} maxContext={null} custom onReset={onReset} />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Use defaults" }));
    expect(onReset).toHaveBeenCalled();
  });
});

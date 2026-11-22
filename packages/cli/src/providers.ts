import {
  AnthropicProvider,
  LlmGateway,
  OpenAiCompatibleProvider,
  type GatewayOptions,
  type LlmProvider,
} from "@vivahlens/core";

export interface ProviderChoice {
  provider: string;
  model: string;
  baseUrl?: string;
  maxCostUsd?: number;
  /** Gemini only: the user confirms their project is on paid billing (free-tier data can be used for training/review). */
  confirmedPaidTier?: boolean;
}

/** One-time data-handling disclosure per provider, from the provider terms checked in docs/research (see platform note §2). */
export function providerNotice(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return "OpenAI: API data is not used for training by default; abuse-monitoring logs are kept up to 30 days, and image inputs flagged by its safety scan are retained even under zero data retention.";
    case "anthropic":
      return "Anthropic: inputs and outputs are deleted within 30 days (longer if flagged for policy violations); API data is not used for training.";
    case "gemini":
      return "Gemini: paid-tier data is not used to improve products, but project logs are on by default for new projects (55 days). Free-tier keys can be used for training and human review.";
    case "azure":
      return "Azure OpenAI: requests are processed in your own Azure resource under your Microsoft agreement; check that resource's data-retention and abuse-monitoring settings. Azure's content filter may decline some photos, which then fail one by one.";
    case "ollama":
    case "mock":
      return undefined;
    default:
      return "This endpoint's data handling is not known to VivahLens. Check its retention and training policy before sending client photos.";
  }
}

/** Offline stand-in so the whole pipeline can be exercised without an API key or any data leaving the machine. */
export class MockProvider implements LlmProvider {
  readonly id = "mock";
  readonly local = true;
  async complete(req: Parameters<LlmProvider["complete"]>[0]) {
    const system = req.messages.find((m) => m.role === "system")?.content;
    const text = typeof system === "string" ? this.reply(system) : "{}";
    return { text, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  private reply(system: string): string {
    if (system.includes("film editor")) {
      // Deterministic "storytelling" order for the video pipeline: the reverse of capture order.
      const n = Number(/You will see (\d+) shots/.exec(system)?.[1] ?? 0);
      return JSON.stringify({ order: Array.from({ length: n }, (_, i) => n - 1 - i), labels: Array.from({ length: n }, (_, i) => `scene ${i}`) });
    }
    const style = { exposure: 0.3, contrast: 12, shadows: 15, whiteBalance: { tempK: 5400 } };
    return system.includes("analyze a photographer")
      ? JSON.stringify({ summary: "mock style: warm, slightly lifted shadows", baseAdjustments: style })
      : JSON.stringify({ adjustments: style, confidence: 0.5, notes: "mock" });
  }
}

/** Keys come from the environment for now; the desktop app will move them to the OS keychain. */
export function buildGateway(choice: ProviderChoice, env: Record<string, string | undefined>, extra: Pick<GatewayOptions, "onTransfer" | "onCall" | "prices"> = {}): LlmGateway {
  const gateway = new LlmGateway({ maxCostUsd: choice.maxCostUsd, retry: { attempts: 3, baseDelayMs: 1000 }, ...extra });
  let provider: LlmProvider;
  switch (choice.provider) {
    case "mock":
      provider = new MockProvider();
      break;
    case "openai":
      provider = new OpenAiCompatibleProvider({ id: "openai", baseUrl: choice.baseUrl ?? "https://api.openai.com/v1", apiKey: requireKey(env, "OPENAI_API_KEY") });
      break;
    case "anthropic":
      provider = new AnthropicProvider({ apiKey: requireKey(env, "ANTHROPIC_API_KEY"), baseUrl: choice.baseUrl });
      break;
    case "gemini":
      if (!choice.confirmedPaidTier) {
        throw new Error(
          "Gemini free-tier data may be used for training and human review, which is not acceptable for client photos. " +
            "If your Google project has paid billing enabled, confirm with --confirm-paid-tier.",
        );
      }
      provider = new OpenAiCompatibleProvider({
        id: "gemini",
        baseUrl: choice.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: requireKey(env, "GEMINI_API_KEY"),
      });
      break;
    case "ollama":
      provider = new OpenAiCompatibleProvider({ id: "ollama", baseUrl: choice.baseUrl ?? "http://localhost:11434/v1" });
      break;
    case "azure":
      if (!choice.baseUrl) throw new Error("--base-url is required for --provider azure, e.g. https://<resource>.openai.azure.com/openai/v1 (and --model is your deployment name)");
      provider = new OpenAiCompatibleProvider({ id: "azure", baseUrl: choice.baseUrl, apiKey: requireKey(env, "AZURE_OPENAI_API_KEY"), authHeader: "api-key" });
      break;
    case "openai-compatible":
      if (!choice.baseUrl) throw new Error("--base-url is required for --provider openai-compatible");
      provider = new OpenAiCompatibleProvider({ id: "openai-compatible", baseUrl: choice.baseUrl, apiKey: env.VIVAH_API_KEY });
      break;
    default:
      throw new Error(`Unknown provider "${choice.provider}". Use mock, openai, anthropic, gemini, azure, ollama or openai-compatible.`);
  }
  return gateway.registerProvider(provider).setRoute("vision", { providerId: provider.id, model: choice.model });
}

function requireKey(env: Record<string, string | undefined>, name: string): string {
  const key = env[name];
  if (!key) throw new Error(`${name} is not set`);
  return key;
}

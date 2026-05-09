import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
:
export default function (pi: ExtensionAPI) {
  pi.registerProvider("coreinfra", {
    baseUrl: "https://hub.coreinfra.ai/codex/api/v1",
    apiKey: "COREINFRA_API_KEY",
    api: "openai-responses",
    authHeader: true,
    models: [
      {
        id: "gpt-5.3-codex",
        name: "CoreInfra Codex",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 200.16,
          output: 1601.25,
          cacheRead: 20.02,
          cacheWrite: 0.0,
        },
        contextWindow: 200000,
        maxTokens: 50000,
      },
      {
        id: "gpt-5.4",
        name: "CoreInfra GPT 5.4",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 279.71,
          output: 1678.28,
          cacheRead: 27.97,
          cacheWrite: 0.0,
        },
        contextWindow: 200000,
        maxTokens: 50000,
      },
      {
        id: "gpt-5.5",
        name: "CoreInfra GPT 5.5",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 566.47,
          output: 3398.85,
          cacheRead: 56.65,
          cacheWrite: 0.0,
        },
        contextWindow: 200000,
        maxTokens: 50000,
      },
    ]
  });
}

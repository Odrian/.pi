import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_CACHE_MS = 60 * 1000;
const STATUS_ID = "provider-usage";

type UsageWindow = { label: string; usedPercent: number; resetsAt?: number };
type UsageSnapshot = { windows: UsageWindow[]; capturedAt: number };

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWindow(value: unknown, fallbackLabel: string): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const usedPercent = numberValue(object.used_percent);
  if (usedPercent === undefined) return undefined;
  const duration = numberValue(object.limit_window_seconds);
  const label = duration
    ? duration <= 6 * 60 * 60
      ? `${Math.round(duration / 3600)}h`
      : `${Math.round(duration / 86400)}d`
    : fallbackLabel;
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: numberValue(object.reset_at),
  };
}

function parseUsage(payload: unknown): UsageSnapshot {
  if (!payload || typeof payload !== "object") {
    throw new Error("Usage endpoint returned an invalid response");
  }
  const root = payload as Record<string, unknown>;
  const rateLimit = root.rate_limit as Record<string, unknown> | undefined;
  const windows = [
    parseWindow(rateLimit?.primary_window, "5h"),
    parseWindow(rateLimit?.secondary_window, "7d"),
  ].filter((window): window is UsageWindow => window !== undefined);
  if (windows.length === 0) {
    throw new Error("Usage endpoint returned no rate-limit windows");
  }
  return { windows, capturedAt: Date.now() };
}

function formatReset(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return `, reset ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function statusText(snapshot: UsageSnapshot): string {
  return `codex ${snapshot.windows
    .map((window) => `${window.usedPercent.toFixed(0)}% ${window.label}`)
    .join(" · ")}`;
}

function usageReport(snapshot: UsageSnapshot): string {
  return [
    "OpenAI Codex usage",
    ...snapshot.windows.map(
      (window) =>
        `${window.label}: ${window.usedPercent.toFixed(0)}% used, ${(100 - window.usedPercent).toFixed(0)}% left${formatReset(window.resetsAt)}`,
    ),
  ].join("\n");
}

async function fetchUsage(ctx: ExtensionContext, signal: AbortSignal): Promise<UsageSnapshot> {
  const model =
    ctx.model?.provider === PROVIDER_ID
      ? ctx.model
      : ctx.modelRegistry
          .getAvailable()
          .find((candidate) => candidate.provider === PROVIDER_ID);
  if (!model) throw new Error("OpenAI Codex model is unavailable; run /login");

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  signal.throwIfAborted();
  if (!resolved.ok) throw new Error(resolved.error);
  const headers = new Headers();
  for (const [name, value] of Object.entries(resolved.headers ?? {})) {
    // This request goes to chatgpt.com, not the CoreInfra inference gateway.
    // Never forward the gateway credential to an unrelated host.
    if (name.toLowerCase() === "x-coreinfra-api-key") continue;
    if (typeof value === "string") headers.set(name, value);
  }
  if (!headers.has("authorization") && resolved.apiKey) {
    headers.set("authorization", `Bearer ${resolved.apiKey}`);
  }
  headers.set("accept", "application/json");
  headers.set("user-agent", "pi-codex-usage");

  const response = await fetch(USAGE_URL, {
    headers,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Usage endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return parseUsage(JSON.parse(text));
}

export default function codexUsage(pi: ExtensionAPI) {
  let usage: UsageSnapshot | undefined;
  let usageRequest: Promise<UsageSnapshot> | undefined;
  let lifetime = new AbortController();

  const refreshUsage = async (
    ctx: ExtensionContext,
    force = false,
  ): Promise<UsageSnapshot> => {
    if (!force && usage && Date.now() - usage.capturedAt < USAGE_CACHE_MS) return usage;
    if (usageRequest) return usageRequest;
    const signal = lifetime.signal;
    const request = fetchUsage(ctx, signal)
      .then((snapshot) => {
        signal.throwIfAborted();
        usage = snapshot;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, statusText(snapshot));
        return snapshot;
      })
      .finally(() => {
        if (usageRequest === request) usageRequest = undefined;
      });
    usageRequest = request;
    return request;
  };

  const refreshInBackground = (ctx: ExtensionContext, force = false) => {
    if (ctx.model?.provider !== PROVIDER_ID) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const signal = lifetime.signal;
    void refreshUsage(ctx, force).catch(() => {
      if (signal.aborted) return;
      if (!usage && ctx.hasUI) ctx.ui.setStatus(STATUS_ID, "codex usage unavailable");
    });
  };

  pi.on("session_start", (_event, ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    usageRequest = undefined;
    refreshInBackground(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    if (event.model.provider === PROVIDER_ID) refreshInBackground(ctx);
    else if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
  });
  pi.on("agent_settled", (_event, ctx) => refreshInBackground(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    lifetime.abort();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
  });

  pi.registerCommand("usage", {
    description: "Show OpenAI Codex subscription usage",
    getArgumentCompletions: (prefix) =>
      "--refresh".startsWith(prefix.trim())
        ? [
            {
              value: "--refresh",
              label: "--refresh",
              description: "Bypass the 3-minute cache",
            },
          ]
        : null,
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument && argument !== "--refresh") {
        ctx.ui.notify("Usage: /usage [--refresh]", "warning");
        return;
      }
      const signal = lifetime.signal;
      try {
        const snapshot = await refreshUsage(ctx, argument === "--refresh");
        if (signal.aborted) return;
        ctx.ui.notify(usageReport(snapshot), "info");
      } catch (error) {
        if (signal.aborted) return;
        ctx.ui.notify(
          `Usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

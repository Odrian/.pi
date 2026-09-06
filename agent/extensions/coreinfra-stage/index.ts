import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input } from "@earendil-works/pi-tui";
import { fetch as proxyFetch, ProxyAgent } from "undici";

const PROVIDER_ID = "openai-codex";
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "coreinfra-stage.json");
const BASE_URL =
  "https://stage.hub.coreinfra.ai/openai/subscription/api/v1";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESPONSES_PATH = "/openai/subscription/api/v1/codex/responses";
const RESPONSES_PATH = "/openai/subscription/api/v1/responses";
const FETCH_PATCH_KEY = Symbol.for("coreinfra-stage.responses-fetch-patch");
const USAGE_CACHE_MS = 3 * 60 * 1000;

type Config = { token: string };
type UsageWindow = { label: string; usedPercent: number; resetsAt?: number };
type UsageSnapshot = { windows: UsageWindow[]; capturedAt: number };
type FetchPatchState = {
  original: typeof globalThis.fetch;
  patched: typeof globalThis.fetch;
};

async function ensureConfig(): Promise<Config | undefined> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    await chmod(CONFIG_PATH, 0o600);
    const parsed = JSON.parse(raw) as Partial<Config>;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    return token ? { token } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Cannot read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await writeFile(CONFIG_PATH, '{\n  "token": ""\n}\n', { mode: 0o600 });
    await chmod(CONFIG_PATH, 0o600);
    return undefined;
  }
}

async function saveToken(token: string): Promise<void> {
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ token }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
}

class SecretInput extends Input {
  override render(width: number): string[] {
    const available = Math.max(0, width - 2);
    const length = Array.from(this.getValue()).length;
    const hiddenPrefix = length > available;
    const visibleLength = Math.min(
      length,
      Math.max(0, available - (hiddenPrefix ? 1 : 0)),
    );
    const masked = `${hiddenPrefix ? "…" : ""}${"•".repeat(visibleLength)}`;
    return [`> ${masked}${this.focused ? CURSOR_MARKER : ""}`];
  }
}

function installResponsesRouteRewrite(): () => void {
  const globals = globalThis as typeof globalThis & {
    [FETCH_PATCH_KEY]?: FetchPatchState;
  };
  const existing = globals[FETCH_PATCH_KEY];
  if (existing) return () => {};

  const original = globalThis.fetch.bind(globalThis);
  const patched: typeof globalThis.fetch = (input, init) => {
    if (typeof input === "string" || input instanceof URL) {
      const url = new URL(input.toString());
      if (
        url.hostname === "stage.hub.coreinfra.ai" &&
        url.pathname === CODEX_RESPONSES_PATH
      ) {
        url.pathname = RESPONSES_PATH;
        const headers = new Headers(init?.headers);
        if (headers.get("content-encoding") === "zstd" && init?.body) {
          const decompressed = zstdDecompressSync(init.body as Uint8Array).toString(
            "utf8",
          );
          headers.delete("content-encoding");
          return original(url, { ...init, headers, body: decompressed });
        }
        return original(url, init);
      }
    }
    return original(input, init);
  };

  globalThis.fetch = patched;
  globals[FETCH_PATCH_KEY] = { original, patched };
  return () => {
    const state = globals[FETCH_PATCH_KEY];
    if (state?.patched === globalThis.fetch) globalThis.fetch = state.original;
    delete globals[FETCH_PATCH_KEY];
  };
}

function registerStageProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, { baseUrl: BASE_URL });
}

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

async function fetchUsage(
  ctx: ExtensionContext,
  proxyToken: string | undefined,
): Promise<UsageSnapshot> {
  const model =
    ctx.model?.provider === PROVIDER_ID
      ? ctx.model
      : ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === PROVIDER_ID);
  if (!model) throw new Error("OpenAI Codex model is unavailable; run /login");

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) throw new Error(resolved.error);
  const headers = new Headers();
  for (const [name, value] of Object.entries(resolved.headers ?? {})) {
    if (typeof value === "string" && name.toLowerCase() !== "x-coreinfra-api-key") {
      headers.set(name, value);
    }
  }
  if (!headers.has("authorization") && resolved.apiKey) {
    headers.set("authorization", `Bearer ${resolved.apiKey}`);
  }
  headers.set("accept", "application/json");
  headers.set("user-agent", "pi-coreinfra-stage");

  if (!proxyToken) throw new Error("CoreInfra stage token is missing");
  const proxyUrl = new URL("https://stage.proxy.hub.coreinfra.ai:443");
  proxyUrl.username = "coreinfra";
  proxyUrl.password = proxyToken;
  const dispatcher = new ProxyAgent(proxyUrl);

  try {
    const response = await proxyFetch(USAGE_URL, {
      headers: Object.fromEntries(headers.entries()),
      dispatcher,
      signal: ctx.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Usage endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    return parseUsage(JSON.parse(text));
  } finally {
    await dispatcher.close();
  }
}

export default async function coreInfraStage(pi: ExtensionAPI) {
  const removeFetchPatch = installResponsesRouteRewrite();
  const config = await ensureConfig();
  let currentToken = config?.token;
  let usage: UsageSnapshot | undefined;
  let usageRequest: Promise<UsageSnapshot> | undefined;

  if (currentToken) registerStageProvider(pi);
  else console.warn("[coreinfra-stage] Run /coreinfra-stage-login to save the token");

  // Add the Hub token only at the inference request boundary. This prevents
  // usage integrations and other OAuth consumers from forwarding it elsewhere.
  pi.on("before_provider_headers", (event, ctx) => {
    if (
      currentToken &&
      ctx.model?.provider === PROVIDER_ID &&
      ctx.model.baseUrl.startsWith(BASE_URL)
    ) {
      event.headers["x-coreinfra-api-key"] = currentToken;
    }
  });

  const refreshUsage = async (
    ctx: ExtensionContext,
    force = false,
  ): Promise<UsageSnapshot> => {
    if (!force && usage && Date.now() - usage.capturedAt < USAGE_CACHE_MS) return usage;
    if (usageRequest) return usageRequest;
    usageRequest = fetchUsage(ctx, currentToken)
      .then((snapshot) => {
        usage = snapshot;
        if (ctx.hasUI) {
          ctx.ui.setStatus("provider-usage", statusText(snapshot));
          ctx.ui.setWidget("coreinfra-stage-usage", undefined);
        }
        return snapshot;
      })
      .finally(() => {
        usageRequest = undefined;
      });
    return usageRequest;
  };

  const refreshInBackground = (ctx: ExtensionContext, force = false) => {
    if (ctx.model?.provider !== PROVIDER_ID) {
      ctx.ui.setStatus("provider-usage", undefined);
      ctx.ui.setWidget("coreinfra-stage-usage", undefined);
      return;
    }
    void refreshUsage(ctx, force).catch(() => {
      if (!usage && ctx.hasUI) {
        ctx.ui.setStatus("provider-usage", "codex usage unavailable");
        ctx.ui.setWidget("coreinfra-stage-usage", undefined);
      }
    });
  };

  pi.on("session_start", (_event, ctx) => refreshInBackground(ctx));
  pi.on("model_select", (event, ctx) => {
    if (event.model.provider === PROVIDER_ID) refreshInBackground(ctx);
    else {
      ctx.ui.setStatus("provider-usage", undefined);
      ctx.ui.setWidget("coreinfra-stage-usage", undefined);
    }
  });
  pi.on("agent_settled", (_event, ctx) => refreshInBackground(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("provider-usage", undefined);
    ctx.ui.setWidget("coreinfra-stage-usage", undefined);
    removeFetchPatch();
  });

  pi.registerCommand("usage", {
    description: "Show OpenAI Codex subscription usage",
    getArgumentCompletions: (prefix) =>
      "--refresh".startsWith(prefix.trim())
        ? [{ value: "--refresh", label: "--refresh", description: "Bypass the 3-minute cache" }]
        : null,
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument && argument !== "--refresh") {
        ctx.ui.notify("Usage: /usage [--refresh]", "warning");
        return;
      }
      try {
        const snapshot = await refreshUsage(ctx, argument === "--refresh");
        ctx.ui.notify(usageReport(snapshot), "info");
      } catch (error) {
        ctx.ui.notify(
          `Usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("coreinfra-stage-login", {
    description: "Save or update the CoreInfra stage token",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("This command requires interactive TUI mode", "error");
        return;
      }
      ctx.ui.notify("Enter the new CoreInfra stage token (input is masked)", "info");
      const token = await ctx.ui.custom<string | undefined>(
        (_tui, _theme, _keybindings, done) => {
          const input = new SecretInput();
          input.onSubmit = (value) => done(value);
          input.onEscape = () => done(undefined);
          return input;
        },
      );
      if (token === undefined) {
        ctx.ui.notify("Token update cancelled", "warning");
        return;
      }
      const normalized = token.trim();
      if (!normalized) {
        ctx.ui.notify("Token cannot be empty", "error");
        return;
      }
      await saveToken(normalized);
      currentToken = normalized;
      registerStageProvider(pi);
      ctx.ui.notify("CoreInfra stage token updated", "info");
    },
  });

  pi.registerCommand("coreinfra-stage-status", {
    description: "Show CoreInfra stage configuration status without revealing the token",
    handler: async (_args, ctx) => {
      const current = await ensureConfig();
      ctx.ui.notify(
        current
          ? `CoreInfra stage is configured (${CONFIG_PATH}, mode 0600)`
          : "CoreInfra token is missing; run /coreinfra-stage-login",
        current ? "info" : "warning",
      );
    },
  });
}

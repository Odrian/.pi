import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { CURSOR_MARKER, Input } from "@earendil-works/pi-tui";

const PROVIDER_ID = "openai-codex";
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "codex-proxy-coreinfra.json");
const BASE_URL =
  "https://stage.hub.coreinfra.ai/openai/subscription/api/v1";
const CHATGPT_HOST = "chatgpt.com";
const OPENAI_PROXY_URL = "https://stage.proxy.hub.coreinfra.ai:443";
const CODEX_RESPONSES_PATH = "/openai/subscription/api/v1/codex/responses";
const RESPONSES_PATH = "/openai/subscription/api/v1/responses";
const FETCH_PATCH_KEY = Symbol.for("codex-proxy-coreinfra.responses-fetch-patch");

type Config = { token: string };
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

function installFetchPatch(getOpenAIProxy: () => ProxyAgent | undefined): () => void {
  const globals = globalThis as typeof globalThis & {
    [FETCH_PATCH_KEY]?: FetchPatchState;
  };
  const existing = globals[FETCH_PATCH_KEY];
  if (existing) return () => {};

  const original = globalThis.fetch.bind(globalThis);
  const patched: typeof globalThis.fetch = (input, init) => {
    const rawUrl =
      typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);

    if (url.hostname === CHATGPT_HOST) {
      const dispatcher = getOpenAIProxy();
      if (dispatcher) {
        // Native Request objects are not accepted by the separately installed
        // undici package, so normalize them to URL + wire-level options.
        const request = new Request(input, init);
        const body = request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body;
        return undiciFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body,
          redirect: request.redirect,
          signal: request.signal,
          dispatcher,
          ...(body ? { duplex: "half" as const } : {}),
        }) as unknown as ReturnType<typeof globalThis.fetch>;
      }
    }

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

function registerStageProvider(pi: ExtensionAPI, token: string): void {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: BASE_URL,
    headers: { "x-coreinfra-api-key": token },
  });
}

function makeOpenAIProxyUrl(token: string): string {
  const url = new URL(OPENAI_PROXY_URL);
  url.username = "coreinfra";
  url.password = token;
  return url.toString();
}

export default async function codexProxyCoreInfra(pi: ExtensionAPI) {
  const config = await ensureConfig();
  let openAIProxy = config?.token
    ? new ProxyAgent(makeOpenAIProxyUrl(config.token))
    : undefined;
  const removeFetchPatch = installFetchPatch(() => openAIProxy);

  const replaceOpenAIProxy = (token: string) => {
    const previous = openAIProxy;
    openAIProxy = new ProxyAgent(makeOpenAIProxyUrl(token));
    void previous?.close();
  };

  if (config?.token) {
    registerStageProvider(pi, config.token);
  } else {
    console.warn(
      "[codex-proxy-coreinfra] Run /codex-proxy-coreinfra-login to save the token",
    );
  }

  pi.on("session_shutdown", async () => {
    removeFetchPatch();
    await openAIProxy?.close();
    openAIProxy = undefined;
  });

  pi.registerCommand("codex-proxy-coreinfra-login", {
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
      replaceOpenAIProxy(normalized);
      registerStageProvider(pi, normalized);
      ctx.ui.notify("CoreInfra stage token updated", "info");
    },
  });

  pi.registerCommand("codex-proxy-coreinfra-status", {
    description: "Show CoreInfra stage configuration status without revealing the token",
    handler: async (_args, ctx) => {
      const current = await ensureConfig();
      ctx.ui.notify(
        current
          ? `CoreInfra stage is configured (${CONFIG_PATH}, mode 0600)`
          : "CoreInfra token is missing; run /codex-proxy-coreinfra-login",
        current ? "info" : "warning",
      );
    },
  });
}

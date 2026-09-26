import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  enabled: true,
  title: "Pi",
  sound: "Glass",
  max_message_length: 180,
  ignore_nested_pi: true,
  suppress_when_active: true,
  events: {
    session_start: false,
    agent_start: false,
    agent_settled: true,
    tool_error: false,
    user_question: true,
    model_select: false,
    message_end: false,
    session_shutdown: false,
    thinking_level_select: false,
    session_compact: false,
  },
};

type Config = typeof DEFAULT_CONFIG;

const GLOBAL_DIR = join(homedir(), ".pi", "agent");
const EXTENSIONS_DIR = join(GLOBAL_DIR, "extensions");
const CONFIG_DIR = join(EXTENSIONS_DIR, "pi-macos-notify");
const CONFIG_PATH = join(CONFIG_DIR, "macos-notify.toml");
const FOCUS_ITERM_SCRIPT = join(CONFIG_DIR, "focus-iterm-session.sh");
const TERMINAL_NOTIFIER_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
];
const FOCUS_POLL_INTERVAL_MS = 500;
const DEFAULT_CONFIG_TOML = `enabled = true
title = "Pi"
sound = "Glass" # set "" for silent
max_message_length = 180
ignore_nested_pi = true # suppress when this Pi was launched by another Pi bash tool
suppress_when_active = true # suppress while focused; remove a delivered notification when focus returns

[events]
session_start = false
agent_start = false
agent_settled = true
tool_error = false
user_question = true
model_select = false
message_end = false # payload text, off by default
session_shutdown = false
thinking_level_select = false
session_compact = false
`;

function ensureDefaultConfig() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, DEFAULT_CONFIG_TOML);
}

function parseValue(raw: string): string | boolean | number {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value.replace(/^"|"$/g, "");
}

function applyConfig(config: Config, path: string) {
  let section: "root" | "events" = "root";
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const clean = line.replace(/\s+#.*$/, "").trim();
    if (!clean) continue;
    if (clean === "[events]") {
      section = "events";
      continue;
    }
    const match = clean.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;
    const [, key, raw] = match;
    const value = parseValue(raw);
    if (section === "events" && key in config.events && typeof value === "boolean") {
      config.events[key as keyof Config["events"]] = value;
    } else if (section === "root" && key in config && key !== "events") {
      (config as any)[key] = value;
    }
  }
}

function loadConfig(ctx?: ExtensionContext): Config {
  ensureDefaultConfig();
  const config = structuredClone(DEFAULT_CONFIG);
  const paths = [
    CONFIG_PATH,
    ctx?.isProjectTrusted() ? join(ctx.cwd, ".pi", "macos-notify.toml") : undefined,
    process.env.PI_MACOS_NOTIFY_CONFIG,
  ].filter(Boolean) as string[];

  for (const path of paths) if (existsSync(path)) applyConfig(config, path);
  return config;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string, max: number) {
  return max > 0 && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function questionText(input: unknown): string {
  const value = input as { question?: unknown; context?: unknown };
  return [value.context, value.question].filter((v) => typeof v === "string" && v.trim()).join("\n") || "Waiting for your answer";
}

export function isPermissionPrompt(input: unknown): boolean {
  return /permissions?.*required|required.*permissions?/i.test(questionText(input));
}

function isNestedPi() {
  return Boolean(process.env.PI_SESSION_ID || process.env.PI_SESSION_FILE);
}

function isIterm2() {
  return process.env.TERM_PROGRAM === "iTerm.app" || process.env.LC_TERMINAL === "iTerm2";
}

function getItermSessionId() {
  const terminalSession = process.env.ITERM_SESSION_ID ?? process.env.TERM_SESSION_ID;
  return terminalSession?.split(":").at(-1);
}

function terminalNotifierPath() {
  return TERMINAL_NOTIFIER_PATHS.find(existsSync);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function notifierValue(value: string) {
  return /^[[(\{"']/.test(value) ? `\\${value}` : value;
}

function execFileAsync(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000 }, (error) => resolve(!error));
  });
}

function sendItermNotification(title: string, subtitle: string, body: string) {
  // iTerm2 owns OSC 9 notifications, so clicking one restores the exact
  // window, tab, and session whose PTY emitted it.
  const message = `${title} — ${subtitle}: ${body}`
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  process.stdout.write(`\x1b]9;${message}\x1b\\`);
}

async function isCurrentItermSessionActive(sessionId = getItermSessionId()): Promise<boolean> {
  if (!isIterm2() || !sessionId) return false;

  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application id "com.googlecode.iterm2"',
        "-e",
        "set isFrontmost to frontmost",
        "-e",
        "set activeSessionId to id of current session of current window",
        "-e",
        'return (isFrontmost as text) & "|" & activeSessionId',
        "-e",
        "end tell",
      ],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }

        const [frontmost, activeSessionId] = stdout.trim().split("|", 2);
        resolve(frontmost === "true" && activeSessionId === sessionId);
      },
    );
  });
}

type NotificationResult = "managed" | "unmanaged" | false;

async function notify(
  config: Config,
  sessionName: string | undefined,
  subtitle: string,
  message: string,
  ctx?: ExtensionContext,
  level: "info" | "error" = "info",
  groupId?: string,
  itermSessionId?: string,
): Promise<NotificationResult> {
  if (!config.enabled || (config.ignore_nested_pi && isNestedPi())) return false;
  if (config.suppress_when_active && (await isCurrentItermSessionActive(itermSessionId))) return false;

  const body = truncate(message, config.max_message_length);
  const title = sessionName ? `${config.title} — ${sessionName}` : config.title;
  const notifier = terminalNotifierPath();

  if (isIterm2() && notifier && groupId && itermSessionId && existsSync(FOCUS_ITERM_SCRIPT)) {
    const args = [
      "-group", groupId,
      "-title", notifierValue(title),
      "-subtitle", notifierValue(subtitle),
      "-message", notifierValue(body),
      "-execute", `${shellQuote(FOCUS_ITERM_SCRIPT)} ${shellQuote(itermSessionId)}`,
    ];
    if (config.sound) args.push("-sound", config.sound);
    return (await execFileAsync(notifier, args)) ? "managed" : false;
  }

  if (isIterm2()) {
    sendItermNotification(title, subtitle, body);
    return "unmanaged";
  }
  if (process.platform !== "darwin") {
    ctx?.ui.notify(`${title} — ${subtitle}: ${body}`, level);
    return "unmanaged";
  }
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sound = config.sound ? ` sound name "${q(config.sound)}"` : "";
  execFile("osascript", [
    "-e",
    `display notification "${q(body)}" with title "${q(title)}" subtitle "${q(subtitle)}"${sound}`,
  ]);
  return "unmanaged";
}

export default function (pi: ExtensionAPI) {
  const itermSessionId = getItermSessionId();
  const groupId = itermSessionId ? `pi-${itermSessionId}` : undefined;
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  let focusCheckRunning = false;

  const stopFocusWatcher = () => {
    if (focusTimer) clearInterval(focusTimer);
    focusTimer = undefined;
    focusCheckRunning = false;
  };

  const removeNotification = async () => {
    stopFocusWatcher();
    const notifier = terminalNotifierPath();
    if (notifier && groupId) await execFileAsync(notifier, ["-remove", groupId]);
  };

  const watchForFocus = () => {
    if (!groupId || !itermSessionId || focusTimer) return;
    focusTimer = setInterval(async () => {
      if (focusCheckRunning) return;
      focusCheckRunning = true;
      try {
        if (await isCurrentItermSessionActive(itermSessionId)) await removeNotification();
      } finally {
        focusCheckRunning = false;
      }
    }, FOCUS_POLL_INTERVAL_MS);
    focusTimer.unref();
  };

  const send = async (
    ctx: ExtensionContext,
    event: keyof Config["events"],
    subtitle: string,
    message: string,
    level: "info" | "error" = "info",
  ) => {
    // Read session-bound state before the first await. Event handlers return this
    // promise, so Pi keeps their context active until notification work finishes.
    const config = loadConfig(ctx);
    const sessionName = pi.getSessionName();
    if (config.events[event]) {
      const result = await notify(
        config,
        sessionName,
        subtitle,
        message,
        ctx,
        level,
        groupId,
        itermSessionId,
      );
      if (result === "managed" && config.suppress_when_active) watchForFocus();
    }
  };

  pi.on("session_start", (event, ctx) =>
    send(ctx, "session_start", "Session", `Started (${event.reason})`),
  );

  pi.on("session_shutdown", async (event, ctx) => {
    await removeNotification();
    await send(ctx, "session_shutdown", "Session", `Ended (${event.reason})`);
  });

  pi.on("session_compact", (event, ctx) =>
    send(ctx, "session_compact", "Session", `Compacted (${event.reason})`),
  );

  pi.on("agent_start", (_event, ctx) =>
    send(ctx, "agent_start", "Agent", "Started working"),
  );

  pi.on("agent_settled", (_event, ctx) =>
    send(ctx, "agent_settled", "Agent", "Finished"),
  );

  pi.on("tool_execution_start", (event, ctx) => {
    if (["ask_question", "ask_user", "question"].includes(event.toolName) && !isPermissionPrompt(event.args)) {
      return send(ctx, "user_question", "Needs input", questionText(event.args));
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError) return;
    const detail = textFromContent((event.result as any)?.content);
    return send(ctx, "tool_error", "Tool error", detail ? `${event.toolName}: ${detail}` : event.toolName, "error");
  });

  pi.on("model_select", (event, ctx) =>
    send(ctx, "model_select", "Model", `${event.model.provider}/${event.model.id}`),
  );

  pi.on("thinking_level_select", (event, ctx) =>
    send(ctx, "thinking_level_select", "Thinking", event.level),
  );

  pi.on("message_end", (event, ctx) => {
    const message = event.message as any;
    const text = textFromContent(message.content);
    if (text) return send(ctx, "message_end", `Message: ${message.role}`, text);
  });

  pi.registerCommand("notify-test", {
    description: "Send a test macOS notification",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx);
      const result = await notify(
        config,
        pi.getSessionName(),
        "Test",
        "Pi notifications are working",
        ctx,
        "info",
        groupId,
        itermSessionId,
      );
      if (result === "managed" && config.suppress_when_active) watchForFocus();
    },
  });
}

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const TIME_WIDTH = 8;
const SUBSCRIPTION_PROVIDERS = new Set(["openai-codex", "kimi-coding"]);

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number } | number;
};

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function latestMessageTimestamp(ctx: ExtensionContext): number | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const timestamp = entry.message.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(twoDigits)
    .join(":");
}

function formatTimestamp(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  const time = formatTime(timestamp);
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;

  const day = twoDigits(date.getDate());
  const month = twoDigits(date.getMonth() + 1);
  return `${day}.${month}.${date.getFullYear()} ${time}`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return cwd;
  const relativeToHome = relative(resolve(home), resolve(cwd));
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome ? `~${sep}${relativeToHome}` : "~";
}

function addUsage(totals: Totals, usage: Usage | undefined): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost +=
    typeof usage.cost === "number" ? usage.cost : (usage.cost?.total ?? 0);
}

function usageTotals(ctx: ExtensionContext): {
  totals: Totals;
  latestCacheHitRate?: number;
} {
  const totals: Totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let latestCacheHitRate: number | undefined;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage as Usage;
      addUsage(totals, usage);
      const promptTokens =
        (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate =
        promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      addUsage(totals, entry.message.usage as Usage);
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      addUsage(totals, entry.usage as Usage);
    }
  }

  return { totals, latestCacheHitRate };
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function renderFooter(
  width: number,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  ctx: ExtensionContext,
  sessionName: string | undefined,
  lastMessageAt: number | undefined,
): string[] {
  const branch = footerData.getGitBranch();
  let cwd = formatCwd(ctx.cwd);
  if (branch) cwd += ` (${branch})`;
  if (sessionName) cwd += ` • ${sessionName}`;

  const fullTimestamp =
    lastMessageAt === undefined ? undefined : formatTimestamp(lastMessageAt);
  const timestamp =
    fullTimestamp && width >= visibleWidth(fullTimestamp)
      ? fullTimestamp
      : lastMessageAt !== undefined && width >= TIME_WIDTH
        ? formatTime(lastMessageAt)
        : undefined;
  const timestampWidth = timestamp ? visibleWidth(timestamp) : 0;
  const leftLimit = timestamp
    ? Math.max(0, width - timestampWidth - 1)
    : width;
  const left = truncateToWidth(cwd, leftLimit, "...");
  const firstLine = timestamp
    ? `${left}${" ".repeat(Math.max(0, width - visibleWidth(left) - timestampWidth))}${timestamp}`
    : left;

  const { totals, latestCacheHitRate } = usageTotals(ctx);
  const stats: string[] = [];
  if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
  if (
    (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
    latestCacheHitRate !== undefined
  ) {
    stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }

  const provider = ctx.model?.provider;
  const usingSubscription = provider !== undefined && SUBSCRIPTION_PROVIDERS.has(provider);
  if (totals.cost || usingSubscription) {
    stats.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
  }

  const context = ctx.getContextUsage();
  const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextDisplay =
    context?.percent == null
      ? `?/${formatTokens(contextWindow)} (auto)`
      : `${context.percent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
  stats.push(
    context?.percent != null && context.percent > 90
      ? theme.fg("error", contextDisplay)
      : context?.percent != null && context.percent > 70
        ? theme.fg("warning", contextDisplay)
        : contextDisplay,
  );

  let statsLeft = stats.join(" ");
  if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

  const modelName = ctx.model?.id ?? "no-model";
  let modelRight = ctx.model?.reasoning
    ? `${modelName} • ${ctx.thinkingLevel === "off" ? "thinking off" : ctx.thinkingLevel}`
    : modelName;
  if (footerData.getAvailableProviderCount() > 1 && provider) {
    const withProvider = `(${provider}) ${modelRight}`;
    if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
      modelRight = withProvider;
    }
  }

  const availableRight = Math.max(0, width - visibleWidth(statsLeft) - 2);
  const right = truncateToWidth(modelRight, availableRight, "");
  const secondLine =
    statsLeft +
    " ".repeat(Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(right))) +
    right;

  const lines = [theme.fg("dim", firstLine), theme.fg("dim", secondLine)];
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, text]) => sanitizeStatus(text));
  if (statuses.length > 0) {
    lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
  }
  return lines;
}

export default function footerLastMessageTime(pi: ExtensionAPI) {
  let lastMessageAt: number | undefined;
  let requestRender: (() => void) | undefined;
  let midnightTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleMidnightRefresh = () => {
    if (midnightTimer) clearTimeout(midnightTimer);
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      50,
    );
    midnightTimer = setTimeout(() => {
      requestRender?.();
      scheduleMidnightRefresh();
    }, nextMidnight.getTime() - now.getTime());
    midnightTimer.unref?.();
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    lastMessageAt = latestMessageTimestamp(ctx);

    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData) => {
      requestRender = () => tui.requestRender();
      scheduleMidnightRefresh();
      const unsubscribeBranch = footerData.onBranchChange(requestRender);
      return {
        invalidate() {},
        render: (width: number) =>
          renderFooter(
            width,
            theme,
            footerData,
            ctx,
            pi.getSessionName(),
            lastMessageAt,
          ),
        dispose: unsubscribeBranch,
      };
    });
  });

  pi.on("message_end", (event) => {
    const timestamp = event.message.timestamp;
    lastMessageAt =
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : Date.now();
    requestRender?.();
  });

  pi.on("session_info_changed", () => requestRender?.());

  pi.on("session_shutdown", (_event, ctx) => {
    if (midnightTimer) clearTimeout(midnightTimer);
    midnightTimer = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}

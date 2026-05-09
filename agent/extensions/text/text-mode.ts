import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TEXT_MODE_ENTRY = "text-mode";
const TEXT_MODE_SESSION_NAME = "Text mode";
const DEFAULT_NORMAL_TOOLS = ["read", "bash", "edit", "write"];
const FALLBACK_PROMPT = "\u200b";
const CRITICAL_THINKING_PROMT_NAME = "critical_thinking";
const CORRECT_PROGRAMMING_PROMT_NAME = "correct_programming";
const PROMPTS_DIR = join(__dirname, "prompts");

type TextModeState = {
	enabled?: boolean;
	createdAt?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPrompt(promptName: string): string {
	try {
		const promptPath = join(PROMPTS_DIR, `${promptName}.md`);
		const prompt = readFileSync(promptPath, "utf8").trim();
		return prompt.length > 0 ? prompt : FALLBACK_PROMPT;
	} catch {
		return FALLBACK_PROMPT;
	}
}

function buildNormalModePrompt(baseSystemPrompt: string): string {
	const criticalThinkingPrompt = loadPrompt(CRITICAL_THINKING_PROMT_NAME);
	const correctProgrammingPrompt = loadPrompt(CORRECT_PROGRAMMING_PROMT_NAME);

	return [baseSystemPrompt, criticalThinkingPrompt, correctProgrammingPrompt]
		.filter((part) => part && part !== FALLBACK_PROMPT)
		.join("\n\n");
}

function hasConversationHistory(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => {
		return (
			entry.type === "message" ||
			entry.type === "custom_message" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary"
		);
	});
}

function scrubProviderPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;

	const next: Record<string, unknown> = { ...payload };

	if (Array.isArray(next.tools)) {
		next.tools = [];
	}

	if (Array.isArray(next.functions)) {
		next.functions = [];
	}

	if ("tool_choice" in next) {
		delete next.tool_choice;
	}

	if ("toolChoice" in next) {
		delete next.toolChoice;
	}

	return next;
}

export default function textModeExtension(pi: ExtensionAPI) {
	let textModeEnabled = false;

	function updateUi(ctx: ExtensionContext) {
		if (textModeEnabled) {
			pi.setActiveTools([]);
			ctx.ui.setStatus("text-mode", ctx.ui.theme.fg("accent", "✍ text"));
		} else {
			if (pi.getActiveTools().length === 0) {
				pi.setActiveTools(DEFAULT_NORMAL_TOOLS);
			}
			ctx.ui.setStatus("text-mode", undefined);
		}
	}

	function enableTextMode(ctx: ExtensionContext) {
		textModeEnabled = true;
		pi.appendEntry<TextModeState>(TEXT_MODE_ENTRY, {
			enabled: true,
			createdAt: Date.now(),
		});
		pi.setSessionName(TEXT_MODE_SESSION_NAME);
		updateUi(ctx);
	}

	function restoreState(ctx: ExtensionContext) {
		textModeEnabled = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== TEXT_MODE_ENTRY) continue;
			const data = entry.data as TextModeState | undefined;
			textModeEnabled = data?.enabled !== false;
		}

		updateUi(ctx);
	}

	pi.registerCommand("text", {
		description: "Create a new text-only chat without tools",
		handler: async (_args, ctx) => {
			const parentSession = ctx.sessionManager.getSessionFile();

			const result = await ctx.newSession({
				parentSession,
				setup: async (sm) => {
					sm.appendCustomEntry(TEXT_MODE_ENTRY, {
						enabled: true,
						createdAt: Date.now(),
					});
					sm.appendSessionInfo(TEXT_MODE_SESSION_NAME);
				},
				withSession: async (newCtx) => {
					newCtx.ui.notify("Opened a new text-mode chat. Tools are disabled.", "success");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Creating text-mode session was cancelled.", "info");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		restoreState(ctx);

		if (event.reason !== "startup" || !ctx.hasUI || textModeEnabled) return;
		if (hasConversationHistory(ctx)) return;

		const choice = await ctx.ui.select("Выберите режим", ["Обычный режим", "Text mode"]);
		if (choice === "Text mode") {
			enableTextMode(ctx);
			ctx.ui.notify("Text mode включён для новой пустой сессии.", "success");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		updateUi(ctx);

		if (textModeEnabled) {
			return {
				systemPrompt: loadPrompt(CRITICAL_THINKING_PROMT_NAME),
			};
		}

		return {
			systemPrompt: buildNormalModePrompt(event.systemPrompt),
		};
	});

	pi.on("before_provider_request", (event) => {
		if (!textModeEnabled) return;
		return scrubProviderPayload(event.payload);
	});

	pi.on("tool_call", async (event) => {
		if (!textModeEnabled) return;
		return {
			block: true,
			reason: `Text mode blocks tool calls (${event.toolName}).`,
		};
	});
}

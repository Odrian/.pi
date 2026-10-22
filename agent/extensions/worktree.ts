import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type WorktreeSwitchResult = {
	action?: string;
	branch?: string;
	path?: string;
};

function parseSwitchResult(stdout: string): WorktreeSwitchResult | undefined {
	const lines = stdout.trim().split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			const value = JSON.parse(lines[index]) as WorktreeSwitchResult;
			if (typeof value.path === "string") return value;
		} catch {
			// Worktrunk may print informational lines alongside its JSON result.
		}
	}
	return undefined;
}

function commandError(stdout: string, stderr: string): string {
	const detail = stderr.trim() || stdout.trim();
	return detail ? `Worktrunk: ${detail}` : "Worktrunk не вернул путь worktree.";
}

function branchDoesNotExist(stdout: string, stderr: string): boolean {
	const output = `${stderr}\n${stdout}`;
	return output.includes("No branch named ") && output.includes("wt switch --create");
}

export default function (pi: ExtensionAPI) {
	let sessionGeneration = 0;
	pi.on("session_shutdown", () => {
		sessionGeneration++;
	});

	pi.registerCommand("cd", {
		description: "Перейти в другую директорию, сохранив текущий контекст сессии",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const path = args.trim();
			if (!path) {
				ctx.ui.notify("Использование: /cd <путь>", "error");
				return;
			}

			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			if (!ctx.sessionManager.isPersisted() || !sourceSessionFile) {
				ctx.ui.notify("Нельзя перенести несохранённую сессию в другую директорию.", "error");
				return;
			}

			const generation = sessionGeneration;
			try {
				const expandedPath = path === "~" || path.startsWith("~/")
					? resolve(homedir(), path.slice(2))
					: resolve(ctx.cwd, path);
				const targetCwd = await realpath(expandedPath);
				if (!(await stat(targetCwd)).isDirectory()) {
					ctx.ui.notify(`Это не директория: ${targetCwd}`, "error");
					return;
				}

				const currentCwd = await realpath(ctx.cwd);
				if (targetCwd === currentCwd) {
					ctx.ui.notify(`Pi уже работает в ${targetCwd}.`, "info");
					return;
				}

				const targetSession = SessionManager.forkFrom(sourceSessionFile, targetCwd);
				const targetSessionFile = targetSession.getSessionFile();
				if (!targetSessionFile) {
					ctx.ui.notify("Не удалось сохранить сессию для целевой директории.", "error");
					return;
				}

				const switchResult = await ctx.switchSession(targetSessionFile, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify(`Рабочая директория: ${replacementCtx.cwd}`, "info");
					},
				});

				if (switchResult.cancelled) {
					ctx.ui.notify("Переключение сессии отменено.", "info");
				}
			} catch (error) {
				// Replacement may fail after the old runtime has already been disposed.
				if (generation !== sessionGeneration) throw error;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Не удалось перейти в директорию: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("wt", {
		description: "Перейти в worktree, сохранив текущий контекст сессии",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const branch = args.trim();
			if (!branch) {
				ctx.ui.notify("Использование: /wt <ветка>", "error");
				return;
			}

			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			if (!ctx.sessionManager.isPersisted() || !sourceSessionFile) {
				ctx.ui.notify("Нельзя перенести несохранённую сессию в другой worktree.", "error");
				return;
			}

			const generation = sessionGeneration;
			try {
				let result = await pi.exec(
					"wt",
					["-C", ctx.cwd, "switch", branch, "--no-cd", "--format", "json"],
					{ timeout: 120_000 },
				);
				if (result.code !== 0 && branchDoesNotExist(result.stdout, result.stderr)) {
					result = await pi.exec(
						"wt",
						["-C", ctx.cwd, "switch", "--create", branch, "--no-cd", "--format", "json"],
						{ timeout: 120_000 },
					);
				}
				const switched = parseSwitchResult(result.stdout);
				if (result.code !== 0 || !switched?.path) {
					ctx.ui.notify(commandError(result.stdout, result.stderr), "error");
					return;
				}

				const targetCwd = await realpath(resolve(ctx.cwd, switched.path));
				const currentCwd = await realpath(ctx.cwd);
				if (targetCwd === currentCwd) {
					ctx.ui.notify(`Pi уже работает в ${targetCwd}.`, "info");
					return;
				}

				const targetSession = SessionManager.forkFrom(sourceSessionFile, targetCwd);
				const targetSessionFile = targetSession.getSessionFile();
				if (!targetSessionFile) {
					ctx.ui.notify("Не удалось сохранить сессию для целевого worktree.", "error");
					return;
				}

				const switchResult = await ctx.switchSession(targetSessionFile, {
					withSession: async (replacementCtx) => {
						replacementCtx.ui.notify(`Рабочая директория: ${replacementCtx.cwd}`, "info");
					},
				});

				if (switchResult.cancelled) {
					ctx.ui.notify("Переключение сессии отменено.", "info");
				}
			} catch (error) {
				if (generation !== sessionGeneration) throw error;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Не удалось переключить worktree: ${message}`, "error");
			}
		},
	});
}

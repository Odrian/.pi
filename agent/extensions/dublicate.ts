import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPEN_TAB_SCRIPT = String.raw`
on run argv
	if (count of argv) is not 3 then error "Expected cwd, session file, and pi executable"

	set workingDirectory to item 1 of argv
	set sessionFile to item 2 of argv
	set piExecutable to item 3 of argv
	set shellCommand to "cd -- " & quoted form of workingDirectory & " && " & quoted form of piExecutable & " --fork " & quoted form of sessionFile

	tell application id "com.googlecode.iterm2"
		if (count of windows) is greater than 0 then
			tell current window
				set targetTab to create tab with default profile
			end tell
			tell current session of targetTab to write text shellCommand
		else
			set targetSession to create window with default profile
			tell targetSession to write text shellCommand
		end if
		activate
	end tell
end run
`;

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findPiExecutable(cwd: string): Promise<string | undefined> {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const base = directory ? (isAbsolute(directory) ? directory : resolve(cwd, directory)) : cwd;
		const candidate = join(base, "pi");
		if (await isExecutable(candidate)) return candidate;
	}

	const entryPoint = process.argv[1];
	if (entryPoint && (await isExecutable(entryPoint))) return resolve(entryPoint);
	return undefined;
}

function describeItermError(stderr: string): string {
	const detail = stderr.trim();

	if (/not authorized|not permitted|-1743/i.test(detail)) {
		return "macOS запретила управление iTerm2. Разрешите доступ в System Settings → Privacy & Security → Automation и повторите команду.";
	}

	if (/application.*(?:isn.t|is not|was not).*found|can.t get application|-10814/i.test(detail)) {
		return "iTerm2 не найден. Установите iTerm2 и повторите команду.";
	}

	return detail ? `Не удалось открыть вкладку iTerm2: ${detail}` : "Не удалось открыть вкладку iTerm2.";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("dublicate", {
		description: "Открыть в iTerm2 новый fork текущей сессии",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			if (process.platform !== "darwin") {
				ctx.ui.notify("Команда /dublicate доступна только в macOS с iTerm2.", "error");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!ctx.sessionManager.isPersisted() || !sessionFile) {
				ctx.ui.notify("Нельзя создать fork: текущая сессия не сохранена на диске.", "error");
				return;
			}

			try {
				await access(sessionFile, constants.R_OK);
			} catch {
				ctx.ui.notify(`Нельзя прочитать файл текущей сессии: ${sessionFile}`, "error");
				return;
			}

			const piExecutable = await findPiExecutable(ctx.cwd);
			if (!piExecutable) {
				ctx.ui.notify("Не удалось найти исполняемый файл pi.", "error");
				return;
			}

			try {
				const result = await pi.exec(
					"/usr/bin/osascript",
					["-e", OPEN_TAB_SCRIPT, "--", ctx.cwd, sessionFile, piExecutable],
					{ timeout: 10_000 },
				);

				if (result.code !== 0) {
					ctx.ui.notify(describeItermError(result.stderr), "error");
					return;
				}

				ctx.ui.notify("Fork текущей сессии открыт в новой вкладке iTerm2.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Не удалось запустить управление iTerm2: ${message}`, "error");
			}
		},
	});
}

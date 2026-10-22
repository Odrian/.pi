import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SIGNAL_FILE = join(AGENT_DIR, "reload-all.json");
const SIGNAL_NAME = "reload-all.json";
const RECEIVER_ARGUMENT = "--receive";

type ReloadSignal = {
	id: string;
	createdAt: number;
	pid: number;
};

async function readSignal(): Promise<ReloadSignal | undefined> {
	try {
		const value = JSON.parse(await readFile(SIGNAL_FILE, "utf8")) as Partial<ReloadSignal>;
		if (
			typeof value.id !== "string" ||
			typeof value.createdAt !== "number" ||
			typeof value.pid !== "number"
		) {
			return undefined;
		}
		return value as ReloadSignal;
	} catch {
		return undefined;
	}
}

async function writeSignal(signal: ReloadSignal): Promise<void> {
	await mkdir(dirname(SIGNAL_FILE), { recursive: true });
	const temporaryFile = `${SIGNAL_FILE}.${process.pid}.${signal.id}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(signal)}\n`, { mode: 0o600 });
	await rename(temporaryFile, SIGNAL_FILE);
}

export default function reloadAll(pi: ExtensionAPI) {
	let watcher: FSWatcher | undefined;
	let readTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSeenId: string | undefined;
	let reloadQueued = false;
	let watcherGeneration = 0;

	const stopWatcher = () => {
		watcherGeneration++;
		if (readTimer) clearTimeout(readTimer);
		readTimer = undefined;
		watcher?.close();
		watcher = undefined;
	};

	const receiveSignal = async (generation: number) => {
		const signal = await readSignal();
		if (generation !== watcherGeneration || !signal || signal.id === lastSeenId || reloadQueued) return;

		lastSeenId = signal.id;
		reloadQueued = true;
		pi.sendUserMessage(`/reload-all ${RECEIVER_ARGUMENT}`, {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
	};

	const scheduleSignalRead = () => {
		if (readTimer || reloadQueued) return;
		const generation = watcherGeneration;
		readTimer = setTimeout(() => {
			readTimer = undefined;
			void receiveSignal(generation).catch((error) => {
				if (generation !== watcherGeneration) return;
				reloadQueued = false;
				console.error("reload-all signal:", error);
			});
		}, 30);
	};

	pi.on("session_start", async (_event, ctx) => {
		stopWatcher();
		const generation = watcherGeneration;
		reloadQueued = false;
		await mkdir(dirname(SIGNAL_FILE), { recursive: true });
		const initialSignal = await readSignal();
		if (generation !== watcherGeneration) return;
		lastSeenId = initialSignal?.id;

		watcher = watch(dirname(SIGNAL_FILE), (_eventType, filename) => {
			if (generation === watcherGeneration && filename?.toString() === SIGNAL_NAME) scheduleSignalRead();
		});
		// The watcher must not keep RPC/print processes alive after stdin closes.
		watcher.unref();
		watcher.on("error", (error) => {
			if (generation !== watcherGeneration) return;
			if (ctx.hasUI) ctx.ui.notify(`reload-all watcher: ${error.message}`, "warning");
		});
	});

	pi.on("session_shutdown", () => {
		stopWatcher();
	});

	pi.registerCommand("reload-all", {
		description: "Reload extensions and resources in all running pi sessions",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (args.trim() === RECEIVER_ARGUMENT) {
				if (ctx.hasUI) ctx.ui.notify("Reloading after /reload-all broadcast", "info");
				await ctx.reload();
				return;
			}

			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /reload-all", "warning");
				return;
			}

			const signal: ReloadSignal = {
				id: randomUUID(),
				createdAt: Date.now(),
				pid: process.pid,
			};

			// Ignore our own filesystem event: this process reloads directly below.
			lastSeenId = signal.id;
			reloadQueued = true;
			await writeSignal(signal);
			if (ctx.hasUI) ctx.ui.notify("Reload broadcast sent", "info");
			await ctx.reload();
		},
	});
}

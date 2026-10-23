import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { runSessionCleanup, type SessionCleanupHook } from "./session-cleanup.ts";
import { readSessionHeader } from "./session-manager.ts";

export interface DeleteSessionOptions {
	guard?: SessionCleanupHook;
	timeoutMs?: number;
}

export async function deleteSessionFile(
	sessionPath: string,
	options?: DeleteSessionOptions,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	if (options?.guard) {
		try {
			const header = readSessionHeader(sessionPath);
			if (!header) throw new Error(`Invalid session header: ${sessionPath}`);
			await runSessionCleanup(
				[{ name: "delete", hook: options.guard }],
				{ reason: "delete", session_id: header.id, session_dir: dirname(sessionPath) },
				[],
				options?.timeoutMs,
			);
		} catch (error) {
			return { ok: false, method: "unlink", error: error instanceof Error ? error.message : String(error) };
		}
	}
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) parts.push(trashResult.error.message);
		const stderr = trashResult.stderr?.trim();
		if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		const unlinkError = error instanceof Error ? error.message : String(error);
		const trashErrorHint = getTrashErrorHint();
		return {
			ok: false,
			method: "unlink",
			error: trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError,
		};
	}
}

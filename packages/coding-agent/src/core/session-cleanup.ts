export interface SessionCleanupContext {
	readonly phase: "prepare" | "finish";
	readonly reason: "quit" | "reload" | "new" | "resume" | "fork" | "delete";
	readonly session_id: string;
	readonly session_dir: string;
	readonly legacy_completed: boolean;
}

export interface SessionCleanupResult {
	readonly pending: readonly string[];
}

// biome-ignore lint/suspicious/noConfusingVoidType: hooks may return without a result
type SessionCleanupReturn = void | SessionCleanupResult;

export type SessionCleanupHook = (
	context: Readonly<SessionCleanupContext>,
	signal: AbortSignal,
) => SessionCleanupReturn | Promise<SessionCleanupReturn>;

export interface NamedSessionCleanup {
	readonly name: string;
	readonly hook: SessionCleanupHook;
}

export const SESSION_CLEANUP_TIMEOUT_MS = 30_000;

export async function runSessionCleanup(
	hooks: readonly NamedSessionCleanup[],
	identity: Omit<SessionCleanupContext, "phase" | "legacy_completed">,
	steps: readonly (() => Promise<unknown>)[],
	timeoutMs = SESSION_CLEANUP_TIMEOUT_MS,
): Promise<void> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid session cleanup timeout");
	const errors: unknown[] = [];
	const deadline = performance.now() + timeoutMs;
	const prepareDeadline = deadline - timeoutMs / 3;

	async function phase(
		phaseName: SessionCleanupContext["phase"],
		phaseDeadline: number,
		legacySteps: readonly (() => Promise<unknown>)[],
		legacyCompleted = false,
	): Promise<boolean> {
		const controller = new AbortController();
		const context = Object.freeze({ ...identity, phase: phaseName, legacy_completed: legacyCompleted });
		let completedSteps = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => {
					controller.abort();
					reject(new Error(`Session cleanup ${phaseName} timed out`));
				},
				Math.max(0, phaseDeadline - performance.now()),
			);
		});
		async function bounded(name: string, work: () => unknown): Promise<boolean> {
			try {
				if (controller.signal.aborted || performance.now() >= phaseDeadline) {
					throw new Error(`Session cleanup ${phaseName} timed out`);
				}
				await Promise.race([Promise.resolve().then(work), timeout]);
				return true;
			} catch (error) {
				errors.push(
					new Error(
						`Session cleanup ${phaseName} failed: ${name}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
				return false;
			}
		}
		try {
			for (const { name, hook } of hooks) {
				await bounded(name, async () => {
					const result = await hook(context, controller.signal);
					if (result !== undefined) {
						if (!Array.isArray(result.pending) || result.pending.some((item) => typeof item !== "string")) {
							throw new Error(`Invalid session cleanup result: ${name}`);
						}
						if (result.pending.length > 0) {
							throw new Error(`Pending session cleanup (${name}): ${result.pending.join(", ")}`);
						}
					}
				});
			}
			for (const [index, step] of legacySteps.entries()) {
				if (!(await bounded(`legacy step ${index + 1}`, step))) break;
				completedSteps++;
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			controller.abort();
		}
		return completedSteps === legacySteps.length;
	}

	const legacyCompleted = await phase("prepare", prepareDeadline, steps);
	await phase("finish", deadline, [], legacyCompleted);
	if (errors.length > 0)
		throw new AggregateError(errors, `Session cleanup failed (${identity.reason}): ${errors.map(String).join("; ")}`);
}

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { SessionCleanupHook } from "../../src/core/session-cleanup.ts";
import { deleteSessionFile } from "../../src/core/session-delete.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionCleanupContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";
import { createHarness } from "./harness.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: { cwd?: string; bootstrapModel?: boolean; bootstrapThinkingLevel?: boolean },
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						return extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
					thinkingLevel: runtimeOptions.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("settles the active response before session replacement", async () => {
		const cleanupEvents: SessionCleanupContext[] = [];
		let workSignal: AbortSignal | undefined;
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_cleanup", (context) => {
				const { signal } = context;
				cleanupEvents.push(context);
				expect(Object.isFrozen(context)).toBe(true);
				expect(signal.aborted).toBe(false);
				if (workSignal) {
					expect(signal).not.toBe(workSignal);
					expect(workSignal.aborted).toBe(context.phase === "finish");
				}
				pi.getActiveTools();
			});
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						workSignal = signal;
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;
		cleanupEvents.length = 0;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;
		expect(cleanupEvents).toMatchObject(
			["prepare", "finish"].map((phase) => ({
				phase,
				reason: "resume",
				session_id: outgoingSession.sessionId,
				session_dir: outgoingSession.sessionManager.getSessionDir(),
				legacy_completed: phase === "finish",
			})),
		);
		workSignal = undefined;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
	});

	it("re-registers cleanup on reload and awaits it before invalidating the old API", async () => {
		const events: string[] = [];
		const legacyHold = Promise.withResolvers<void>();
		const legacyReached = Promise.withResolvers<void>();
		let loads = 0;
		let oldApi: ExtensionAPI | undefined;
		const { runtime } = await createRuntimeForTest((pi) => {
			const load = ++loads;
			oldApi ??= pi;
			pi.on("session_cleanup", async ({ phase, reason, legacy_completed, signal }) => {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(signal.aborted).toBe(false);
				expect(legacy_completed).toBe(phase === "finish");
				pi.getActiveTools();
				events.push(`${load}:${phase}:${reason}`);
			});
			pi.on("session_shutdown", async ({ reason }) => {
				events.push(`${load}:legacy:${reason}`);
				if (reason === "reload") {
					legacyReached.resolve();
					await legacyHold.promise;
				}
			});
		});
		const session = runtime.session;
		const reload = session.reload();
		await legacyReached.promise;
		expect(events).toEqual(["1:prepare:reload", "1:legacy:reload"]);
		expect(() => oldApi!.getActiveTools()).not.toThrow();
		legacyHold.resolve();
		await reload;
		expect(runtime.session).toBe(session);
		expect(() => oldApi!.getActiveTools()).toThrow("stale");
		await runtime.newSession();
		expect(events).toEqual([
			"1:prepare:reload",
			"1:legacy:reload",
			"1:finish:reload",
			"2:prepare:new",
			"2:legacy:new",
			"2:finish:new",
		]);
		await runtime.dispose();
		await runtime.dispose();
		expect(events.slice(6)).toEqual(["3:prepare:quit", "3:legacy:quit", "3:finish:quit"]);
	});

	it("aggregates cleanup failures without hiding notification errors or replacing the session", async () => {
		let fail = true;
		let api: ExtensionAPI | undefined;
		const events: string[] = [];
		const notifications: string[] = [];
		const { runtime } = await createRuntimeForTest((pi) => {
			api = pi;
			pi.on("session_cleanup", ({ phase }) => {
				events.push(phase);
				if (!fail) return;
				if (phase === "prepare") throw new Error("prepare failure");
				return { pending: ["live-child"] };
			});
			pi.on("session_shutdown", () => {
				throw new Error("legacy failure");
			});
		});
		await runtime.session.bindExtensions({ onError: (error) => notifications.push(error.error) });
		const original = runtime.session;
		for (const transition of [() => runtime.newSession(), () => original.reload(), () => runtime.dispose()]) {
			const error = await transition().catch((error: unknown) => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect(String(error)).toContain("prepare failure");
			expect(String(error)).toContain("live-child");
			expect(events.splice(0)).toEqual(["prepare", "finish"]);
			expect(runtime.session).toBe(original);
			expect(() => api!.getActiveTools()).not.toThrow();
		}
		expect(notifications).toEqual(["legacy failure", "legacy failure", "legacy failure"]);
		fail = false;
	});

	it.each(["prepare", "legacy", "finish"])("bounds a stalled %s while still attempting finish", async (stall) => {
		let fail = true;
		const events: string[] = [];
		const { runtime } = await createRuntimeForTest((pi) => {
			pi.on("session_cleanup", async ({ phase, signal }) => {
				events.push(phase);
				expect(signal.aborted).toBe(false);
				if (fail && phase === stall) await new Promise<void>(() => {});
			});
			pi.on("session_shutdown", async () => {
				events.push("legacy");
				if (fail && stall === "legacy") await new Promise<void>(() => {});
			});
		});
		await expect(runtime.session.close({ timeoutMs: 90 })).rejects.toThrow("timed out");
		fail = false;
		expect(events).toEqual(stall === "prepare" ? ["prepare", "finish"] : ["prepare", "legacy", "finish"]);
	});

	it.each([true, false])(
		"keeps admitted work alive on shutdown timeout and retries the same live session (cleanup hook: %s)",
		async (withCleanup) => {
			const started = Promise.withResolvers<void>();
			const hold = Promise.withResolvers<void>();
			const legacyDone = Promise.withResolvers<void>();
			let signal: AbortSignal | undefined;
			let api: ExtensionAPI | undefined;
			let admissionOpen = true;
			const contexts: SessionCleanupContext[] = [];
			const { runtime, faux } = await createRuntimeForTest((pi) => {
				api = pi;
				if (withCleanup)
					pi.on("session_cleanup", (context) => {
						contexts.push(context);
						expect(Object.isFrozen(context)).toBe(true);
						pi.getActiveTools();
						if (context.phase === "prepare") admissionOpen = false;
						else if (!signal?.aborted) return { pending: ["admitted-tool"] };
					});
				pi.on("session_shutdown", async () => {
					admissionOpen = false;
					await hold.promise;
					legacyDone.resolve();
				});
				pi.registerTool({
					name: "admitted",
					label: "Admitted",
					description: "Wait for cancellation",
					parameters: Type.Object({}),
					execute: (_id, _params, workSignal) =>
						new Promise<AgentToolResult<unknown>>((resolve) => {
							signal = workSignal;
							started.resolve();
							workSignal?.addEventListener("abort", () => {
								expect(admissionOpen).toBe(false);
								resolve({ content: [{ type: "text", text: "aborted" }], details: undefined });
							});
						}),
				});
			});
			faux.setResponses([fauxAssistantMessage(fauxToolCall("admitted", {}), { stopReason: "toolUse" })]);
			cleanups.push(() => hold.resolve());
			const original = runtime.session;
			const prompt = original.prompt("start admitted work");
			await started.promise;
			const attempt = original.close({ timeoutMs: 90 });
			const disposal = runtime.dispose();
			expect(runtime.dispose()).toBe(disposal);
			expect(original.close()).toBe(attempt);
			await expect(Promise.all([attempt, disposal])).rejects.toThrow("timed out");
			expect(contexts.map(({ legacy_completed }) => legacy_completed)).toEqual(withCleanup ? [false, false] : []);
			expect(signal?.aborted).toBe(false);
			expect(runtime.session).toBe(original);
			expect(() => api!.getActiveTools()).not.toThrow();
			hold.resolve();
			await legacyDone.promise;
			const retry = runtime.dispose();
			expect(retry).not.toBe(attempt);
			expect(runtime.dispose()).toBe(retry);
			await retry;
			await prompt;
			expect(contexts.map(({ phase, legacy_completed }) => [phase, legacy_completed])).toEqual(
				withCleanup
					? [
							["prepare", false],
							["finish", false],
							["prepare", false],
							["finish", true],
						]
					: [],
			);
			expect(signal?.aborted).toBe(true);
			expect(() => api!.getActiveTools()).toThrow("stale");
		},
	);

	it("drains admitted continuations before finish and seals late prompt admission", async () => {
		const finishEntered = Promise.withResolvers<void>();
		const releaseFinish = Promise.withResolvers<void>();
		const inputEntered = Promise.withResolvers<void>();
		const releaseInput = Promise.withResolvers<void>();
		let legacyText: string | undefined;
		const { runtime, faux } = await createRuntimeForTest((pi) => {
			pi.on("input", async ({ text }) => {
				if (text === "late input") {
					inputEntered.resolve();
					await releaseInput.promise;
				}
			});
			pi.on("session_shutdown", async () => {
				await runtime.session.sendUserMessage("admitted shutdown continuation");
				legacyText = runtime.session.getLastAssistantText();
			});
			pi.on("session_cleanup", async ({ phase }) => {
				if (phase !== "finish") return;
				finishEntered.resolve();
				await releaseFinish.promise;
			});
		});
		faux.setResponses([fauxAssistantMessage("workflow complete"), fauxAssistantMessage("unexpected admission")]);
		const latePrompt = runtime.session.prompt("late input").catch((error: unknown) => error);
		await inputEntered.promise;
		let closed = false;
		let idleAtInvalidation = false;
		runtime.setBeforeSessionInvalidate(() => {
			idleAtInvalidation = runtime.session.isIdle;
		});
		const closing = runtime.dispose().then(() => {
			closed = true;
		});
		try {
			await finishEntered.promise;
			expect(legacyText).toBe("workflow complete");
			expect(closed).toBe(false);
			await expect(runtime.session.prompt("finish work")).rejects.toThrow("closed");
			releaseInput.resolve();
			expect(String(await latePrompt)).toContain("closed");
			await expect(runtime.session.sendUserMessage("too late")).rejects.toThrow("closed");
			await expect(runtime.session.followUp("too late")).rejects.toThrow("closed");
			await expect(
				runtime.session.sendCustomMessage(
					{ customType: "late", content: "late", display: false },
					{ triggerTurn: true },
				),
			).rejects.toThrow("closed");
		} finally {
			releaseInput.resolve();
			releaseFinish.resolve();
			await Promise.allSettled([latePrompt, closing]);
		}
		expect(idleAtInvalidation).toBe(true);
		expect(runtime.session.isIdle).toBe(true);
		await expect(runtime.session.prompt("after close")).rejects.toThrow("closed");
	});

	it("refuses a clean disposal receipt during replacement and replacement after disposal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let loads = 0;
		const { runtime } = await createRuntimeForTest(async () => {
			if (++loads === 2) {
				entered.resolve();
				await release.promise;
			}
		});
		const replacing = runtime.newSession();
		await entered.promise;
		try {
			await expect(runtime.dispose()).rejects.toThrow("replacement");
		} finally {
			release.resolve();
			await replacing;
		}
		await runtime.dispose();
		await expect(runtime.newSession()).rejects.toThrow("closed");
		expect(loads).toBe(2);
	});

	it("waits for the whole reload factory before closing the replacement runner", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const apis: ExtensionAPI[] = [];
		const finished: string[] = [];
		const { runtime } = await createRuntimeForTest(async (pi) => {
			const load = apis.push(pi);
			pi.on("session_cleanup", ({ phase, reason }) => {
				if (phase === "finish") finished.push(`${load}:${reason}`);
			});
			if (load === 2) {
				entered.resolve();
				await release.promise;
			}
		});
		const reload = runtime.session.reload();
		await entered.promise;
		await expect(runtime.session.close({ timeoutMs: 60 })).rejects.toThrow("timed out waiting for reload");
		let closed = false;
		const closing = runtime.dispose().then(() => {
			closed = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
		} finally {
			release.resolve();
			await Promise.allSettled([reload, closing]);
		}
		await reload;
		await closing;
		expect(finished).toEqual(["1:reload", "2:quit"]);
		for (const api of apis) expect(() => api.getActiveTools()).toThrow("stale");
		await expect(runtime.session.reload()).rejects.toThrow("closed");
	});

	it("does not report forced disposal as successful orderly cleanup", async () => {
		const phases: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_cleanup", ({ phase }) => {
						phases.push(phase);
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		harness.session.dispose();
		await expect(harness.session.close()).rejects.toThrow("disposed without orderly cleanup");
		await expect(harness.session.prompt("after disposal")).rejects.toThrow("closed");
		expect(phases).toEqual([]);
	});

	it.each([
		["legacy", `${JSON.stringify({ type: "session", version: 1, id: "legacy-owner", cwd: tmpdir() })}\n`],
		["unsealed", JSON.stringify({ type: "session", version: 3, id: "unsealed-owner", cwd: tmpdir() })],
		["empty", ""],
	])("leaves denied %s deletion byte-for-byte unchanged", async (_kind, contents) => {
		const directory = join(tmpdir(), `pi-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory);
		cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
		const sessionPath = join(directory, "session.jsonl");
		writeFileSync(sessionPath, contents);
		const original = readFileSync(sessionPath);
		const denied = await deleteSessionFile(sessionPath, { guard: () => ({ pending: ["live-owner"] }) });
		expect(denied.ok).toBe(false);
		expect(denied.error).toContain(contents ? "live-owner" : "Invalid session header");
		expect(readFileSync(sessionPath)).toEqual(original);
	});

	it("guards deletion of an inactive session before touching its file", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("persist me");
		const sessionId = runtime.session.sessionId;
		const sessionPath = runtime.session.sessionFile!;
		await runtime.newSession();
		let pending = true;
		const phases: string[] = [];
		const guard: SessionCleanupHook = (context) => {
			expect(context.session_id).toBe(sessionId);
			expect(context.reason).toBe("delete");
			expect(context.legacy_completed).toBe(context.phase === "finish");
			phases.push(context.phase);
			return { pending: pending ? ["live-owner"] : [] };
		};
		const denied = await deleteSessionFile(sessionPath, { guard });
		expect(denied.ok).toBe(false);
		expect(denied.error).toContain("live-owner");
		expect(existsSync(sessionPath)).toBe(true);
		const unrelatedPath = join(runtime.session.sessionManager.getSessionDir(), "unrelated.jsonl");
		writeFileSync(unrelatedPath, readFileSync(sessionPath));
		expect((await deleteSessionFile(unrelatedPath)).ok).toBe(true);
		expect(existsSync(unrelatedPath)).toBe(false);
		pending = false;
		expect((await deleteSessionFile(sessionPath, { guard })).ok).toBe(true);
		expect(existsSync(sessionPath)).toBe(false);
		expect(phases).toEqual(["prepare", "finish", "prepare", "finish"]);
	});

	it("preserves an existing session when importing a file with the same name", async () => {
		const { runtime, tempDir } = await createRuntimeForTest(() => {});
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const importDir = join(tempDir, "import");
		const filename = "collision.jsonl";
		const storedPath = join(sessionDir, filename);
		const importPath = join(importDir, filename);
		const storedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "stored",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		const importedSession = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "imported",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		})}\n`;
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(importDir, { recursive: true });
		writeFileSync(storedPath, storedSession);
		writeFileSync(importPath, importedSession);

		await runtime.importFromJsonl(importPath);

		expect(readFileSync(storedPath, "utf8")).toBe(storedSession);
		expect(runtime.session.sessionFile).not.toBe(storedPath);
		expect(readFileSync(runtime.session.sessionFile!, "utf8")).toContain('"id":"imported"');
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir);
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);
		const sessionFileName = parse(runtime.session.sessionFile!).name;
		expect(sessionFileName.endsWith(`_${runtime.session.sessionId}`)).toBe(true);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("reports why an unflushed session cannot be forked", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const sessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);
		expect(leafId).toBeTruthy();

		await expect(runtime.fork(leafId!, { position: "at" })).rejects.toThrow(
			"This session has not been saved yet. Send a message before cloning or forking it.",
		);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		await otherAuthStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});

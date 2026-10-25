import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe.each(["regular", "fullscreen"] as const)("InteractiveMode extension dialogs (%s)", (tuiMode) => {
	let runtime: AgentSessionRuntime;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	let extension: ExtensionAPI;
	let ui: ExtensionUIContext;

	beforeEach(async () => {
		vi.stubEnv(ENV_AGENT_DIR, process.cwd());
		initTheme("dark");
		const settingsManager = SettingsManager.inMemory({
			quietStartup: true,
			theme: "dark",
			enableInstallTelemetry: false,
		});
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const factory: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [
						(pi) => {
							extension = pi;
							pi.on("session_start", (_event, ctx) => {
								ui = ctx.ui;
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtime = await createAgentSessionRuntime(factory, {
			cwd: process.cwd(),
			agentDir: process.cwd(),
			sessionManager: SessionManager.inMemory(),
		});
		terminal = new VirtualTerminal(120, 40);
		mode = new InteractiveMode(runtime, { terminal, tuiMode });
		await mode.init();
	});

	afterEach(async () => {
		try {
			await runtime?.dispose();
		} finally {
			mode?.stop();
			vi.unstubAllEnvs();
		}
	});

	async function visible(): Promise<string> {
		await terminal.waitForRender();
		return terminal.getViewport().join("\n");
	}

	// Regression for #11166: a second dialog replaced the first one and the first promise never settled.
	it("shows the earlier confirm again after the later one is answered", async () => {
		const first = ui.confirm("First", "first dialog");
		const second = ui.confirm("Second", "second dialog");

		expect(await visible()).toContain("Second");
		terminal.sendInput("\x1b");
		await expect(second).resolves.toBe(false);
		expect(await visible()).toContain("First");
		terminal.sendInput("\r");
		await expect(first).resolves.toBe(true);
		ui.setEditorText("editor restored");
		expect(await visible()).toContain("editor restored");
	});

	it("removes a hidden dialog when its signal aborts", async () => {
		const controller = new AbortController();
		const first = ui.confirm("First", "first dialog", { signal: controller.signal });
		const second = ui.confirm("Second", "second dialog");

		controller.abort();
		await expect(first).resolves.toBe(false);
		expect(await visible()).toContain("Second");
		terminal.sendInput("\r");
		await expect(second).resolves.toBe(true);
	});

	// Regression for #9909: a second inline custom component replaced the first one and the first promise never settled.
	it("stacks concurrent inline custom components", async () => {
		const dones: Array<(result: string) => void> = [];
		const open = (label: string) =>
			ui.custom<string>((_tui, _theme, _keybindings, done) => {
				dones.push(done);
				return new Text(label);
			});
		const first = open("custom one");
		const second = open("custom two");
		expect(await visible()).toContain("custom two");

		dones[1]("two");
		await expect(second).resolves.toBe("two");
		expect(await visible()).toContain("custom one");
		dones[0]("one");
		await expect(first).resolves.toBe("one");
	});

	it("shows a confirm opened from an inline custom component and then restores the component", async () => {
		let confirmed: Promise<boolean> | undefined;
		let done: ((result: string) => void) | undefined;
		const custom = ui.custom<string>((_tui, _theme, _keybindings, finish) => {
			done = finish;
			return Object.assign(new Text("custom form"), {
				handleInput: () => {
					confirmed = ui.confirm("Discard?", "discard changes");
				},
			});
		});
		expect(await visible()).toContain("custom form");
		terminal.sendInput("x");
		expect(await visible()).toContain("Discard?");
		terminal.sendInput("\x1b");
		await expect(confirmed).resolves.toBe(false);
		expect(await visible()).toContain("custom form");
		done?.("kept");
		await expect(custom).resolves.toBe("kept");
	});

	it("restores an inline custom dialog after its built-in command settles", async () => {
		let command: Promise<boolean> | undefined;
		let settled = false;
		const custom = ui.custom<string>((_tui, _theme, _keybindings, done) =>
			Object.assign(new Text("custom command form"), {
				handleInput: (data: string) => {
					if (data === "s")
						command = extension.runCommand("/settings").then((result) => {
							settled = true;
							return result;
						});
					else done("finished");
				},
			}),
		);
		expect(await visible()).toContain("custom command form");
		terminal.sendInput("s");
		expect(await visible()).toContain("Auto-compact");
		expect(settled).toBe(false);
		terminal.sendInput("\x1b");
		await expect(command).resolves.toBe(true);
		expect(await visible()).toContain("custom command form");
		terminal.sendInput("x");
		await expect(custom).resolves.toBe("finished");
	});

	it.each([false, true])("keeps settings focused when a hidden dialog aborts with parent %s", async (withParent) => {
		const parent = withParent ? ui.confirm("Parent", "remaining dialog") : undefined;
		const controller = new AbortController();
		const hidden = ui.confirm("Hidden", "aborted dialog", { signal: controller.signal });
		let settled = false;
		const command = extension.runCommand("/settings").then((result) => {
			settled = true;
			return result;
		});
		expect(await visible()).toContain("Auto-compact");
		controller.abort();
		await expect(hidden).resolves.toBe(false);
		expect(await visible()).toContain("Auto-compact");
		expect(settled).toBe(false);
		terminal.sendInput("\x1b");
		await expect(command).resolves.toBe(true);
		if (withParent) {
			expect(await visible()).toContain("Parent");
			terminal.sendInput("\r");
			await expect(parent).resolves.toBe(true);
		} else {
			ui.setEditorText("fallback editor");
			expect(await visible()).toContain("fallback editor");
		}
	});

	it("updates the editor beneath dialogs without cancelling a built-in command", async () => {
		const originalEditor = ui.getEditorComponent();
		const dialog = ui.confirm("Editor owner", "keep this dialog");
		let settled = false;
		const command = extension.runCommand("/settings").then((result) => {
			settled = true;
			return result;
		});
		expect(await visible()).toContain("Auto-compact");
		ui.setEditorText("draft");
		ui.setEditorComponent((tui, editorTheme, keybindings) => new CustomEditor(tui, editorTheme, keybindings));
		expect(ui.getEditorComponent()).not.toBe(originalEditor);
		expect(await visible()).toContain("Auto-compact");
		expect(settled).toBe(false);
		terminal.sendInput("\x1b");
		await expect(command).resolves.toBe(true);
		expect(await visible()).toContain("Editor owner");
		ui.setEditorComponent(undefined);
		expect(await visible()).toContain("Editor owner");
		terminal.sendInput("\r");
		await expect(dialog).resolves.toBe(true);
		terminal.sendInput(" kept");
		expect(ui.getEditorText()).toBe("draft kept");
		expect(ui.getEditorComponent()).toBe(originalEditor);
	});

	it("settles a displaced built-in command when a new extension dialog takes ownership", async () => {
		const command = extension.runCommand("/settings");
		expect(await visible()).toContain("Auto-compact");
		const dialog = ui.confirm("Replacement", "cancel settings");
		await expect(command).resolves.toBe(true);
		expect(await visible()).toContain("Replacement");
		terminal.sendInput("\r");
		await expect(dialog).resolves.toBe(true);
	});

	it("settles a built-in command and restores the default editor during reload", async () => {
		ui.setEditorComponent((tui, editorTheme, keybindings) => new CustomEditor(tui, editorTheme, keybindings));
		const customEditor = ui.getEditorComponent();
		const command = extension.runCommand("/settings");
		expect(await visible()).toContain("Auto-compact");
		await expect(extension.runCommand("/reload")).resolves.toBe(true);
		await expect(command).resolves.toBe(true);
		expect(ui.getEditorComponent()).not.toBe(customEditor);
		terminal.sendInput("after reload");
		expect(ui.getEditorText()).toBe("after reload");
		expect(await visible()).toContain("after reload");
	});

	it("settles an active built-in command when the terminal stops", async () => {
		const command = extension.runCommand("/settings");
		expect(await visible()).toContain("Auto-compact");
		mode.stop();
		await expect(command).resolves.toBe(true);
	});
});

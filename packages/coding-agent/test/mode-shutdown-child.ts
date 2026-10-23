import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

const clientChild = process.argv[2] === "--mode";
const [mode, outcome, directory, layout] = clientChild
	? ["rpc", process.env.PI_TEST_CLEANUP_OUTCOME, process.env.PI_TEST_CLEANUP_DIRECTORY]
	: process.argv.slice(2);
if (!directory || !["print", "rpc", "interactive"].includes(mode ?? ""))
	throw new Error("Invalid shutdown child arguments");
process.env[ENV_AGENT_DIR] = directory;
let terminal: VirtualTerminal | undefined;
let pending = outcome === "pending";
let release!: () => void;
const held = new Promise<void>((resolve) => {
	release = resolve;
});
process.on("message", (message: unknown) => {
	if (message === "release") release();
	else if (message === "allow") pending = false;
	else if (typeof message === "string" && message.startsWith("input:") && terminal) {
		terminal.sendInput(message.slice(6));
		terminal.sendInput("\r");
	} else if (message === "view" && terminal) {
		void terminal.waitForRender().then(() => {
			const screen = terminal!.getViewport().join("\n");
			process.send?.(screen.includes("Shutdown incomplete") && screen.includes("live-owner") ? "reported" : screen);
		});
	} else if (typeof message === "string" && message.startsWith("probe")) {
		setImmediate(() => process.send?.(message));
	}
});

const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir: directory,
		settingsManager: SettingsManager.inMemory({ quietStartup: true, theme: "dark" }),
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("verify-owner", {
						description: "Verify the live extension context",
						handler: async (_args, ctx) => {
							pi.getActiveTools();
							ctx.ui.notify("Session remains usable");
							process.send?.("usable");
						},
					});
					pi.registerCommand("request-exit", {
						description: "Request interactive shutdown",
						handler: async (_args, ctx) => {
							ctx.shutdown();
						},
					});
					pi.on("session_start", () => {
						process.send?.("ready");
					});
					pi.on("session_cleanup", async ({ phase, signal }) => {
						process.send?.(phase);
						if (clientChild) appendFileSync(join(directory, "cleanup"), `${phase}\n`);
						if (phase === "prepare") {
							if (clientChild && outcome !== "held")
								await delay(outcome === "delayed" ? 1500 : 0, undefined, { signal });
							else await held;
						}
						if (pending && phase === "finish") return { pending: ["live-owner"] };
					});
				},
			],
		},
	});
	return {
		...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
		services,
		diagnostics: services.diagnostics,
	};
};
const runtime = await createAgentSessionRuntime(factory, {
	cwd: directory,
	agentDir: directory,
	sessionManager: SessionManager.inMemory(directory),
});
if (mode === "interactive") {
	terminal = new VirtualTerminal(120, 40);
	const interactive = new InteractiveMode(runtime, {
		terminal,
		tuiMode: layout === "fullscreen" ? "fullscreen" : "regular",
	});
	await interactive.init();
	process.send?.("initialized");
	await interactive.run();
} else if (mode === "rpc") await runRpcMode(runtime);
else {
	process.exitCode = await runPrintMode(runtime, { mode: "text" });
	process.disconnect?.();
}

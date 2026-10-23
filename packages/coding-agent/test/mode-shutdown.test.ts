import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

function startChild(mode: string, outcome: string, layout = "regular") {
	const directory = mkdtempSync(join(tmpdir(), "pi-mode-shutdown-"));
	const child = spawn(
		process.execPath,
		[
			"--import",
			fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url)),
			fileURLToPath(new URL("./mode-shutdown-child.ts", import.meta.url)),
			mode,
			outcome,
			directory,
			layout,
		],
		{ stdio: ["pipe", "pipe", "pipe", "ipc"] },
	);
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Missing child process pipes");
	const stdin = child.stdin;
	child.stdout.resume();
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const received = new Set<unknown>();
	child.on("message", (message) => received.add(message));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		rmSync(directory, { recursive: true, force: true });
	});
	async function waitFor(event: string): Promise<void> {
		if (received.has(event)) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => done(new Error(`Missing ${event}: ${stderr}`)), 10_000);
			const onMessage = (message: unknown) => {
				if (message === event) done();
			};
			const onExit = () => done(new Error(`Exited before ${event}: ${stderr}`));
			function done(error?: Error) {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("exit", onExit);
				if (error) reject(error);
				else resolve();
			}
			child.on("message", onMessage);
			child.once("exit", onExit);
		});
	}
	return { child, stdin, received, exited, waitFor, stderr: () => stderr };
}

describe.skipIf(process.platform === "win32")("real mode shutdown", () => {
	it.each(["delayed", "held", "pending"])("RpcClient joins stops and reports %s cleanup", async (outcome) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-rpc-stop-"));
		const resolver = fileURLToPath(new URL("../src/experimental/source-resolver.ts", import.meta.url));
		const client = new RpcClient({
			cliPath: fileURLToPath(new URL("./mode-shutdown-child.ts", import.meta.url)),
			env: {
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolver}`,
				PI_TEST_CLEANUP_DIRECTORY: directory,
				PI_TEST_CLEANUP_OUTCOME: outcome,
			},
		});
		cleanup.push(async () => {
			await client.stop().catch(() => {});
			rmSync(directory, { recursive: true, force: true });
		});
		await client.start();
		await client.getState();
		const stopped = outcome === "held" ? client.stop(300) : client.stop();
		expect(client.stop(1)).toBe(stopped);
		if (outcome === "delayed") await expect(stopped).resolves.toBeUndefined();
		else if (outcome === "held") await expect(stopped).rejects.toThrow("forced to stop after 300ms");
		else await expect(stopped).rejects.toThrow(/code=1 signal=null.*live-owner/s);
		expect(client.stop()).toBe(stopped);
		expect(readFileSync(join(directory, "cleanup"), "utf8")).toBe(
			outcome === "held" ? "prepare\n" : "prepare\nfinish\n",
		);
	});

	it.each([
		["quit", "regular"],
		["signal", "regular"],
		["quit", "fullscreen"],
	])("interactive %s (%s) recovers input and retries rejected cleanup", async (trigger, layout) => {
		const { child, received, exited, waitFor } = startChild("interactive", "pending", layout);
		await waitFor("initialized");
		if (trigger === "quit") child.send("input:/quit");
		else child.kill("SIGTERM");
		await waitFor("prepare");
		child.kill("SIGTERM");
		child.send("probe-interactive");
		await waitFor("probe-interactive");
		expect(received.has("finish")).toBe(false);
		child.send("release");
		await waitFor("finish");
		child.send("input:/verify-owner");
		await waitFor("usable");
		child.send("view");
		await waitFor("reported");
		child.send("allow");
		child.send("input:/request-exit");
		expect(await exited).toEqual({ code: 0, signal: null });
	});

	it.each(["print", "rpc"])("%s joins repeated signals until owned cleanup finishes", async (mode) => {
		const { child, stdin, received, exited, waitFor } = startChild(mode, "clean");
		await waitFor("ready");
		if (mode === "rpc") child.kill("SIGTERM");
		await waitFor("prepare");
		if (mode === "rpc") {
			const refusal = new Promise<unknown>((resolve) => {
				const detach = attachJsonlLineReader(child.stdout!, (line) => {
					const response = JSON.parse(line);
					if (response.id !== "closing-command") return;
					detach();
					resolve(response);
				});
			});
			stdin.write(`${JSON.stringify({ id: "closing-command", type: "get_state" })}\n`);
			await expect(refusal).resolves.toMatchObject({ type: "response", command: "get_state", success: false });
		}
		for (const probe of ["probe1", "probe2"]) {
			child.kill("SIGTERM");
			child.send(probe);
			await waitFor(probe);
		}
		expect(received.has("finish")).toBe(false);
		child.send("release");
		const result = await exited;
		expect(received.has("finish")).toBe(true);
		expect(result).toEqual({ code: 143, signal: null });
	});

	it.each(["print", "rpc"])("%s never exits cleanly with pending cleanup", async (mode) => {
		const { child, stdin, exited, waitFor, stderr } = startChild(mode, "pending");
		await waitFor("ready");
		if (mode === "rpc") stdin.end();
		await waitFor("prepare");
		child.send("release");
		await waitFor("finish");
		if (mode === "rpc") child.disconnect();
		expect(await exited).toEqual({ code: 1, signal: null });
		expect(stderr()).toContain("live-owner");
	});
});

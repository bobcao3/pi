import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { runClipboardCommand } from "../src/utils/clipboard-command.ts";

describe("clipboard commands", () => {
	test("preserves binary output and distinguishes empty success from failure", async () => {
		expect(
			await runClipboardCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0, 255, 10]))"]),
		).toEqual(Buffer.from([0, 255, 10]));
		expect(await runClipboardCommand(process.execPath, ["-e", ""])).toEqual(Buffer.alloc(0));
		expect(await runClipboardCommand(process.execPath, ["-e", "process.exit(1)"])).toBeUndefined();
		expect(await runClipboardCommand("pi-clipboard-command-does-not-exist", [])).toBeUndefined();
	});
	test("sends Unicode input to clipboard writers", async () => {
		const script =
			"let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => text += c); process.stdin.on('end', () => process.exit(text === 'café 日本語' ? 0 : 1));";
		expect(await runClipboardCommand(process.execPath, ["-e", script], { input: "café 日本語" })).toEqual(
			Buffer.alloc(0),
		);
	});
	test("timeout kills and joins a delayed-output child without blocking the event loop", async () => {
		let started!: (pid: number) => void;
		const ready = new Promise<number>((resolve) => {
			started = resolve;
		});
		let socket: Socket | undefined;
		let closed: Promise<void> | undefined;
		const server = createServer((connection) => {
			socket = connection;
			closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
			connection.on("error", () => {});
			connection.setEncoding("utf8");
			let data = "";
			connection.on("data", (chunk) => {
				data += chunk;
				if (data.endsWith("\n")) started(Number(data));
			});
		});
		let command: Promise<Buffer | undefined> | undefined;
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		try {
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
			ticks = 0;
			command = runClipboardCommand(
				process.execPath,
				[
					"-e",
					`
const socket = require('node:net').connect(${address.port}, '127.0.0.1', () => socket.write(process.pid + '\\n'));
setTimeout(() => {
  socket.end();
  process.stdout.write('late clipboard contents', () => process.exit(0));
}, 10000);
`,
				],
				{ timeoutMs: 5000 },
			);
			const pid = await Promise.race([ready, command.then(() => undefined)]);
			expect(pid).toBeDefined();
			if (pid === undefined) return;
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			expect(await command).toBeUndefined();
			expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
			await closed;
			expect(ticks).toBeGreaterThan(0);
		} finally {
			await command;
			clearInterval(timer);
			socket?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 15000);
	// #11179: clipboard daemons must not share pi's process group, or Ctrl+Z suspend stops them.
	test.skipIf(process.platform === "win32")("runs commands outside pi's process group", async () => {
		const childPgid = (await runClipboardCommand("sh", ["-c", "ps -o pgid= -p $$"]))?.toString("utf8").trim();
		const ownPgid = (await runClipboardCommand("ps", ["-o", "pgid=", "-p", String(process.pid)]))
			?.toString("utf8")
			.trim();
		expect(childPgid).toMatch(/^\d+$/);
		expect(ownPgid).toMatch(/^\d+$/);
		expect(childPgid).not.toBe(ownPgid);
	});
	test("rejects output above the buffer limit", async () => {
		expect(
			await runClipboardCommand(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(1024))"], {
				maxBufferBytes: 16,
			}),
		).toBeUndefined();
	});
});

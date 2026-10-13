import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "../src/components/text.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("selection inside an overlay copies only overlay content", async () => {
	const terminal = new VirtualTerminal(30, 6);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const lines = ["overlay alpha", "overlay beta", "overlay gamma"];
	const overlay: Component = {
		render: (width) => lines.map((line) => line.padEnd(width)),
		invalidate: () => {},
	};
	tui.addChild(new Text(Array.from({ length: 6 }, (_, row) => `underlying transcript ${row}`).join("\n"), 0, 0));

	try {
		tui.start();
		const handle = tui.showOverlay(overlay, { anchor: "center", width: 20 });
		await terminal.waitForRender();
		const bounds = handle.getBounds();
		assert.ok(bounds);
		const send = (button: number, x: number, y: number, suffix: "M" | "m") =>
			terminal.sendInput(`\x1b[<${button};${x + 1};${y + 1}${suffix}`);
		send(0, bounds.col, bounds.row, "M");
		send(32, bounds.col + 12, bounds.row + 2, "M");
		send(0, bounds.col + 12, bounds.row + 2, "m");
		await terminal.waitForRender();

		assert.deepEqual(copied, [lines.join("\n")]);

		tui.resetTextSelection();
		send(0, bounds.col, bounds.row, "M");
		send(32, terminal.columns - 1, terminal.rows - 1, "M");
		send(0, terminal.columns - 1, terminal.rows - 1, "m");
		await terminal.waitForRender();

		assert.deepEqual(copied, [lines.join("\n"), lines.join("\n")]);
	} finally {
		tui.stop();
	}
});

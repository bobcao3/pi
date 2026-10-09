import assert from "node:assert";
import { describe, it } from "node:test";
import { type TreeNode, TreeView } from "../src/components/tree-view.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventType } from "../src/tui.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 20): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false };
}

class ProbeBody implements Component {
	events: TuiMouseEvent[] = [];

	render(width: number): string[] {
		return ["body".slice(0, width)];
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent) {
		this.events.push(event);
		return { handled: true, focus: true };
	}
}

const plain = (lines: string[]): string[] => lines.map((line) => stripTerminalSequences(line));

describe("TreeView", () => {
	it("expands forest roots independently", () => {
		const tree = new TreeView([
			{ id: "a", label: "A", children: [{ id: "a.1", label: "A child" }] },
			{ id: "b", label: "B", children: [{ id: "b.1", label: "B child" }] },
		]);

		assert.deepEqual(plain(tree.render(40)), ["  ▸ A", "  ▸ B"]);
		assert.equal(tree.handleMouse(mouse("click", 2, 0))?.handled, true);
		assert.deepEqual(plain(tree.render(40)), ["  ▾ A", "  │ └─  A child", "  ▸ B"]);
		assert.equal(tree.getRowPosition("b.1"), undefined);
	});

	it("preserves open descendants and selection through update, reorder, and resize", () => {
		const state = { open: new Map<string, boolean>(), shownChildren: new Map<string, number>() };
		const roots: TreeNode[] = [
			{ id: "a", label: "A", children: [{ id: "b", label: "B", children: [{ id: "c", label: "C" }] }] },
			{ id: "d", label: "D" },
		];
		const tree = new TreeView(roots, { state });

		tree.reveal("c");
		assert.equal(tree.getSelectedId(), "c");
		tree.update([roots[1]!, roots[0]!]);
		assert.equal(tree.getSelectedId(), "c");
		assert.equal(
			tree.render(24).some((line) => stripTerminalSequences(line).includes("C")),
			true,
		);

		tree.handleInput("\x1b[A");
		tree.handleInput("\x1b[A");
		assert.equal(tree.getSelectedId(), "a");
		tree.handleInput("\x1b[D");
		assert.equal(state.open.get("a"), false);
		tree.update([roots[1]!, roots[0]!]);
		tree.handleInput("\x1b[C");
		assert.equal(
			tree.render(16).some((line) => stripTerminalSequences(line).includes("C")),
			true,
		);
	});

	it("fits ANSI and wide unicode text into narrow widths", () => {
		const tree = new TreeView(
			[{ id: "wide", label: "測試 \x1b[31mred\x1b[0m", summary: "summary", metadata: ["meta"] }],
			{ theme: { selected: (text) => `\x1b[7m${text}\x1b[0m` } },
		);

		for (const width of [0, 1, 2, 5]) {
			for (const line of tree.render(width)) assert.ok(visibleWidth(line) <= width);
			tree.invalidate();
		}
	});

	it("uses configurable tree keybindings", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.tree.down": "j", "tui.tree.up": "k" }));
		try {
			const tree = new TreeView([
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			]);

			tree.handleInput("\x1b[B");
			assert.equal(tree.getSelectedId(), "a");
			tree.handleInput("j");
			assert.equal(tree.getSelectedId(), "b");
			tree.handleInput("k");
			assert.equal(tree.getSelectedId(), "a");
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});

	it("paginates large child sets and asserts duplicate ids", () => {
		const children = Array.from({ length: 205 }, (_, index) => ({ id: `child-${index}`, label: `Child ${index}` }));
		const tree = new TreeView([{ id: "root", label: "Root", defaultOpen: true, children }]);

		let rendered = plain(tree.render(80));
		assert.equal(
			rendered.some((line) => line.includes("Child 204")),
			false,
		);
		assert.equal(
			rendered.some((line) => line.includes("5 more")),
			true,
		);
		const moreRow = rendered.findIndex((line) => line.includes("5 more"));
		assert.equal(tree.handleMouse(mouse("click", 1, moreRow))?.handled, true);
		rendered = plain(tree.render(80));
		assert.equal(
			rendered.some((line) => line.includes("Child 204")),
			true,
		);
		assert.throws(
			() =>
				new TreeView([
					{ id: "x", label: "X" },
					{ id: "x", label: "Y" },
				]),
			/duplicate id x/,
		);
	});

	it("keeps mouse toggling on the marker and dispatches body clicks with translated coordinates", () => {
		const body = new ProbeBody();
		const tree = new TreeView([{ id: "a", label: "A", body }]);

		tree.render(40);
		assert.equal(tree.handleMouse(mouse("click", 5, 0))?.handled, true);
		assert.equal(tree.getSelectedId(), "a");
		assert.deepEqual(plain(tree.render(40)), ["  ▸ A"]);
		assert.equal(tree.handleMouse(mouse("click", 2, 0))?.handled, true);
		assert.deepEqual(plain(tree.render(40)).slice(0, 2), ["  ▾ A", "      body"]);

		const result = tree.handleMouse(mouse("click", 8, 1));
		assert.equal(result?.handled, true);
		assert.equal(result?.focus, false);
		assert.equal(body.events[0]?.x, 2);
		assert.equal(body.events[0]?.y, 0);
		assert.equal(tree.handleMouse({ ...mouse("wheel", 1, 1), wheelDelta: 1 }), undefined);
	});
});

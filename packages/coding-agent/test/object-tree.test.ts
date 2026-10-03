import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
	ObjectTreeComponent,
	type ObjectTreeState,
	parseTreeOutput,
} from "../src/modes/interactive/components/object-tree.ts";
import { getThemeByName, initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark", false);
const theme = getThemeByName("dark")!;
const plain = (component: Component, width = 100) => component.render(width).map(stripTerminalSequences);
function click(component: Component, pattern: RegExp, width = 100): void {
	const lines = plain(component, width);
	const y = lines.findIndex((line) => pattern.test(line));
	expect(y).toBeGreaterThanOrEqual(0);
	const x = lines[y].search(/[▸▾]/);
	expect(x).toBeGreaterThanOrEqual(0);
	expect(
		component.handleMouse?.({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled,
	).toBe(true);
}

test("tree markup distinguishes literal dotted keys and JSON scalar types without excessive punctuation", () => {
	const component = new ObjectTreeComponent(
		{
			label: "values",
			expanded: true,
			value: {
				"a.b": { c: "false" },
				a: { b: false },
				empty: "",
				numeric: "123",
				zero: 0,
				nullable: null,
				selector: "#tma video",
				list: [{ value: "中文👩‍💻" }],
			},
		},
		theme,
	);
	const lines = plain(component);
	expect(lines.join("\n")).toMatch(/\["a.b"\].c:\s+"false"/);
	expect(lines.join("\n")).toMatch(/a.b:\s+false/);
	expect(lines.join("\n")).toMatch(/empty:\s+""/);
	expect(lines.join("\n")).toMatch(/numeric:\s+"123"/);
	expect(lines.join("\n")).toMatch(/zero:\s+0/);
	expect(lines.join("\n")).toMatch(/nullable:\s+null/);
	expect(lines.join("\n")).toMatch(/selector:\s+"#tma video"/);
	expect(lines.join("\n")).toContain("list[0].value:");
	const colors = component.render(100).join("\n");
	expect(colors).toContain("\x1b[2m");
	expect(colors).toMatch(/\x1b\[(?:38;|3[0-7])/);
	expect(colors).not.toMatch(/\x1b\[(?:48;|4[0-7])[^m]*m/);
	const collapsed = new ObjectTreeComponent(
		{
			label: "browser_take_screenshot",
			prefix: "✓ ",
			suffix: "229ms",
			value: { scale: "css", target: "#tma video" },
		},
		theme,
	);
	expect(plain(collapsed)[0]).toBe('✓ ▸ browser_take_screenshot scale=css target="#tma video" · 229ms');
	for (let width = 1; width <= 100; width++) {
		expect(collapsed.render(width)).toHaveLength(1);
		expect(visibleWidth(collapsed.render(width)[0])).toBeLessThanOrEqual(width);
	}
});

test("the tree paginates arrays, bounds hostile values, and never invokes accessors or leaks image payloads", () => {
	const state: ObjectTreeState = {};
	const value: Record<string, unknown> = {
		items: Array.from({ length: 70 }, (_, index) => ({ index, value: `entry-${index}` })),
	};
	const component = new ObjectTreeComponent({ label: "data", value, state, expanded: true }, theme);
	click(component, /▸ items:/);
	expect(plain(component).join("\n")).not.toContain("entry-32");
	click(component, /▸ 38 more items/);
	expect(plain(component).join("\n")).toContain("entry-32");
	let accesses = 0;
	Object.defineProperty(value, "accessor", {
		enumerable: true,
		get() {
			accesses++;
			throw new Error("must not execute");
		},
	});
	value.cycle = value;
	value.image = { type: "image", mimeType: "image/png", data: "NEVER_PRINT_BASE64" };
	value.unsafe = "safe\x1b]52;c;evil\x07\x1b[2Jdone\u202e";
	const guarded = new ObjectTreeComponent({ label: "data", value, expanded: true }, theme);
	click(guarded, /▸ image:/);
	expect(accesses).toBe(0);
	const output = plain(guarded).join("\n");
	expect(output).toContain("[accessor]");
	expect(output).toContain("[reference: /]");
	expect(output).toContain("[image data]");
	expect(output).toContain("safedone");
	expect(output).not.toMatch(/NEVER_PRINT_BASE64|evil|\u202e/);
	const oversized = new ObjectTreeComponent({ label: "large", value: "x".repeat(300000), expanded: true }, theme);
	expect(oversized.render(80).length).toBeLessThanOrEqual(257);
	expect(plain(oversized).join("\n")).toContain("display limit");
});

test("structured output detection accepts whole JSON and JSON records without guessing inside prose or strings", () => {
	expect(parseTreeOutput('{"content":[{"type":"text","text":"hello\\nworld"}]}')).toEqual({
		content: [{ type: "text", text: "hello\nworld" }],
	});
	expect(parseTreeOutput('{"id":1}\n{"id":2}\n')).toEqual([{ id: 1 }, { id: 2 }]);
	for (const value of ['prefix {"id":1}', '{"id":1}\nnot json', '{"partial":', '{"text":"{\\"id\\":1}"}']) {
		const parsed = parseTreeOutput(value);
		if (value.startsWith('{"text"')) expect(parsed).toEqual({ text: '{"id":1}' });
		else expect(parsed).toBe(value);
	}
});

import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { McpManagerView } from "../src/extensions/mcp/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESCAPE = "\x1b";
const tui = new TuiMainScreen(new VirtualTerminal());

function rendered(view: McpManagerView): string {
	return stripAnsi(view.render(80).join("\n"));
}

describe("MCP manager status screen", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// #10565
	test("cancels the running operation with the cancel key", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const controller = new AbortController();
		view.status("Sign in to issues", "Contacting the authorization server…", () => controller.abort());
		expect(rendered(view)).toContain("ESC to dismiss");
		view.handleInput(ESCAPE);
		expect(controller.signal.aborted).toBe(true);
	});

	test("ignores the cancel key for operations that cannot be cancelled", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.status("Sign in to issues", "Connecting…");
		const before = rendered(view);
		expect(before).not.toContain("to dismiss");
		view.handleInput(ESCAPE);
		expect(rendered(view)).toBe(before);
	});

	test.each([{ items: [] }, { items: [{ value: "issues", label: "Issues" }] }])(
		"dismisses menus and removes their live subscription",
		async ({ items }) => {
			const view = new McpManagerView(tui, theme, new KeybindingsManager());
			const listeners = new Set<() => void>();
			const selection = view.menu(
				() => ({ title: "MCP servers", items, confirmLabel: "manage", cancelLabel: "close" }),
				(listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			);
			expect(rendered(view)).toContain("ESC to dismiss");
			expect(listeners.size).toBe(1);
			view.handleInput(ESCAPE);
			expect(await selection).toBeUndefined();
			expect(listeners.size).toBe(0);
		},
	);

	test("dismisses redirect entry without submitting partial input and accepts a later callback", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.focused = true;
		const first = view.redirectUrl("Sign in", "https://example.com/authorize", new AbortController().signal);
		expect(rendered(view)).toContain("ESC to dismiss");
		view.handleInput("partial");
		view.handleInput(ESCAPE);
		expect(await first).toBeUndefined();
		const callback = new AbortController();
		const second = view.redirectUrl("Sign in", "https://example.com/authorize", callback.signal);
		callback.abort();
		expect(await second).toBeUndefined();
	});

	test("displays and handles the rebound cancel key", async () => {
		const keybindings = new KeybindingsManager({ "tui.select.cancel": "ctrl+g" });
		setKeybindings(keybindings);
		const view = new McpManagerView(tui, theme, keybindings);
		const selection = view.menu(() => ({
			title: "Exposure",
			items: [{ value: "direct", label: "Direct" }],
			confirmLabel: "save",
			cancelLabel: "back",
		}));
		expect(rendered(view)).toContain("ctrl+g to dismiss");
		expect(rendered(view)).not.toContain("ESC to dismiss");
		view.handleInput(ESCAPE);
		view.handleInput("\x07");
		expect(await selection).toBeUndefined();
	});
});

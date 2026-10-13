import { SettingsList, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { SelectSubmenu, SteppedSubmenu } from "../src/modes/interactive/components/settings-submenu.ts";
import { getSettingsListTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function output(component: { render: (width: number) => string[] }): string {
	return stripAnsi(component.render(80).join("\n"));
}

describe("setup and submenu dismissal", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => setKeybindings(new KeybindingsManager()));

	it.each([false, true])("dismisses setup without opting in after analytics step %s", (analyticsStep) => {
		const events: string[] = [];
		const setup = new FirstTimeSetupComponent({
			onThemePreview: (name) => events.push(name),
			onSubmit: () => events.push("submit"),
			onCancel: () => events.push("cancel"),
		});
		setup.handleInput("\x1b[B");
		if (analyticsStep) setup.handleInput("\r");
		expect(output(setup)).toContain("ESC to dismiss");
		setup.handleInput("\x1b");
		expect(events).toEqual(["dark", "cancel"]);
	});

	it("honors a custom cancel key even when setup navigation uses the same letter", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.cancel": "k" }));
		const events: string[] = [];
		const setup = new FirstTimeSetupComponent({
			onThemePreview: () => events.push("preview"),
			onSubmit: () => events.push("submit"),
			onCancel: () => events.push("cancel"),
		});
		expect(output(setup)).toContain("k to dismiss");
		expect(output(setup)).not.toContain("ESC to dismiss");
		setup.handleInput("\x1b");
		expect(events).toEqual([]);
		setup.handleInput("k");
		expect(events).toEqual(["cancel"]);
	});

	it.each([false, true])("dismisses a searchable %s submenu without selecting a value", (searchable) => {
		const events: string[] = [];
		const submenu = new SelectSubmenu(
			"Choose",
			"",
			[{ value: "danger", label: "Dangerous action" }],
			"danger",
			(value) => events.push(value),
			() => events.push("cancel"),
			undefined,
			{ searchable },
		);
		if (searchable) submenu.handleInput("z");
		expect(output(submenu)).toContain("ESC to dismiss");
		submenu.handleInput("\x1b");
		expect(events).toEqual(["cancel"]);
	});

	it("honors custom submenu confirmation and cancellation instead of claiming Escape works", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+x" }));
		const events: string[] = [];
		const submenu = new SelectSubmenu(
			"Choose",
			"",
			[{ value: "value", label: "Value" }],
			"value",
			(value) => events.push(value),
			() => events.push("cancel"),
			undefined,
			{ searchable: true },
		);
		expect(output(submenu)).toContain("ctrl+s to select");
		expect(output(submenu)).toContain("ctrl+x to dismiss");
		expect(output(submenu)).not.toContain("ESC to dismiss");
		submenu.handleInput("\x1b");
		expect(events).toEqual([]);
		submenu.handleInput("\x18");
		expect(events).toEqual(["cancel"]);
	});

	it("backs out of an unfinished stepped submenu without completing the operation", () => {
		const events: string[] = [];
		const submenu = new SteppedSubmenu(
			["First", "Second"].map((title) => ({
				key: title,
				title,
				description: "",
				options: () => [{ value: title, label: title }],
			})),
			() => events.push("complete"),
			() => events.push("cancel"),
		);
		submenu.handleInput("\r");
		expect(output(submenu)).toContain("Second");
		submenu.handleInput("\x1b");
		expect(output(submenu)).toContain("First");
		expect(events).toEqual([]);
		submenu.handleInput("\x1b");
		expect(events).toEqual(["cancel"]);
	});

	it.each([true, false])("only advertises dismissal for a cancellable %s loader", (cancellable) => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const loader = new BorderedLoader(ui, theme, "Working...", { cancellable });
		let aborted = false;
		loader.onAbort = () => {
			aborted = true;
		};
		try {
			if (cancellable) expect(output(loader)).toContain("ESC to dismiss");
			else expect(output(loader)).not.toContain("to dismiss");
			loader.handleInput("\x1b");
			expect(loader.signal.aborted).toBe(cancellable);
			expect(aborted).toBe(cancellable);
		} finally {
			loader.dispose();
			ui.stop();
		}
	});

	it.each([false, true])("dismisses empty settings with search %s without changing settings", (enableSearch) => {
		const events: string[] = [];
		const settings = new SettingsList(
			[],
			8,
			getSettingsListTheme(),
			() => events.push("change"),
			() => events.push("cancel"),
			{ enableSearch },
		);
		expect(output(settings)).toContain("ESC to dismiss");
		settings.handleInput("\x1b");
		expect(events).toEqual(["cancel"]);
	});
});

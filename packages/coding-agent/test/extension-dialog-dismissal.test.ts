import { type Component, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { ShowImagesSelectorComponent } from "../src/modes/interactive/components/show-images-selector.ts";
import { ThemeSelectorComponent } from "../src/modes/interactive/components/theme-selector.ts";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function output(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(80).join("\n"));
}

describe("extension dialog dismissal", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it.each(["\x1b", "\x1b[27u"])("dismisses bundled dialogs without submitting with %j", (keyData) => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const events: string[] = [];
		const submit = () => {
			events.push("submit");
		};
		const cancel = () => events.push("cancel");
		const images = new ShowImagesSelectorComponent(true, submit, cancel);
		const themeSelector = new ThemeSelectorComponent("dark", submit, cancel, () => {});
		const messages = new UserMessageSelectorComponent([{ id: "message", text: "Unsaved fork" }], submit, cancel);
		const components = [
			new ExtensionSelectorComponent("Permission", ["Yes", "No"], submit, cancel),
			new ExtensionInputComponent("Input", undefined, submit, cancel, { initialValue: "unsaved" }),
			new ExtensionEditorComponent(ui, new KeybindingsManager(), "Editor", "unsaved", submit, cancel),
			new OAuthSelectorComponent("logout", [], submit, cancel),
			new ScopedModelsSelectorComponent(
				{ allModels: [], enabledModelIds: null },
				{ onChange: submit, onPersist: submit, onCancel: cancel },
			),
			new ThinkingSelectorComponent("off", ["off", "high"], submit, cancel),
			new TrustSelectorComponent({
				cwd: "/tmp/dialog-dismissal",
				savedDecision: null,
				projectTrusted: false,
				onSelect: submit,
				onCancel: cancel,
			}),
			images,
			themeSelector,
			messages,
		];
		try {
			for (const component of components) {
				expect(output(component)).toContain("ESC to dismiss");
				const input: Component =
					component === images
						? images.getSelectList()
						: component === themeSelector
							? themeSelector.getSelectList()
							: component === messages
								? messages.getMessageList()
								: component;
				input.handleInput?.(keyData);
			}
			expect(events).toEqual(Array(components.length).fill("cancel"));
		} finally {
			ui.stop();
		}
	});

	it("keeps the dismissal hint across login states and rejects pending credentials on Escape", async () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const results: boolean[] = [];
		const dialog = new LoginDialogComponent(ui, "test", (success) => results.push(success));
		try {
			const stages = [
				() => {},
				() => dialog.showInfo("Configure credentials outside pi."),
				() => dialog.showDetails(["Credential setup"]),
				() => dialog.showDeviceCode({ userCode: "ABCD", verificationUri: "https://example.invalid/device" }),
				() => dialog.showWaiting("Waiting for authentication..."),
				() => dialog.showProgress("Authorizing..."),
			];
			for (const stage of stages) {
				stage();
				expect(output(dialog)).toContain("ESC to dismiss");
			}
			const pending = dialog.showManualInput("Paste callback URL:");
			const rejected = expect(pending).rejects.toThrow("Login cancelled");
			dialog.handleInput("secret");
			dialog.handleInput("\x1b[27u");
			await rejected;
			expect(dialog.signal.aborted).toBe(true);
			expect(results).toEqual([false]);
		} finally {
			ui.stop();
		}
	});
});

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { MarkdownTransformContext, ThinkingRenderer, ThinkingRenderOptions } from "../src/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openrouter",
		model: "routing-alias",
		responseModel: "anthropic/claude-opus-4.8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

function rendered(component: AssistantMessageComponent, width = 80): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("thinking renderer interception", () => {
	test("loads the first registered renderer and passes historical message identity without consulting the active model", async () => {
		initTheme("dark");
		const session = SessionManager.inMemory();
		const original = message([{ type: "thinking", thinking: "historical reasoning" }]);
		session.appendMessage(original);
		const historical = session.buildSessionContext().messages.find((entry) => entry.role === "assistant");
		expect(historical?.role).toBe("assistant");
		if (historical?.role !== "assistant") throw new Error("Missing assistant history");
		const snapshots: ThinkingRenderOptions[] = [];
		const renderer: ThinkingRenderer = (blocks, options, activeTheme) => {
			snapshots.push(options);
			return new Text(activeTheme.fg("accent", `${options.message.responseModel}: ${blocks.join("|")}`), 0, 0);
		};
		const runtime = createExtensionRuntime();
		const events = createEventBus();
		const cwd = process.cwd();
		const empty = await loadExtensionFromFactory(() => {}, cwd, events, runtime, "<empty>");
		const first = await loadExtensionFromFactory(
			(api) => api.registerThinkingRenderer(renderer),
			cwd,
			events,
			runtime,
			"<first>",
		);
		const second = await loadExtensionFromFactory(
			(api) => api.registerThinkingRenderer(() => new Text("wrong renderer", 0, 0)),
			cwd,
			events,
			runtime,
			"<second>",
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([empty, first, second], runtime, cwd, session, registry);
		const component = new AssistantMessageComponent(
			historical,
			true,
			undefined,
			"Thinking...",
			1,
			runner.getMarkdownTransformers(),
			runner.getThinkingRenderer(),
		);
		expect(rendered(component)).toContain("anthropic/claude-opus-4.8: historical reasoning");
		expect(snapshots[0].message).toBe(historical);
		expect(snapshots[0]).toMatchObject({ hidden: true, expanded: false, isStreaming: false });
		expect(historical).toEqual(original);
		expect(new ExtensionRunner([empty], runtime, cwd, session, registry).getThinkingRenderer()).toBeUndefined();
	});

	test("preserves independent run state across streaming, theme invalidation and padding rebuilds, then resets visibility", () => {
		initTheme("dark");
		const snapshots: ThinkingRenderOptions[] = [];
		const blocksSeen: string[][] = [];
		const renderer: ThinkingRenderer = (blocks, options, activeTheme) => {
			expect(activeTheme).toBe(theme);
			snapshots.push(options);
			blocksSeen.push([...blocks]);
			options.state.visits = Number(options.state.visits ?? 0) + 1;
			return new Text(`${blocks[0]} visit ${options.state.visits}`, 0, 0);
		};
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [], renderer);
		const initial = message([
			{ type: "thinking", thinking: " first " },
			{ type: "thinking", thinking: " " },
			{ type: "thinking", thinking: " second " },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "last" },
		]);
		component.updateContent(initial, true);
		const [first, last] = snapshots;
		expect(first.state).not.toBe(last.state);
		expect(first).toMatchObject({ message: initial, hidden: false, expanded: false, isStreaming: true });
		expect(blocksSeen).toEqual([["first", "second"], ["last"]]);
		first.state.selection = "retained";
		const final = message([...initial.content, { type: "thinking", thinking: "new detail" }]);
		component.updateContent(final, false);
		initTheme("light");
		component.invalidate();
		component.setOutputPad(0);
		for (const snapshot of snapshots.filter((_, index) => index % 2 === 0)) {
			expect(snapshot.state).toBe(first.state);
			expect(snapshot.state.selection).toBe("retained");
		}
		for (const snapshot of snapshots.filter((_, index) => index % 2 === 1)) {
			expect(snapshot.state).toBe(last.state);
			expect(snapshot.state.selection).toBeUndefined();
		}
		expect(rendered(component)).toContain("first visit 4");
		expect(rendered(component)).toContain("last visit 4");
		expect(snapshots.at(-1)).toMatchObject({ message: final, isStreaming: false });
		const independent = new AssistantMessageComponent(initial, false, undefined, "Thinking...", 1, [], renderer);
		expect(rendered(independent)).toContain("first visit 1");
		expect(snapshots.at(-2)?.state).not.toBe(first.state);
		component.setHideThinkingBlock(false);
		expect(snapshots.at(-2)).toMatchObject({ hidden: false, expanded: true, state: { visits: 1 } });
		expect(snapshots.at(-2)?.state).not.toBe(first.state);
		component.setHideThinkingBlock(true);
		expect(snapshots.at(-2)).toMatchObject({ hidden: true, expanded: false, state: { visits: 1 } });
	});

	test("keeps run identity when an earlier empty run gains streamed content", () => {
		initTheme("dark");
		const states = new Map<string, Record<string, unknown>>();
		const renderer: ThinkingRenderer = (blocks, options) => {
			states.set(blocks[0], options.state);
			return new Text(blocks.join("\n"), 0, 0);
		};
		const initial = message([
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "last" },
		]);
		const component = new AssistantMessageComponent(initial, false, undefined, "Thinking...", 1, [], renderer);
		const lastState = states.get("last");
		component.updateContent(message([{ type: "thinking", thinking: "first" }, ...initial.content.slice(1)]), true);
		expect(states.get("last")).toBe(lastState);
		expect(states.get("first")).not.toBe(lastState);
	});

	test("supplies width-aware thinking Markdown transforms and falls back to the default block on undefined", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const markdownTheme = getMarkdownTheme();
		const original = message([{ type: "thinking", thinking: "original" }]);
		const renderer: ThinkingRenderer = (blocks, options) => {
			expect(options.markdownTheme).toBe(markdownTheme);
			if (options.hidden) return undefined;
			return new Markdown(blocks.join("\n\n"), 0, 0, options.markdownTheme, undefined, {
				transform: options.transform,
			});
		};
		const component = new AssistantMessageComponent(
			undefined,
			false,
			markdownTheme,
			"Fallback label",
			1,
			[
				(markdown, context) => {
					contexts.push(context);
					return markdown.replace("original", `transformed ${context.availableWidth}`);
				},
			],
			renderer,
		);
		component.updateContent(original, true);
		expect(rendered(component, 40)).toContain("transformed 40");
		expect(rendered(component, 24)).toContain("transformed 24");
		component.updateContent(original, false);
		expect(rendered(component, 40)).toContain("transformed 40");
		expect(contexts).toEqual([
			{ messageType: "assistant-thinking", isStreaming: true, availableWidth: 40 },
			{ messageType: "assistant-thinking", isStreaming: true, availableWidth: 24 },
			{ messageType: "assistant-thinking", isStreaming: false, availableWidth: 40 },
		]);
		component.setHideThinkingBlock(true);
		expect(rendered(component)).toContain("💡 Fallback label");
		expect(rendered(component)).not.toContain("transformed");
		const defaultComponent = new AssistantMessageComponent(
			original,
			false,
			markdownTheme,
			"Fallback label",
			1,
			[],
			() => undefined,
		);
		expect(rendered(defaultComponent)).toContain("💡 original");
		expect(original.content).toEqual([{ type: "thinking", thinking: "original" }]);
	});
});

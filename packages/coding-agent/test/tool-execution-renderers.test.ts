import { Text, TuiMainScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createToolHtmlRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import type { ToolExecutionRenderContext, ToolExecutionSnapshot } from "../src/core/tool-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionBatchComponent } from "../src/modes/interactive/components/tool-execution-batch.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class ExecutionView extends Text {
	disposed = false;
	expanded = false;
	input = "";
	mouseRow?: number;

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	handleInput(data: string): void {
		this.input = data;
	}
	handleMouse(event: TuiMouseEvent): { handled: true } {
		this.mouseRow = event.y;
		return { handled: true };
	}
	dispose(): void {
		this.disposed = true;
	}
}

const result = { content: [{ type: "text" as const, text: "done" }], details: undefined, isError: false };
const ui = () => new TuiMainScreen(new VirtualTerminal(80, 24));

describe("full execution rendering boundary", () => {
	beforeAll(() => initTheme("dark"));

	it("preserves state and component ownership across lifecycle, input and replacement", () => {
		const views: ExecutionView[] = [];
		let context: ToolExecutionRenderContext;
		let snapshot: ToolExecutionSnapshot;
		let replace = false;
		const renderers: ToolRenderers = {
			renderCall: () => new Text("legacy", 0, 0),
			renderExecution: (nextSnapshot, _theme, nextContext) => {
				snapshot = nextSnapshot;
				context = nextContext;
				context.state.token ??= "shared";
				const view =
					!replace && context.lastComponent instanceof ExecutionView
						? context.lastComponent
						: new ExecutionView("", 0, 0);
				if (!views.includes(view)) views.push(view);
				view.setText(`${snapshot.phase} ${context.state.token} ${context.outputPad}`);
				return view;
			},
		};
		const host = new ToolExecutionComponent(
			"custom",
			"call",
			{ a: 1 },
			{ resolveToolRenderers: () => renderers },
			renderers,
			ui(),
			"/tmp",
		);
		expect(
			host
				.render(80)
				.map((line) => stripAnsi(line).trimEnd())
				.join("\n"),
		).toBe("\narguments shared 1");
		host.setArgsComplete();
		expect(snapshot!.phase).toBe("queued");
		host.markExecutionStarted();
		expect(snapshot!.phase).toBe("running");
		host.updateResult({ ...result, durationMs: 23 });
		expect(snapshot!.durationMs).toBe(23);
		expect(snapshot!.phase).toBe("complete");
		host.setExpanded(true);
		host.setShowImages(false);
		host.setImageWidthCells(17);
		host.setOutputPad(4);
		expect(views).toHaveLength(1);
		expect(views[0].expanded).toBe(true);
		expect(context!.resolveToolRenderers?.("custom")).toBe(renderers);
		expect(context!).toMatchObject({ showImages: false, imageWidthCells: 17, outputPad: 4 });
		host.handleInput("x");
		expect(views[0].input).toBe("x");
		host.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: 1,
			screenX: 0,
			screenY: 1,
			width: 80,
			height: 2,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(views[0].mouseRow).toBe(0);
		expect(views[0].expanded).toBe(true);
		replace = true;
		host.updateArgs({ a: 2 });
		expect(views[0].disposed).toBe(true);
		expect(views[1].disposed).toBe(false);
		host.dispose();
		host.dispose();
		expect(views[1].disposed).toBe(true);
	});

	it("retains live nested results while merging persisted summaries", () => {
		const host = new ToolExecutionComponent(
			"custom",
			"root",
			{},
			{},
			{ renderExecution: () => new Text("", 0, 0) },
			ui(),
			"/tmp",
		);
		host.updateNestedEvent({
			type: "tool_execution_start",
			toolCallId: "root/1",
			parentToolCallId: "root",
			toolName: "read",
			args: { path: "a" },
		});
		host.updateNestedEvent({
			type: "tool_execution_update",
			toolCallId: "root/1",
			parentToolCallId: "root",
			toolName: "read",
			args: { path: "a" },
			partialResult: result,
		});
		expect(host.getSnapshot().nestedCalls?.[0]).toMatchObject({ phase: "running", result });
		host.updateNestedEvent({
			type: "tool_execution_end",
			toolCallId: "root/1",
			parentToolCallId: "root",
			toolName: "read",
			result,
			isError: false,
			durationMs: 5,
		});
		host.updateResult({
			...result,
			nestedCalls: {
				complete: true,
				calls: [
					{ id: "root/1", name: "read", arguments: { path: "a" }, status: "ok", durationMs: 5 },
					{ id: "root/2", name: "read", arguments: { path: "b" }, status: "error", durationMs: 8 },
				],
			},
		});
		expect(host.getSnapshot().nestedCalls).toHaveLength(2);
		expect(host.getSnapshot().nestedCalls?.[0]).toMatchObject({ args: { path: "a" }, phase: "complete", result });
		expect(host.getSnapshot().nestedCalls?.[1]).toMatchObject({
			parentToolCallId: "root",
			args: { path: "b" },
			phase: "complete",
			isError: true,
			durationMs: 8,
		});
		expect(host.getSnapshot().nestedCalls?.[1].result).toBeUndefined();
		host.dispose();
	});

	it("batches snapshots without creating duplicate member presentations", () => {
		const view = new ExecutionView("", 0, 0);
		const memberViews = new Set<ExecutionView>();
		const renderers: ToolRenderers = {
			renderExecution: () => {
				const member = new ExecutionView("member", 0, 0);
				memberViews.add(member);
				return member;
			},
			renderBatchExecution: (calls) => {
				view.setText(calls.map((call) => `${call.toolCallId}:${call.snapshot.phase}`).join("\n"));
				return view;
			},
		};
		const batch = new ToolExecutionBatchComponent("read", "a", {}, renderers, ui(), "/tmp");
		const first = batch.addCall("a", { path: "a" });
		const second = batch.addCall("b", { path: "b" });
		first.markExecutionStarted();
		second.setArgsComplete();
		expect(batch.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual(["", "a:running", "b:queued"]);
		first.updateResult(result);
		second.updateResult(result);
		expect(batch.getSnapshot().phase).toBe("complete");
		expect(memberViews.size).toBe(0);
		expect(batch.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual(["", "a:complete", "b:complete"]);
		batch.setExpanded(true);
		expect(view.expanded).toBe(true);
		expect(() => batch.addCall("a", {})).toThrow("unique");
		batch.dispose();
		expect(view.disposed).toBe(true);
	});

	it("exports full HTML or ANSI components and disposes export resources", () => {
		const view = new ExecutionView("<ANSI>", 0, 0);
		let useHtml = true;
		const renderers: ToolRenderers = {
			renderExecution: () => view,
			renderExecutionHtml: (snapshot, _theme, context) => {
				if (!useHtml) throw new Error("HTML unavailable");
				expect(snapshot.args).toEqual({ path: "a" });
				expect(snapshot.phase).toBe("complete");
				expect(context.resolveToolRenderers?.("custom")).toBe(renderers);
				return "<details><summary>custom</summary>done</details>";
			},
		};
		const renderer = createToolHtmlRenderer({ getToolRenderers: () => renderers, theme, cwd: "/tmp", width: 6 });
		expect(renderer.renderCall("a", "custom", { path: "a" })).toBeUndefined();
		expect(renderer.renderResult("a", "custom", result.content, undefined, false)).toEqual({
			expanded: "<details><summary>custom</summary>done</details>",
			execution: true,
		});
		useHtml = false;
		renderer.renderCall("b", "custom", {});
		expect(renderer.renderResult("b", "custom", result.content, undefined, false)).toEqual({
			expanded: '<div class="ansi-line">&lt;ANSI&gt;</div>',
			execution: true,
		});
		expect(view.disposed).toBe(true);
	});
});

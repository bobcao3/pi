import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";
import { formatToolCallWithArgs, getTextOutput } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

type DisposableComponent = Component & { dispose?: () => void };

export class LegacyToolExecutionView extends Container {
	private call?: DisposableComponent;
	private result?: DisposableComponent;
	private imageCache = new Map<string, Image>();

	update(
		name: string,
		renderers: ToolRenderers,
		result: AgentToolResult<unknown> | undefined,
		context: ToolRenderContext,
		toggle: () => void,
	): void {
		this.clear();
		const background = (text: string) =>
			theme.bg(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg", text);
		const shell = renderers.renderShell === "self" ? new Container() : new Box(context.outputPad, 1, background);
		const region = (component: Component) =>
			new MouseRegion(component, (event) => {
				if (!result || event.type !== "click" || event.button !== "left") return undefined;
				toggle();
				return { handled: true };
			});
		const previousCall = this.call;
		try {
			this.call = renderers.renderCall?.(context.args, theme, { ...context, lastComponent: this.call });
		} catch {
			this.call = undefined;
		}
		if (previousCall !== this.call) previousCall?.dispose?.();
		shell.addChild(
			region(this.call ?? new Text(formatToolCallWithArgs(name, context.args, theme, context.expanded), 0, 0)),
		);
		if (result) {
			const previousResult = this.result;
			try {
				this.result = renderers.renderResult?.(
					result,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					{ ...context, lastComponent: this.result },
				);
			} catch {
				this.result = undefined;
			}
			if (!this.result) {
				const lines = getTextOutput(result, context.showImages).split("\n");
				const preview = context.expanded ? lines : lines.slice(0, 10);
				const hidden = lines.length - preview.length;
				this.result = new Text(
					preview.map((line) => theme.fg("toolOutput", line)).join("\n") +
						(hidden
							? theme.fg("muted", `\n... (${hidden} more lines, `) +
								keyHint("app.tools.expand", "to expand") +
								theme.fg("muted", ")")
							: ""),
					0,
					0,
				);
			}
			if (previousResult !== this.result) previousResult?.dispose?.();
			shell.addChild(region(this.result));
		}
		this.addChild(shell);
		const retained = new Set<string>();
		if (context.showImages && getCapabilities().images) {
			for (const block of result?.content ?? []) {
				if (block.type !== "image") continue;
				const key = `${context.state.imageWidthCells ?? 60}\0${block.mimeType}\0${block.data}`;
				retained.add(key);
				let image = this.imageCache.get(key);
				if (!image) {
					image = new Image(
						block.data,
						block.mimeType,
						{ fallbackColor: (text) => theme.fg("toolOutput", text) },
						{ maxWidthCells: Number(context.state.imageWidthCells ?? 60) },
					);
					this.imageCache.set(key, image);
				}
				this.addChild(new Spacer(1));
				this.addChild(image);
			}
		}
		for (const key of this.imageCache.keys()) if (!retained.has(key)) this.imageCache.delete(key);
	}

	dispose(): void {
		for (const component of new Set([this.call, this.result])) component?.dispose?.();
		this.call = undefined;
		this.result = undefined;
		this.imageCache.clear();
		this.clear();
	}
}

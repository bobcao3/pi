import type { ImageContent, JsonValue, NestedToolCalls, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import {
	mergeToolExecutionNestedCalls,
	type ToolExecutionRenderContext,
	type ToolExecutionSnapshot,
} from "../tool-execution.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";
import type { ToolHtmlRenderer } from "./index.ts";

export interface ToolHtmlRendererDeps {
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	theme: Theme;
	cwd: string;
	width?: number;
}

type DisposableComponent = Component & { dispose?: () => void };

const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].replace(ANSI_ESCAPE_REGEX, "").trim().length === 0) start++;
	while (end > start && lines[end - 1].replace(ANSI_ESCAPE_REGEX, "").trim().length === 0) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;
	const callComponents = new Map<string, DisposableComponent>();
	const states = new Map<string, Record<string, unknown>>();
	const args = new Map<string, unknown>();

	const executionContext = (toolCallId: string, expanded: boolean): ToolExecutionRenderContext => {
		let state = states.get(toolCallId);
		if (!state) {
			state = {};
			states.set(toolCallId, state);
		}
		return {
			toolCallId,
			cwd,
			state,
			invalidate: () => {},
			expanded,
			showImages: false,
			imageWidthCells: 60,
			outputPad: 1,
			resolveToolRenderers: getToolRenderers,
		};
	};

	const legacyContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
		durationMs?: number,
	): ToolRenderContext => ({
		...executionContext(toolCallId, expanded),
		args: args.get(toolCallId),
		lastComponent,
		executionStarted: true,
		argsComplete: true,
		isPartial,
		isError,
		durationMs,
	});

	return {
		renderCall(toolCallId: string, toolName: string, callArgs: unknown): string | undefined {
			args.set(toolCallId, callArgs);
			try {
				const renderers = getToolRenderers(toolName);
				if (renderers?.renderExecution || renderers?.renderExecutionHtml || !renderers?.renderCall)
					return undefined;
				const previous = callComponents.get(toolCallId);
				const component = renderers.renderCall(
					callArgs,
					theme,
					legacyContext(toolCallId, previous, false, true, false),
				);
				if (previous !== component) previous?.dispose?.();
				callComponents.set(toolCallId, component);
				return ansiLinesToHtml(component.render(width));
			} catch {
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
			structuredContent?: JsonValue,
			durationMs?: number,
			nestedCalls?: NestedToolCalls,
		): { collapsed?: string; expanded?: string; execution?: boolean } | undefined {
			let component: DisposableComponent | undefined;
			try {
				const renderers = getToolRenderers(toolName);
				if (!renderers) return undefined;
				const agentResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
					structuredContent,
				};
				const snapshot: ToolExecutionSnapshot = {
					args: args.get(toolCallId) ?? {},
					result: agentResult,
					phase: "complete",
					isError,
					durationMs,
					nestedCalls: mergeToolExecutionNestedCalls([], nestedCalls),
				};
				const context = executionContext(toolCallId, true);
				if (renderers.renderExecutionHtml) {
					try {
						return { expanded: renderers.renderExecutionHtml(snapshot, theme, context), execution: true };
					} catch {
						// A terminal renderer can still export if its HTML callback fails.
					}
				}
				if (renderers.renderExecution) {
					component = renderers.renderExecution(snapshot, theme, context);
					return { expanded: ansiLinesToHtml(trimRenderedResultLines(component.render(width))), execution: true };
				}
				if (!renderers.renderResult) return undefined;
				component = renderers.renderResult(
					agentResult,
					{ expanded: false, isPartial: false },
					theme,
					legacyContext(toolCallId, undefined, false, false, isError, durationMs),
				);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(component.render(width)));
				const expandedComponent = renderers.renderResult(
					agentResult,
					{ expanded: true, isPartial: false },
					theme,
					legacyContext(toolCallId, component, true, false, isError, durationMs),
				);
				if (component !== expandedComponent) component.dispose?.();
				component = expandedComponent;
				const expanded = ansiLinesToHtml(trimRenderedResultLines(component.render(width)));
				return { ...(collapsed && collapsed !== expanded ? { collapsed } : {}), expanded };
			} catch {
				return undefined;
			} finally {
				component?.dispose?.();
				callComponents.get(toolCallId)?.dispose?.();
				callComponents.delete(toolCallId);
				states.delete(toolCallId);
				args.delete(toolCallId);
			}
		},
	};
}

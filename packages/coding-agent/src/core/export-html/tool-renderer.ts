/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */

import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import type { ToolTreeNode, TreeState } from "../tool-tree.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, as resolved by extensions and the registered tool */
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** Return true when the tool has a semantic tree renderer. */
	hasTreeRenderer(toolName: string): boolean;
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
		structuredContent?: JsonValue,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

function renderTreeNodeHtml(node: ToolTreeNode): string {
	const metadata = node.metadata?.length
		? `<span class="tool-tree-metadata">${node.metadata.map((value) => escapeHtml(value)).join(" · ")}</span>`
		: "";
	const summary = node.summary ? `<span class="tool-tree-summary">${escapeHtml(node.summary)}</span>` : "";
	const body = node.content
		? renderTreeContentHtml(node.content.text, node.content.format, node.content.language)
		: "";
	const children = node.children?.length ? node.children.map((child) => renderTreeNodeHtml(child)).join("") : "";
	const status = node.status ? ` tool-tree-status-${escapeHtml(node.status)}` : "";
	return `<details class="tool-tree-node${status}"${node.defaultOpen ? " open" : ""}><summary><span class="tool-tree-label">${escapeHtml(node.label)}</span>${summary}${metadata}</summary>${body}${children}</details>`;
}

function renderTreeContentHtml(text: string, format = "text", language?: string): string {
	const lang = language ? ` class="language-${escapeHtml(language)}"` : "";
	if (format === "markdown") return `<div class="tool-tree-content markdown">${escapeHtml(text)}</div>`;
	if (format === "code") return `<pre class="tool-tree-content"><code${lang}>${escapeHtml(text)}</code></pre>`;
	return `<pre class="tool-tree-content">${escapeHtml(text)}</pre>`;
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedTreeStates = new Map<string, TreeState>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
			durationMs: undefined,
			outputPad: 1,
		};
	};

	const getTreeState = (toolCallId: string): TreeState => {
		let state = renderedTreeStates.get(toolCallId);
		if (!state) {
			state = { open: new Map(), shownChildren: new Map() };
			renderedTreeStates.set(toolCallId, state);
		}
		return state;
	};

	const renderTreeHtml = (
		toolCallId: string,
		toolDef: ToolRenderers,
		result:
			| {
					content: (TextContent | ImageContent)[];
					details: unknown;
					isError: boolean;
					structuredContent?: JsonValue;
			  }
			| undefined,
		durationMs: number | undefined,
	): string | undefined => {
		if (!toolDef.renderTree) return undefined;
		const roots = toolDef.renderTree(
			{
				args: (renderedArgs.get(toolCallId) ?? {}) as Partial<unknown>,
				result,
				phase: result ? "complete" : "arguments",
				isError: result?.isError ?? false,
				...(durationMs === undefined ? {} : { durationMs }),
			},
			theme,
			{
				toolCallId,
				cwd,
				state: getState(toolCallId),
				viewState: getTreeState(toolCallId),
				invalidate: () => {},
			},
		);
		return `<div class="tool-tree">${roots.map((node) => renderTreeNodeHtml(node)).join("")}</div>`;
	};

	return {
		hasTreeRenderer(toolName: string): boolean {
			return !!getToolRenderers(toolName)?.renderTree;
		},

		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolRenderers(toolName);
				if (toolDef?.renderTree) return undefined;
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
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
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderResult && !toolDef?.renderTree) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
					structuredContent,
				};
				const treeHtml = renderTreeHtml(toolCallId, toolDef, agentToolResult, undefined);
				if (treeHtml) return { expanded: treeHtml };
				if (!toolDef.renderResult) return undefined;

				// Render collapsed
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// Render expanded
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				return undefined;
			}
		},
	};
}

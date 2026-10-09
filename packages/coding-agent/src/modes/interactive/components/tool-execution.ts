import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, NestedToolCalls, TextContent } from "@earendil-works/pi-ai";
import { type Component, Container, dispatchMouseEvent, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";
import type { NestedToolExecutionEvent } from "../../../core/nested-tool-calls.ts";
import {
	mergeToolExecutionNestedCalls,
	type ToolExecutionNestedCall,
	type ToolExecutionRenderContext,
	type ToolExecutionSnapshot,
} from "../../../core/tool-execution.ts";
import { ensurePngTranscoder } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { LegacyToolExecutionView } from "./tool-execution-legacy.ts";

export type { ToolRenderers };

type ExecutionComponent = Component & {
	setExpanded?: (expanded: boolean, force?: boolean) => void;
	dispose?: () => void;
};

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
	resolveToolRenderers?: (name: string) => ToolRenderers | undefined;
	onChanged?: (component: ToolExecutionComponent) => void;
}

interface DisplayResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError: boolean;
	durationMs?: number;
	structuredContent?: JsonValue;
	nestedCalls?: NestedToolCalls;
}

export class ToolExecutionComponent extends Container {
	private readonly toolName: string;
	private readonly toolCallId: string;
	private args: unknown;
	private readonly toolDefinition?: ToolRenderers;
	private readonly ui: TUI;
	private readonly cwd: string;
	private readonly options: ToolExecutionOptions;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private outputPad: number;
	private isPartial = true;
	private executionStarted = false;
	private argsComplete = false;
	private result?: DisplayResult;
	private executionComponent?: ExecutionComponent;
	private readonly legacy = new LegacyToolExecutionView();
	private readonly rendererState: Record<string, unknown> = {};
	private readonly nested = new Map<string, ToolExecutionNestedCall>();
	private disposed = false;
	private updating = false;
	private startedAt?: number;

	constructor(
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.options = options;
		this.toolDefinition = toolDefinition;
		this.ui = ui;
		this.cwd = cwd;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.outputPad = Math.max(0, Math.floor(options.outputPad ?? 1));
		this.updateDisplay();
	}

	getToolCallId(): string {
		return this.toolCallId;
	}
	getToolName(): string {
		return this.toolName;
	}

	getSnapshot(): ToolExecutionSnapshot {
		return {
			args: this.args,
			result: this.result ? this.agentResult(this.result) : undefined,
			phase:
				this.result && !this.isPartial
					? "complete"
					: this.executionStarted
						? "running"
						: this.argsComplete
							? "queued"
							: "arguments",
			isError: this.result?.isError ?? false,
			durationMs: !this.isPartial
				? this.result?.durationMs
				: this.startedAt === undefined
					? undefined
					: Date.now() - this.startedAt,
			nestedCalls: mergeToolExecutionNestedCalls([...this.nested.values()], this.result?.nestedCalls),
		};
	}

	private agentResult(result: DisplayResult): AgentToolResult<unknown> {
		return {
			content: result.content as (TextContent | ImageContent)[],
			details: result.details,
			structuredContent: result.structuredContent,
			isError: result.isError,
		};
	}

	private executionContext(): ToolExecutionRenderContext {
		return {
			toolCallId: this.toolCallId,
			cwd: this.cwd,
			state: this.rendererState,
			invalidate: () => this.refresh(),
			lastComponent: this.executionComponent,
			expanded: this.expanded,
			showImages: this.showImages,
			imageWidthCells: this.imageWidthCells,
			outputPad: this.outputPad,
			resolveToolRenderers: this.options.resolveToolRenderers,
		};
	}

	private renderContext(): ToolRenderContext {
		return {
			...this.executionContext(),
			args: this.args,
			lastComponent: undefined,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			isError: this.result?.isError ?? false,
			durationMs: this.isPartial ? undefined : this.result?.durationMs,
		};
	}

	updateArgs(args: unknown): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.startedAt ??= Date.now();
		this.rendererState.startedAt ??= this.startedAt;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: DisplayResult, isPartial = false): void {
		this.result =
			!isPartial && result.durationMs === undefined && this.startedAt !== undefined
				? { ...result, durationMs: Date.now() - this.startedAt }
				: result;
		this.isPartial = isPartial;
		if (!isPartial) this.rendererState.endedAt ??= Date.now();
		this.updateDisplay();
	}

	updateNestedEvent(event: NestedToolExecutionEvent): void {
		const previous = this.nested.get(event.toolCallId);
		if (!previous && this.nested.size >= 256) return;
		this.nested.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			parentToolCallId: event.parentToolCallId,
			toolName: event.toolName,
			args: event.type === "tool_execution_end" ? (previous?.args ?? {}) : event.args,
			phase: event.type === "tool_execution_end" ? "complete" : "running",
			isError: event.type === "tool_execution_end" ? event.isError : false,
			result:
				event.type === "tool_execution_end"
					? event.result
					: event.type === "tool_execution_update"
						? event.partialResult
						: previous?.result,
			durationMs: event.type === "tool_execution_end" ? event.durationMs : undefined,
		});
		this.refresh();
	}

	setExpanded(expanded: boolean, force = false): void {
		if (!force && this.expanded === expanded) return;
		this.expanded = expanded;
		this.executionComponent?.setExpanded?.(expanded, force);
		this.updateDisplay();
	}
	setOutputPad(padding: number): void {
		this.outputPad = Math.max(0, Math.floor(padding));
		this.updateDisplay();
	}
	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}
	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.executionComponent?.invalidate();
		this.legacy.invalidate();
		this.updateDisplay();
	}

	private refresh(): void {
		if (this.disposed) return;
		this.invalidate();
		this.ui.requestRender();
	}

	private updateDisplay(): void {
		if (this.disposed || this.updating) return;
		this.updating = true;
		try {
			let next: ExecutionComponent | undefined;
			try {
				next = this.toolDefinition?.renderExecution?.(this.getSnapshot(), theme, this.executionContext());
			} catch {
				next = undefined;
			}
			if (this.executionComponent !== next) {
				if (next && !this.executionComponent) this.legacy.dispose();
				this.executionComponent?.dispose?.();
				this.executionComponent = next;
				if (this.expanded) next?.setExpanded?.(true);
			}
			if (!next) {
				this.rendererState.imageWidthCells = this.imageWidthCells;
				this.legacy.update(
					this.toolName,
					this.toolDefinition ?? {},
					this.result ? this.agentResult(this.result) : undefined,
					this.renderContext(),
					() => this.setExpanded(!this.expanded),
				);
				const images = this.result?.content.some(
					(block) => block.type === "image" && block.mimeType !== "image/png",
				);
				if (images && this.showImages) ensurePngTranscoder(() => this.refresh());
			}
			this.options.onChanged?.(this);
		} finally {
			this.updating = false;
		}
	}

	override render(width: number): string[] {
		const lines = (this.executionComponent ?? this.legacy).render(width);
		return lines.length ? ["", ...lines] : [];
	}
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.y < 1) return undefined;
		return dispatchMouseEvent(this.executionComponent ?? this.legacy, {
			...event,
			y: event.y - 1,
			height: Math.max(0, event.height - 1),
		});
	}
	handleInput(data: string): void {
		this.executionComponent?.handleInput?.(data);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.executionComponent?.dispose?.();
		this.legacy.dispose();
		this.nested.clear();
	}
}

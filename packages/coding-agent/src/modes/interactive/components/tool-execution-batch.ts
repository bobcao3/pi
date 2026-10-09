import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "../../../core/extensions/types.ts";
import { MAX_TOOL_EXECUTION_BATCH_CALLS } from "../../../core/tool-execution.ts";
import { ToolExecutionComponent, type ToolExecutionOptions } from "./tool-execution.ts";

const emptyComponent: Component = { render: () => [], invalidate: () => {} };

interface BatchLifecycle {
	ready: boolean;
	reconciling: boolean;
	disposed: boolean;
}

export class ToolExecutionBatchComponent extends ToolExecutionComponent {
	private readonly members: Map<string, ToolExecutionComponent>;
	private readonly lifecycle: BatchLifecycle;
	private readonly memberOptions: ToolExecutionOptions;
	private readonly batchRenderer: NonNullable<ToolRenderers["renderBatchExecution"]>;
	private readonly memberUi: TUI;
	private readonly memberCwd: string;
	private readonly notifyChanged?: ToolExecutionOptions["onChanged"];

	constructor(
		toolName: string,
		firstCallId: string,
		options: ToolExecutionOptions,
		renderers: ToolRenderers,
		ui: TUI,
		cwd: string,
	) {
		const renderBatchExecution = renderers.renderBatchExecution;
		if (!renderBatchExecution) throw new Error("Tool batches require a batch renderer");
		const members = new Map<string, ToolExecutionComponent>();
		const lifecycle: BatchLifecycle = { ready: false, reconciling: false, disposed: false };
		super(
			toolName,
			`${firstCallId}/batch`,
			{},
			{
				...options,
				onChanged: (component) => {
					if (lifecycle.ready && !lifecycle.reconciling && !lifecycle.disposed) options.onChanged?.(component);
				},
			},
			{
				renderExecution: (_snapshot, theme, context) => {
					if (!members.size) return emptyComponent;
					return renderBatchExecution(
						[...members].map(([toolCallId, member]) => ({ toolCallId, snapshot: member.getSnapshot() })),
						theme,
						context,
					);
				},
			} satisfies ToolRenderers,
			ui,
			cwd,
		);
		this.members = members;
		this.lifecycle = lifecycle;
		this.memberOptions = options;
		this.batchRenderer = renderBatchExecution;
		this.memberUi = ui;
		this.memberCwd = cwd;
		this.notifyChanged = options.onChanged;
		lifecycle.ready = true;
	}

	addCall(toolCallId: string, args: unknown): ToolExecutionComponent {
		if (this.lifecycle.disposed) throw new Error("Cannot add a call to a disposed tool batch");
		if (!toolCallId || this.members.has(toolCallId))
			throw new Error("Tool batch call IDs must be unique and nonempty");
		if (this.members.size >= MAX_TOOL_EXECUTION_BATCH_CALLS)
			throw new Error(`Tool batches cannot exceed ${MAX_TOOL_EXECUTION_BATCH_CALLS} calls`);
		const member = new ToolExecutionComponent(
			this.getToolName(),
			toolCallId,
			args,
			{
				...this.memberOptions,
				onChanged: (changed) => {
					if (this.lifecycle.ready && this.members.get(toolCallId) === changed) this.reconcile();
				},
			},
			{ renderExecution: () => emptyComponent },
			this.memberUi,
			this.memberCwd,
		);
		this.members.set(toolCallId, member);
		this.reconcile();
		return member;
	}

	getCall(toolCallId: string): ToolExecutionComponent | undefined {
		return this.members.get(toolCallId);
	}
	getMemberCount(): number {
		return this.members.size;
	}
	getBatchRenderer(): NonNullable<ToolRenderers["renderBatchExecution"]> {
		return this.batchRenderer;
	}

	private reconcile(): void {
		if (this.lifecycle.disposed || this.lifecycle.reconciling || !this.lifecycle.ready) return;
		this.lifecycle.reconciling = true;
		try {
			let complete = true;
			let isError = false;
			let running = false;
			for (const member of this.members.values()) {
				const snapshot = member.getSnapshot();
				complete &&= snapshot.phase === "complete";
				isError ||= snapshot.isError;
				running ||= snapshot.phase === "running";
			}
			if (running) super.markExecutionStarted();
			super.updateResult({ content: [], details: undefined, isError }, !complete);
		} finally {
			this.lifecycle.reconciling = false;
		}
		this.notifyChanged?.(this);
		this.memberUi.requestRender();
	}

	override dispose(): void {
		if (this.lifecycle.disposed) return;
		this.lifecycle.disposed = true;
		this.lifecycle.ready = false;
		for (const member of this.members.values()) member.dispose();
		this.members.clear();
		super.dispose();
	}
}

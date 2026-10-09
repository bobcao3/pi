import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { NestedToolCalls } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolRenderers } from "./extensions/types.ts";

export interface ToolExecutionNestedCall {
	toolCallId: string;
	parentToolCallId?: string;
	toolName: string;
	args: unknown;
	phase: "arguments" | "queued" | "running" | "complete";
	isError: boolean;
	result?: AgentToolResult<unknown>;
	durationMs?: number;
}

export interface ToolExecutionSnapshot<TArgs = unknown, TDetails = unknown> {
	args: Partial<TArgs> | TArgs;
	result?: AgentToolResult<TDetails>;
	phase: ToolExecutionNestedCall["phase"];
	isError: boolean;
	durationMs?: number;
	nestedCalls?: readonly ToolExecutionNestedCall[];
}

export interface ToolExecutionBatchCall {
	toolCallId: string;
	snapshot: ToolExecutionSnapshot;
}

export interface ToolExecutionRenderContext<TState = Record<string, unknown>> {
	toolCallId: string;
	cwd: string;
	state: TState;
	invalidate: () => void;
	expanded: boolean;
	showImages: boolean;
	imageWidthCells: number;
	outputPad: number;
	resolveToolRenderers?: (name: string) => ToolRenderers | undefined;
	lastComponent?: Component;
}

export const MAX_TOOL_EXECUTION_BATCH_CALLS = 64;

export function mergeToolExecutionNestedCalls(
	live: readonly ToolExecutionNestedCall[] = [],
	stored?: NestedToolCalls,
): readonly ToolExecutionNestedCall[] {
	const merged = new Map(live.slice(0, 256).map((call) => [call.toolCallId, call]));
	for (const call of stored?.calls.slice(0, 256) ?? []) {
		const existing = merged.get(call.id);
		merged.set(call.id, {
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments ?? {},
			parentToolCallId: call.id.includes("/") ? call.id.slice(0, call.id.lastIndexOf("/")) : undefined,
			phase: "complete",
			isError: call.status === "error",
			durationMs: call.durationMs,
			...existing,
		});
	}
	return [...merged.values()].slice(0, 256);
}

import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";
import type { TreeNode, TreeStatus, TreeViewTheme } from "./tree-view.ts";

export interface FlatNode {
	node: TreeNode;
	depth: number;
	ancestorLast: boolean[];
	childIndex: number;
	childCount: number;
	parentId?: string;
}

export type RowKind = "header" | "body" | "more";

export interface HitRow {
	kind: RowKind;
	id: string;
	y: number;
	markerStart: number;
	markerEnd: number;
	body?: Component;
	bodyY?: number;
	bodyWidth?: number;
	bodyHeight?: number;
}

export const MAX_NODES = 2000;
export const MAX_DEPTH = 48;
export const MAX_ROWS = 4000;
export const CHILD_PAGE = 200;
export const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const STATUS_TEXT: Record<TreeStatus, string> = {
	queued: "◌",
	running: RUNNING_FRAMES[0]!,
	success: "✓",
	warning: "!",
	error: "×",
	cancelled: "⊘",
	paused: "Ⅱ",
	detached: "↗",
};

export const emptyTheme: Required<TreeViewTheme> = {
	guide: (text) => text,
	status: (text) => text,
	selected: (text) => text,
};

export function fit(line: string, width: number): string {
	return truncateToWidth(line, width, "");
}

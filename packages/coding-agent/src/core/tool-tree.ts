import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Component,
	Markdown,
	Text,
	type TreeNode,
	type TreeState,
	type TreeStatus,
	TreeView,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, highlightCode, type Theme } from "../modes/interactive/theme/theme.ts";

export type { TreeState, TreeStatus };

export interface ToolTreeContent {
	text: string;
	format?: "text" | "code" | "markdown";
	language?: string;
}

export interface ToolTreeNode {
	id: string;
	label: string;
	summary?: string;
	metadata?: readonly string[];
	status?: TreeStatus;
	children?: readonly ToolTreeNode[];
	content?: ToolTreeContent;
	defaultOpen?: boolean;
}

export interface ToolTreeSnapshot<TArgs = unknown, TDetails = unknown> {
	args: Partial<TArgs>;
	result?: AgentToolResult<TDetails>;
	phase: "arguments" | "queued" | "running" | "complete";
	isError: boolean;
	durationMs?: number;
}

export interface ToolTreeContext<TState = Record<string, unknown>> {
	toolCallId: string;
	cwd: string;
	state: TState;
	viewState: TreeState;
	invalidate: () => void;
}

interface ToolTreeComponentOptions {
	state?: Partial<TreeState>;
	invalidate?: () => void;
	padding?: number;
	onCancel?: () => void;
}

type BodyCacheEntry = { key: string; body: Component };

const MAX_NODES = 2000;
const MAX_DEPTH = 48;
const MAX_TEXT = 200_000;

export function createTreeState(state?: Partial<TreeState>): TreeState {
	return {
		open: state?.open ?? new Map(),
		shownChildren: state?.shownChildren ?? new Map(),
		...(state?.selectedId ? { selectedId: state.selectedId } : {}),
	};
}

export class ToolTreeComponent implements Component {
	private roots: readonly ToolTreeNode[];
	private theme: Theme;
	private readonly viewState: TreeState;
	private readonly invalidateHost?: () => void;
	private padding: number;
	private readonly bodyCache = new Map<string, BodyCacheEntry>();
	private tree: TreeView;

	constructor(roots: readonly ToolTreeNode[], theme: Theme, options: ToolTreeComponentOptions = {}) {
		this.roots = roots;
		this.theme = theme;
		this.viewState = createTreeState(options.state);
		this.invalidateHost = options.invalidate;
		this.padding = Math.max(0, Math.floor(options.padding ?? 1));
		this.tree = this.createTree(options.onCancel);
	}

	update(roots: readonly ToolTreeNode[], theme: Theme): void {
		this.roots = roots;
		if (this.theme !== theme) this.bodyCache.clear();
		this.theme = theme;
		this.tree = this.createTree(undefined);
	}

	setExpanded(expanded: boolean): void {
		this.tree.setExpanded(expanded);
	}

	setPadding(padding: number): void {
		const next = Math.max(0, Math.floor(padding));
		if (this.padding === next) return;
		this.padding = next;
		this.invalidate();
	}

	getState(): TreeState {
		return this.viewState;
	}

	getNodes(): readonly ToolTreeNode[] {
		return this.roots;
	}

	setFrame(frame: number): void {
		this.tree.setFrame(frame);
	}

	getRowPosition(id: string): number | undefined {
		const row = this.tree.getRowPosition(id);
		return row === undefined ? undefined : row + this.padding;
	}

	getSelectedId(): string | undefined {
		return this.tree.getSelectedId();
	}

	render(width: number): string[] {
		const lines = this.tree.render(Math.max(0, width - this.padding));
		if (this.padding === 0) return lines;
		const prefix = " ".repeat(this.padding);
		return lines.map((line: string) => prefix + line);
	}

	handleInput(data: string): void {
		this.tree.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.x < this.padding) return undefined;
		return this.tree.handleMouse({
			...event,
			x: event.x - this.padding,
			width: Math.max(0, event.width - this.padding),
		});
	}

	invalidate(): void {
		this.tree.invalidate();
		this.invalidateHost?.();
	}

	private createTree(onCancel: (() => void) | undefined): TreeView {
		return new TreeView(this.project(), {
			state: this.viewState,
			onCancel,
			requestRender: this.invalidateHost,
			theme: {
				guide: (text: string) => this.theme.fg("borderMuted", text),
				status: (text: string, status: TreeStatus) => this.styleStatus(text, status),
				selected: (text: string) => this.theme.bg("selectedBg", text),
			},
		});
	}

	private styleStatus(text: string, status: TreeStatus): string {
		if (status === "success") return this.theme.fg("success", text);
		if (status === "warning") return this.theme.fg("warning", text);
		if (status === "error" || status === "cancelled") return this.theme.fg("error", text);
		if (status === "running") return this.theme.fg("accent", text);
		return this.theme.fg("muted", text);
	}

	private project(): readonly TreeNode[] {
		const projected: TreeNode[] = [];
		const stack = this.roots.map((node, index) => ({ node, out: projected, index, depth: 0 })).reverse();
		let count = 0;
		while (stack.length > 0 && count < MAX_NODES) {
			const item = stack.pop()!;
			if (item.depth > MAX_DEPTH) continue;
			const node = this.sanitizeNode(item.node);
			item.out[item.index] = node;
			count++;
			const children = item.node.children ?? [];
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				if (child) stack.push({ node: child, out: node.children as TreeNode[], index: i, depth: item.depth + 1 });
			}
		}
		return projected.filter(Boolean);
	}

	private sanitizeNode(node: ToolTreeNode): TreeNode {
		const children: TreeNode[] = [];
		return {
			id: this.sanitizeText(node.id),
			label: this.sanitizeText(node.label),
			summary: node.summary === undefined ? undefined : this.sanitizeText(node.summary),
			metadata: node.metadata?.map((value: string) => this.sanitizeText(value)),
			status: node.status,
			children,
			body: node.content ? this.bodyFor(node.id, node.content) : undefined,
			defaultOpen: node.defaultOpen,
		};
	}

	private sanitizeText(text: string): string {
		return String(text)
			.slice(0, MAX_TEXT)
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	}

	private bodyFor(id: string, content: ToolTreeContent): Component {
		const text = this.sanitizeText(content.text);
		const format = content.format ?? "text";
		const key = `${format}\0${content.language ?? ""}\0${text}\0${this.theme.name ?? ""}`;
		const cached = this.bodyCache.get(id);
		if (cached?.key === key) return cached.body;
		const body = this.createBody(text, format, content.language);
		this.bodyCache.set(id, { key, body });
		return body;
	}

	private createBody(text: string, format: ToolTreeContent["format"], language: string | undefined): Component {
		if (format === "markdown") return new Markdown(text, 0, 0, getMarkdownTheme());
		if (format === "code") return new Text(highlightCode(text, language).join("\n"), 0, 0);
		return new Text(this.theme.fg("toolOutput", text), 0, 0);
	}
}
